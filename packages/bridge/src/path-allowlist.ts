import { realpath as fsRealpath } from 'node:fs/promises';

export class PathOutsideAllowlistError extends Error {
  code = 'path_outside_allowlist' as const;
  constructor(public projectPath: string) {
    super(`projectPath ${projectPath} is not inside any allowed directory`);
  }
}

export interface PathAllowlistOpts {
  allowedDirs: string[];
  realpath?: (p: string) => Promise<string>;
}

/**
 * Returns a validator that resolves the input via `realpath` and asserts the
 * result equals one of `allowedDirs` or has it as an ancestor (path-segment
 * boundary, so `/a` does not match `/ab`). Throws `PathOutsideAllowlistError`
 * on any failure (realpath error, or outside the allowlist).
 */
export function makePathValidator(
  opts: PathAllowlistOpts,
): (projectPath: string) => Promise<string> {
  const realpath = opts.realpath ?? fsRealpath;
  const allowed = opts.allowedDirs;
  return async (projectPath: string) => {
    let real: string;
    try {
      real = await realpath(projectPath);
    } catch {
      throw new PathOutsideAllowlistError(projectPath);
    }
    const inside = allowed.some((d) => real === d || real.startsWith(d === '/' ? '/' : d + '/'));
    if (!inside) throw new PathOutsideAllowlistError(projectPath);
    return real;
  };
}
