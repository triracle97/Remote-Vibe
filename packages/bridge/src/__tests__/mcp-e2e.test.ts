import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpHandler } from '../http-server.js';
import { handleMcpRequest, type McpDeps } from '../mcp-server.js';

/**
 * Drives the real MCP client against the real route, so the handshake, tool
 * discovery and argument marshalling are exercised end to end. The unit tests
 * in mcp-server.test.ts cover the spawn rules; this covers the wiring those
 * rules hang off.
 */

const TOKEN = 'a'.repeat(32);

let open: Server[] = [];
afterEach(async () => {
  for (const s of open) await new Promise<void>((r) => s.close(() => r()));
  open = [];
});

function startBridge(deps: McpDeps): Promise<string> {
  const staticDir = mkdtempSync(join(tmpdir(), 'mcp-e2e-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><body>app</body>');
  const dataDir = mkdtempSync(join(tmpdir(), 'mcp-e2e-data-'));
  mkdirSync(join(dataDir, 'transcripts'), { recursive: true });

  const server = createServer(
    createHttpHandler({
      token: TOKEN,
      staticDir,
      dataDir,
      mcp: (req, res, body) => handleMcpRequest(deps, req, res, body),
    }),
  );
  open.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no addr');
      resolve(`http://127.0.0.1:${addr.port}/mcp`);
    });
  });
}

async function connect(url: string, sessionId: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'x-mrt-session': sessionId,
      },
    },
  });
  await client.connect(transport as never);
  return client;
}

function makeDeps(): McpDeps & { spawned: Array<Record<string, unknown>>; prompts: string[] } {
  const spawned: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  return {
    spawned,
    prompts,
    spawnSession: async (o) => {
      spawned.push({ ...o });
      return { sessionId: 'child-1' };
    },
    sendUserText: (_id, text) => {
      prompts.push(text);
    },
    lookupSession: (id) =>
      id === 'parent'
        ? { projectPath: '/Users/me/proj', parentSessionId: null, name: 'Parent' }
        : undefined,
    countChildren: () => 0,
  };
}

describe('MCP end to end', () => {
  it('advertises spawn_session to a real client', async () => {
    const deps = makeDeps();
    const client = await connect(await startBridge(deps), 'parent');

    const { tools } = await client.listTools();
    const spawn = tools.find((t) => t.name === 'spawn_session');
    expect(spawn).toBeDefined();
    expect(spawn!.inputSchema).toMatchObject({
      properties: {
        agent: expect.anything(),
        prompt: expect.anything(),
      },
    });
    await client.close();
  });

  it('spawns a codex session through a tool call', async () => {
    const deps = makeDeps();
    const client = await connect(await startBridge(deps), 'parent');

    const result = await client.callTool({
      name: 'spawn_session',
      arguments: { agent: 'codex', prompt: 'port the parser tests' },
    });

    expect(result.isError).toBeFalsy();
    expect(deps.spawned).toHaveLength(1);
    expect(deps.spawned[0]).toMatchObject({
      agent: 'codex',
      account: 'default',
      dirs: ['/Users/me/proj'],
      parentSessionId: 'parent',
    });
    expect(deps.prompts).toEqual(['port the parser tests']);
    await client.close();
  });

  it('reports a refusal as a tool error, not a transport failure', async () => {
    const deps = makeDeps();
    // No `x-mrt-session`, so the bridge cannot tell who is calling.
    const url = await startBridge(deps);
    const client = new Client({ name: 'test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport as never);

    const result = await client.callTool({
      name: 'spawn_session',
      arguments: { agent: 'codex', prompt: 'do a thing' },
    });

    // The model needs to read this and adjust, so it must come back as a
    // normal tool result carrying isError — not as a thrown transport error.
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/only callable from inside/i);
    expect(deps.spawned).toHaveLength(0);
    await client.close();
  });
});
