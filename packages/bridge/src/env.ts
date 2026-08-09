import { isAbsolute, join } from 'node:path';
import { headroomConfigFromEnv } from './headroom.js';
import { titlerConfigFromEnv } from './titler.js';
import { parseEffortLevel, parseModelId, type EffortLevel } from './models.js';
import { parseWorkflowSize, type WorkflowSize } from './claude-settings.js';

export interface BridgeConfig {
  token: string;
  port: number;
  bindHost?: string;
  allowedDirs: string[];
  /** Largest file the file drawer will stream to the browser. */
  fsReadMaxBytes: number;
  /**
   * Largest body `write_file` will accept. Deliberately separate from the read
   * cap: reading is cheap and reversible, writing is neither, so the two knobs
   * should be tunable in opposite directions.
   */
  fsWriteMaxBytes: number;
  /** Bridge-wide model/effort defaults; null means "CLI decides". */
  defaultModel: string | null;
  defaultEffort: EffortLevel | null;
  /**
   * Bridge-wide workflow defaults for Claude sessions; null means "say nothing
   * and let the CLI decide". Only reach the session when something turns
   * workflows on — either ultracode, or one of these being set.
   */
  defaultWorkflowSize: WorkflowSize | null;
  defaultWorkflowKeywordTrigger: boolean | null;
  dataDir: string;
  transcriptRetentionDays: number;
  /** Session registry path. Relative paths resolve against the bridge cwd. */
  sessionsFile: string;
  /**
   * Absolute CLAUDE_CONFIG_DIR handed to every Claude spawn (e.g. `~/.claude1`).
   * `undefined` leaves the CLI on its own default (`~/.claude`). Also steers
   * native-history and slash-command discovery so they read the same profile.
   */
  claudeConfigDir?: string;
  headroom: { enabled: boolean; bin: string; port: number };
  /** Agent-generated session names. See `titler.ts`. */
  titler: { enabled: boolean; model: string };
}

const MIN_TOKEN_LEN = 24;
const DEFAULT_DATA_SUBDIR = '.config/mac-remote-terminal';
/**
 * Keep transcripts forever by default (0 disables pruning).
 *
 * These are the app's own durable record of every session, and the only copy
 * that outlives the agent CLI's own rotating history. A 30-day default meant
 * the board quietly lost the transcripts behind its older cards — set a
 * positive number only if disk pressure actually demands it.
 */
const DEFAULT_RETENTION_DAYS = 0;
const DEFAULT_SESSIONS_FILE = join('.bridge', 'sessions.json');
const DEFAULT_FS_READ_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_FS_WRITE_MAX_BYTES = 5 * 1024 * 1024;

