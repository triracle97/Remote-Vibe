/**
 * Extra `--add-dir` roots handed to a session resumed from CLI history.
 *
 * A resumed session has no record of the `--add-dir` set it originally ran
 * with, so it falls back to this. Every entry is still filtered through
 * `isAllowedDir`, so this can only narrow `BRIDGE_ALLOWED_DIRS`, never widen
 * it.
 */
export const DEFAULT_WORKSPACE_DIRS = ['/Volumes/WDSSD/Code'] as const;
