import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentKind } from './types.js';

export interface PromptEntry {
  hash: string;
  text: string;
  lastUsedAt: number;
  projectPaths: string[];
  agents: AgentKind[];
}

interface PromptsFile {
  version: 1;
  entries: PromptEntry[];
}

const FILE_NAME = 'prompts.json';
const TMP_NAME = 'prompts.json.tmp';
const CAP = 500;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class PromptStore {
  private readonly dataDir: string;
  private readonly path: string;
  private readonly tmpPath: string;
  private entries: PromptEntry[];

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      console.warn(`[prompt-store] mkdir(${dataDir}) failed: ${(err as Error).message}`);
    }
    this.path = join(dataDir, FILE_NAME);
    this.tmpPath = join(dataDir, TMP_NAME);
    this.entries = this.read();
  }

  private read(): PromptEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PromptsFile>;
      if (raw && raw.version === 1 && Array.isArray(raw.entries)) {
        return raw.entries.filter(
          (e) =>
            typeof e?.hash === 'string' &&
            typeof e.text === 'string' &&
            typeof e.lastUsedAt === 'number' &&
            Array.isArray(e.projectPaths) &&
            Array.isArray(e.agents),
        );
      }
      return [];
    } catch (err) {
      console.warn(`[prompt-store] reading ${this.path} failed: ${(err as Error).message}`);
      return [];
    }
  }

  private write(): void {
    const data: PromptsFile = { version: 1, entries: this.entries };
    try {
      writeFileSync(this.tmpPath, JSON.stringify(data));
      renameSync(this.tmpPath, this.path);
    } catch (err) {
      console.warn(`[prompt-store] writing ${this.path} failed: ${(err as Error).message}`);
    }
  }

  add(args: { text: string; projectPath: string; agent: AgentKind }): void {
    if (args.text.length === 0) return;
    const hash = sha256(args.text);
    const idx = this.entries.findIndex((e) => e.hash === hash);
    const now = Date.now();
    if (idx >= 0) {
      const found = this.entries[idx]!;
      const updated: PromptEntry = {
        hash,
        text: args.text,
        lastUsedAt: now,
        projectPaths: found.projectPaths.includes(args.projectPath)
          ? found.projectPaths
          : [...found.projectPaths, args.projectPath],
        agents: found.agents.includes(args.agent) ? found.agents : [...found.agents, args.agent],
      };
      this.entries.splice(idx, 1);
      this.entries.unshift(updated);
    } else {
      this.entries.unshift({
        hash,
        text: args.text,
        lastUsedAt: now,
        projectPaths: [args.projectPath],
        agents: [args.agent],
      });
    }
    if (this.entries.length > CAP) this.entries.length = CAP;
    this.write();
  }

  list(query?: string, limit?: number): PromptEntry[] {
    let out = this.entries;
    if (query && query.length > 0) {
      const lower = query.toLowerCase();
      out = out.filter((e) => e.text.toLowerCase().includes(lower));
    }
    if (typeof limit === 'number' && limit > 0) out = out.slice(0, limit);
    return out;
  }
}