/** Parse a positive-integer byte cap, falling back to `fallback` when unset. */
function parseByteCap(
  raw: string | undefined,
  fallback: number,
  varName: string,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${varName} must be a positive integer number of bytes`);
  }
  return parsed;
}

/**
 * Expand a leading `~` and reject anything still relative. Config dirs land in
 * a `zsh -c` command line, where `assertResumeArgSafe` rejects `~` outright —
 * so the expansion has to happen here, before validation.
 */
function resolveHomePath(
  raw: string,
  home: string | undefined,
  varName: string,
): string {
  let out = raw.trim();
  if (out === '~' || out.startsWith('~/')) {
    if (!home) throw new Error(`${varName} uses '~' but HOME is not set`);
    out = out === '~' ? home : join(home, out.slice(2));
  }
  if (!isAbsolute(out)) {
    throw new Error(`${varName} must be an absolute path (got '${raw}')`);
  }
  return out;
}

export function loadEnv(env: Record<string, string | undefined>): BridgeConfig {
  const token = env.BRIDGE_TOKEN;
  if (!token) {
    throw new Error(
      'BRIDGE_TOKEN is required. Generate one: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (token.length < MIN_TOKEN_LEN) {
    throw new Error(`BRIDGE_TOKEN must be at least ${MIN_TOKEN_LEN} characters`);
  }

  const port = Number(env.BRIDGE_PORT ?? '8765');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('BRIDGE_PORT must be a positive integer');
  }

  const allowedDirsRaw = env.BRIDGE_ALLOWED_DIRS ?? env.HOME;
  if (!allowedDirsRaw) {
    throw new Error('BRIDGE_ALLOWED_DIRS or HOME must be set');
  }
  const allowedDirs = allowedDirsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const home = env.HOME;
  const dataDir =
    env.BRIDGE_DATA_DIR ??
    (home ? join(home, DEFAULT_DATA_SUBDIR) : (() => {
      throw new Error('BRIDGE_DATA_DIR or HOME must be set');
    })());

  const retentionRaw = env.BRIDGE_TRANSCRIPT_RETENTION_DAYS;
  let transcriptRetentionDays = DEFAULT_RETENTION_DAYS;
  if (retentionRaw !== undefined) {
    const parsed = Number(retentionRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error('BRIDGE_TRANSCRIPT_RETENTION_DAYS must be a non-negative integer');
    }
    transcriptRetentionDays = parsed;
  }

  const fsReadMaxBytes = parseByteCap(
    env.BRIDGE_FS_READ_MAX_BYTES,
    DEFAULT_FS_READ_MAX_BYTES,
    'BRIDGE_FS_READ_MAX_BYTES',
  );
  const fsWriteMaxBytes = parseByteCap(
    env.BRIDGE_FS_WRITE_MAX_BYTES,
    DEFAULT_FS_WRITE_MAX_BYTES,
    'BRIDGE_FS_WRITE_MAX_BYTES',
  );

  const bindHost = env.BRIDGE_BIND_HOST;

  const sessionsFile = env.BRIDGE_SESSIONS_FILE?.trim() || DEFAULT_SESSIONS_FILE;

  const claudeConfigDirRaw = env.BRIDGE_CLAUDE_CONFIG_DIR?.trim();
  const claudeConfigDir = claudeConfigDirRaw
    ? resolveHomePath(claudeConfigDirRaw, home, 'BRIDGE_CLAUDE_CONFIG_DIR')
    : undefined;

  // App-wide model/effort defaults, overridable per session. Invalid values
  // resolve to null (= "leave the CLI on its own default") rather than
  // failing boot, since a stale .env should not stop the bridge starting.
  const defaultModel = parseModelId(env.BRIDGE_DEFAULT_MODEL);
  const defaultEffort = parseEffortLevel(env.BRIDGE_DEFAULT_EFFORT);
  if (env.BRIDGE_DEFAULT_MODEL && defaultModel === null) {
    console.warn(`[bridge] ignoring invalid BRIDGE_DEFAULT_MODEL: ${env.BRIDGE_DEFAULT_MODEL}`);
  }
  if (env.BRIDGE_DEFAULT_EFFORT && defaultEffort === null) {
    console.warn(`[bridge] ignoring invalid BRIDGE_DEFAULT_EFFORT: ${env.BRIDGE_DEFAULT_EFFORT}`);
  }

  const defaultWorkflowSize = parseWorkflowSize(env.BRIDGE_WORKFLOW_SIZE?.trim());
  if (env.BRIDGE_WORKFLOW_SIZE && defaultWorkflowSize === null) {
    console.warn(
      `[bridge] ignoring invalid BRIDGE_WORKFLOW_SIZE: ${env.BRIDGE_WORKFLOW_SIZE} ` +
        '(expected unrestricted | small | medium | large)',
    );
  }
  // Unset stays null rather than defaulting to true: writing the key at all
  // turns workflows on for the session, which is not something an unset
  // variable should decide.
  const keywordRaw = env.BRIDGE_WORKFLOW_KEYWORD_TRIGGER?.trim();
  const defaultWorkflowKeywordTrigger =
    keywordRaw === undefined || keywordRaw === '' ? null : /^(1|true|yes|on)$/i.test(keywordRaw);

  const headroom = headroomConfigFromEnv(env);
  const titler = titlerConfigFromEnv(env);

  return {
    token,
    port,
    allowedDirs,
    fsReadMaxBytes,
    fsWriteMaxBytes,
    defaultModel,
    defaultEffort,
    defaultWorkflowSize,
    defaultWorkflowKeywordTrigger,
    dataDir,
    transcriptRetentionDays,
    sessionsFile,
    headroom,
    titler,
    ...(bindHost ? { bindHost } : {}),
    ...(claudeConfigDir ? { claudeConfigDir } : {}),
  };
}
