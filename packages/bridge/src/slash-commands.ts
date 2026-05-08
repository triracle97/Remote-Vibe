import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { SlashCommand } from './types.js';

const SCAN_CAP = 200;
const CACHE_TTL_MS = 60_000;

const CLAUDE_BUILTINS: SlashCommand[] = [
  { name: '/help', description: 'show help', source: 'builtin', agent: 'claude' },
  { name: '/clear', description: 'reset conversation', source: 'builtin', agent: 'claude' },
  { name: '/compact', description: 'reduce context', source: 'builtin', agent: 'claude' },
  { name: '/cost', description: 'show usage', source: 'builtin', agent: 'claude' },
  { name: '/status', description: 'show session status', source: 'builtin', agent: 'claude' },
  { name: '/agents', description: 'list subagents', source: 'builtin', agent: 'claude' },
  { name: '/memory', description: 'manage memory', source: 'builtin', agent: 'claude' },
  { name: '/exit', description: 'end session', source: 'builtin', agent: 'claude' },
  { name: '/init', description: 'init project', source: 'builtin', agent: 'claude' },
  { name: '/install-github-app', description: 'install GitHub app', source: 'builtin', agent: 'claude' },
  { name: '/login', description: 'log in', source: 'builtin', agent: 'claude' },
  { name: '/logout', description: 'log out', source: 'builtin', agent: 'claude' },
  { name: '/model', description: 'switch model', source: 'builtin', agent: 'claude' },
  { name: '/permissions', description: 'manage permissions', source: 'builtin', agent: 'claude' },
  { name: '/review', description: 'request review', source: 'builtin', agent: 'claude' },
];

const CODEX_BUILTINS: SlashCommand[] = [
  { name: '/help', description: 'show help', source: 'builtin', agent: 'codex' },
  { name: '/clear', description: 'reset conversation', source: 'builtin', agent: 'codex' },
  { name: '/exit', description: 'end session', source: 'builtin', agent: 'codex' },
];

interface ScannerOpts {
  homeDir: string;
}

export class SlashCommandsScanner {
  private cache = new Map<string, { value: SlashCommand[]; expiresAt: number }>();

  constructor(private readonly opts: ScannerOpts) {}

  async listForSession(session: {
    sessionId: string;
    agent: 'claude' | 'codex';
    primaryCwd: string;
  }): Promise<SlashCommand[]> {
    const cacheKey = `${session.sessionId}:${session.agent}:${session.primaryCwd}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.value;

    const builtins = session.agent === 'claude' ? CLAUDE_BUILTINS : CODEX_BUILTINS;

    if (session.agent === 'codex') {
      this.cache.set(cacheKey, { value: builtins, expiresAt: Date.now() + CACHE_TTL_MS });
      return builtins;
    }

    // Claude only: scan user + project dirs
    const userCmds = await this.scanDir(join(this.opts.homeDir, '.claude', 'commands'), 'user');
    const projectCmds = await this.scanDir(
      join(session.primaryCwd, '.claude', 'commands'),
      'project',
    );

    // Merge with project > user > builtin precedence (project wins on collision).
    const map = new Map<string, SlashCommand>();
    for (const c of builtins) map.set(c.name, c);
    for (const c of userCmds) map.set(c.name, c);
    for (const c of projectCmds) map.set(c.name, c);

    const result = [...map.values()];
    this.cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  invalidateCache(sessionId?: string): void {
    if (!sessionId) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.cache.delete(key);
    }
  }

  private async scanDir(
    dir: string,
    source: 'user' | 'project',
  ): Promise<SlashCommand[]> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .slice(0, SCAN_CAP)
      .sort((a, b) => a.name.localeCompare(b.name));
    const out: SlashCommand[] = [];
    for (const f of files) {
      try {
        const content = await fsp.readFile(join(dir, f.name), 'utf-8');
        const description = parseDescription(content);
        out.push({
          name: '/' + f.name.slice(0, -3), // strip .md
          description,
          source,
          agent: 'claude',
        });
      } catch {
        // skip unreadable file
      }
    }
    return out;
  }
}

function parseDescription(content: string): string {
  const lines = content.split('\n');
  // Frontmatter: lines between `---` markers at start of file
  if (lines[0]?.trim() === '---') {
    let i = 1;
    while (i < lines.length && lines[i]?.trim() !== '---') {
      const m = /^description:\s*(.+)$/.exec(lines[i] ?? '');
      if (m) return m[1]!.trim();
      i++;
    }
    // Skip past closing ---
    i++;
    // Fall back to first non-empty line after frontmatter
    while (i < lines.length) {
      const t = lines[i]!.trim();
      if (t.length > 0) return t;
      i++;
    }
    return '';
  }
  // No frontmatter; return first non-empty line
  for (const line of lines) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return '';
}
