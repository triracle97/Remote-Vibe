import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z, type ZodRawShape } from 'zod';
import { isEffortLevel, isValidModelId } from './models.js';
import type { AgentKind } from './types.js';

/**
 * An MCP surface so a running agent can start another agent.
 *
 * Why a tool and not another `mrt:` directive: the directive channel in
 * `agent-directives.ts` acts on a text pattern, and the worst a stray pattern
 * can do today is move a Kanban card. Spawning a process is a different
 * magnitude — Codex launches with `--dangerously-bypass-approvals-and-sandbox`
 * — and a pattern the agent might echo from a file it read or a page it fetched
 * is too weak a trigger for that. A tool call has to be chosen by the model,
 * lands in the transcript as a visible call, and carries structured arguments,
 * which a `<!-- -->` comment cannot (a `>` in the prompt would end the marker).
 *
 * Transport is Streamable HTTP against the bridge's own server rather than a
 * stdio child: the tool has to reach the live `SessionManager`, which is in
 * this process. A stdio server would be a second process that then needs its
 * own channel back here.
 *
 * The caller identifies itself with `x-mrt-session`, baked into the per-session
 * config file the bridge writes at spawn time. The agent never sees or sets it.
 */

/** Ceiling on children per parent, so a loop cannot fill the machine. */
const MAX_CHILDREN_PER_PARENT = 5;

export interface SpawnedSessionInfo {
  sessionId: string;
}

export interface McpDeps {
  /** Spawn a session. Mirrors `SessionManager.spawnSession`. */
  spawnSession(opts: {
    agent: AgentKind;
    dirs: string[];
    account?: string;
    model?: string;
    effort?: string;
    parentSessionId?: string;
  }): Promise<SpawnedSessionInfo>;
  /** Deliver the opening prompt once the session exists. */
  sendUserText(sessionId: string, text: string): void;
  /** Registry lookup for the calling session; undefined if it is unknown. */
  lookupSession(sessionId: string):
    | { projectPath: string; parentSessionId: string | null; name: string | null }
    | undefined;
  /** How many sessions already name `parentSessionId` as their parent. */
  countChildren(parentSessionId: string): number;
}

export class McpToolError extends Error {}

/**
 * Run one `spawn_session` call.
 *
 * Exported separately from the transport so the rules below are testable
 * without standing up an HTTP server and an MCP handshake.
 */
export async function spawnSessionTool(
  deps: McpDeps,
  callerSessionId: string | null,
  args: {
    agent: AgentKind;
    prompt: string;
    projectPath?: string | undefined;
    model?: string | undefined;
    effort?: string | undefined;
  },
): Promise<{ sessionId: string; agent: AgentKind; projectPath: string }> {
  if (!callerSessionId) {
    throw new McpToolError('this tool is only callable from inside a bridge session');
  }
  const caller = deps.lookupSession(callerSessionId);
  if (!caller) {
    throw new McpToolError(`unknown calling session ${callerSessionId}`);
  }

  // Depth 1 only. A spawned agent that can spawn is a fork bomb with a
  // language model deciding the branching factor, and nothing in the product
  // needs grandchildren.
  if (caller.parentSessionId !== null) {
    throw new McpToolError(
      'this session was itself spawned by another agent, and nested spawning is not allowed',
    );
  }

  const existing = deps.countChildren(callerSessionId);
  if (existing >= MAX_CHILDREN_PER_PARENT) {
    throw new McpToolError(
      `already spawned ${existing} sessions (limit ${MAX_CHILDREN_PER_PARENT}); ` +
        'stop one before starting another',
    );
  }

  const prompt = args.prompt.trim();
  if (prompt.length === 0) {
    throw new McpToolError('prompt is required — the spawned agent needs something to do');
  }

  // Default to the caller's own directory. An explicit path still goes through
  // `spawnSession`, which resolves it against BRIDGE_ALLOWED_DIRS, so this is a
  // convenience rather than the security boundary.
  const projectPath = args.projectPath?.trim() || caller.projectPath;

  if (args.model !== undefined && !isValidModelId(args.model)) {
    throw new McpToolError(`unknown model id: ${args.model}`);
  }
  if (args.effort !== undefined && !isEffortLevel(args.effort)) {
    throw new McpToolError(`unknown effort level: ${args.effort}`);
  }

  const info = await deps.spawnSession({
    agent: args.agent,
    dirs: [projectPath],
    // Codex always uses the default account here. The synthesized `default`
    // entry is guaranteed to exist (see accounts.ts), and picking between named
    // accounts is a human decision, not one to hand to an agent.
    ...(args.agent === 'codex' ? { account: 'default' } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.effort !== undefined ? { effort: args.effort } : {}),
    parentSessionId: callerSessionId,
  });

  deps.sendUserText(info.sessionId, prompt);

  return { sessionId: info.sessionId, agent: args.agent, projectPath };
}

