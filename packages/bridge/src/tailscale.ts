import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface ExecRunner {
  (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

const defaultExec: ExecRunner = async (cmd, args) => {
  const { stdout, stderr } = await execFileP(cmd, args);
  return { stdout, stderr };
};

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export async function resolveTailscaleIPv4(
  opts: { exec?: ExecRunner } = {},
): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  let result;
  try {
    result = await exec('tailscale', ['ip', '--4']);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error('tailscale CLI not found on PATH. Install Tailscale and retry.');
    }
    throw err;
  }

  if (result.stderr.trim().length > 0 && result.stdout.trim().length === 0) {
    throw new Error(`tailscale ip --4 failed: ${result.stderr.trim()}`);
  }

  const first = result.stdout
    .split('\n')
    .map((s) => s.trim())
    .find((s) => IPV4_RE.test(s));

  if (!first) {
    throw new Error('no Tailscale IPv4 returned by `tailscale ip --4`');
  }

  return first;
}
