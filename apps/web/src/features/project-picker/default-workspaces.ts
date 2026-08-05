/**
 * The workspace root everything lives under.
 *
 * Seeds the Settings "default workspaces" list, a new profile's dirs, and the
 * project a new job falls back to. Project *suggestions* no longer come from
 * here — `ProjectQuickAdd` lists the bridge's real `allowedDirs` instead, so
 * this no longer has to enumerate individual repos.
 */
export const DEFAULT_WORKSPACE_DIRS = ['/Volumes/WDSSD/Code'] as const;