const SPAWN_DESCRIPTION = [
  'Start a second agent session that works in parallel with you, and give it an',
  'opening prompt. Use it to hand off a self-contained piece of work — porting a',
  'suite of tests, a wide mechanical refactor, an independent investigation —',
  'not for something you could just do inline.',
  'The spawned session appears on the same Kanban board as you, labelled with',
  'its agent and linked back to this session. It does not report back: you get',
  'its session id, and the human watches it.',
  'It runs in your project directory unless you say otherwise, and it cannot',
  'spawn further sessions.',
].join(' ');

/**
 * Tool arguments.
 *
 * The shape is annotated as a plain `ZodRawShape` rather than left to
 * inference: `registerTool`'s generics otherwise recurse deep enough to trip
 * TS2589 on this many optional fields. The cost is that the callback receives
 * untyped args, which `spawnSessionTool` re-validates anyway.
 */
const SPAWN_INPUT_SCHEMA: ZodRawShape = {
  agent: z
    .enum(['codex', 'claude'])
    .describe('Which CLI to launch. Prefer codex for well-specified mechanical work.'),
  prompt: z.string().describe('The opening prompt. Self-contained: it cannot ask you for context.'),
  projectPath: z
    .string()
    .optional()
    .describe("Absolute working directory. Defaults to this session's own project."),
  model: z.string().optional().describe('Model id. Omit to use the bridge default.'),
  effort: z
    .string()
    .optional()
    .describe('Reasoning effort: low | medium | high. Omit to use the bridge default.'),
};

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface SpawnToolArgs {
  agent: AgentKind;
  prompt: string;
  projectPath?: string;
  model?: string;
  effort?: string;
}

/** Build the MCP server for one request. */
function buildServer(deps: McpDeps, callerSessionId: string | null): McpServer {
  const server = new McpServer(
    { name: 'mac-remote-terminal', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // `registerTool` is generic over the zod shape, and inferring through it
  // recurses deep enough to trip TS2589 regardless of how the shape is
  // annotated. Binding it to a concrete signature severs the generic chain;
  // the runtime call is unchanged, and `spawnSessionTool` validates the args
  // itself rather than trusting inference.
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { title?: string; description?: string; inputSchema?: ZodRawShape },
    cb: (args: Record<string, unknown>) => Promise<ToolResult>,
  ) => void;

  registerTool(
    'spawn_session',
    {
      title: 'Spawn an agent session',
      description: SPAWN_DESCRIPTION,
      inputSchema: SPAWN_INPUT_SCHEMA,
    },
    async (raw: Record<string, unknown>) => {
      const args = raw as unknown as SpawnToolArgs;
      try {
        const out = await spawnSessionTool(deps, callerSessionId, {
          agent: args.agent,
          prompt: args.prompt,
          projectPath: args.projectPath,
          model: args.model,
          effort: args.effort,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Spawned a ${out.agent} session in ${out.projectPath}.\n` +
                `sessionId: ${out.sessionId}\n` +
                'It is running now and will not report back to you.',
            },
          ],
        };
      } catch (err) {
        // Surfaced to the model as a tool error so it can adjust, rather than
        // as a transport failure that reads like the bridge is broken.
        return {
          isError: true,
          content: [{ type: 'text' as const, text: (err as Error).message }],
        };
      }
    },
  );

  return server;
}

/**
 * Handle one POST to `/mcp`.
 *
 * Stateless: a fresh server and transport per request, no `Mcp-Session-Id`.
 * The bridge already has exactly one long-lived client per agent process and no
 * server-initiated notifications to deliver, so per-request setup costs nothing
 * and removes a whole class of session-expiry bugs.
 */
export async function handleMcpRequest(
  deps: McpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const header = req.headers['x-mrt-session'];
  const callerSessionId = (Array.isArray(header) ? header[0] : header) ?? null;

  const server = buildServer(deps, callerSessionId);
  // No `sessionIdGenerator` means stateless — no `Mcp-Session-Id` issued and
  // none validated. Written as an empty options object rather than an explicit
  // `sessionIdGenerator: undefined` because `exactOptionalPropertyTypes` in
  // this package rejects passing undefined for an optional property; the
  // runtime behaviour is identical.
  const transport = new StreamableHTTPServerTransport({});

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  // The SDK's Transport interface declares optional members without `|
  // undefined`, which `exactOptionalPropertyTypes` reads as incompatible. The
  // shapes match at runtime; this cast is purely to bridge that setting.
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
  await transport.handleRequest(req, res, body);
}
