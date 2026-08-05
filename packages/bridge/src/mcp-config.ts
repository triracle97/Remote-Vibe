import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Per-session `--mcp-config` files.
 *
 * One file per session rather than one shared file, because the file is how the
 * spawned agent learns *which* session it is: the caller id rides in a header
 * the agent never sees and cannot forge from inside its own process. A shared
 * config could only carry the token, and every session would then look alike to
 * `spawn_session`.
 *
 * These are written under the bridge's own data dir, never into the user's
 * `~/.claude.json` — the same reason `--no-mcp` is passed to headroom. The
 * bridge does not edit the user's profile.
 */

export interface McpConfigWriterOpts {
  dataDir: string;
  /** Bridge port, for the loopback URL the agent connects back on. */
  port: number;
  token: string;
}

/** The file contains the bridge token, so keep it owner-only. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export class McpConfigWriter {
  private readonly dir: string;
  private readonly url: string;
  private readonly token: string;
  private ensured = false;

  constructor(opts: McpConfigWriterOpts) {
    this.dir = join(opts.dataDir, 'mcp');
    // Always loopback: the agent runs on this machine, and binding the MCP
    // route to the tailnet address would expose it more widely than the token
    // check alone warrants.
    this.url = `http://127.0.0.1:${opts.port}/mcp`;
    this.token = opts.token;
  }

  /**
   * Write the config for one session and return its absolute path.
   *
   * Returns null on any failure: an agent that cannot spawn other agents is a
   * working agent, so this must never take a session down with it.
   */
  async write(webSessionId: string): Promise<string | null> {
    try {
      if (!this.ensured) {
        await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
        this.ensured = true;
      }
      const path = join(this.dir, `${webSessionId}.json`);
      const body = {
        mcpServers: {
          // Namespaced so the tool reads as `mcp__mac_remote_terminal__spawn_session`
          // in the transcript rather than colliding with a user server.
          mac_remote_terminal: {
            type: 'http',
            url: this.url,
            headers: {
              Authorization: `Bearer ${this.token}`,
              'x-mrt-session': webSessionId,
            },
          },
        },
      };
      await writeFile(path, JSON.stringify(body, null, 2), { mode: FILE_MODE });
      return path;
    } catch (err) {
      console.warn('[mcp] could not write session config, spawning without it:', err);
      return null;
    }
  }
}
