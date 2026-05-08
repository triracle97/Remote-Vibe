# Default Workspace Dirs Design

## Goal

New sessions and new profiles should offer these working directories by default:

- `/Volumes/WDSSD/Code/storybook-solid-js`
- `/Volumes/WDSSD/Code/posRN1`
- `/Volumes/WDSSD/Code/customer-management`

Native history resumes should persist the same multi-dir context so future resumes keep access to the related workspaces.

## Design

The web project picker and profile editor will use a small default workspace list when no user-selected dirs are already present. Existing saved default profiles remain higher priority: when a default profile is loaded, it can still replace the prefilled hardcoded list.

The bridge will apply the same default list when creating a new registry entry from native CLI history. The resumed history entry's own project path remains the primary cwd. Default dirs are resolved, allowlist-checked, de-duplicated against the primary cwd, and stored as `additionalDirs`.

Bridge-known resumes will pass `entry.additionalDirs` back into the driver factory for both Claude and Codex. Claude receives them as add-dir inputs through the existing driver path; Codex keeps them as stored diagnostics because the CLI has no add-dir equivalent.

## Testing

Add web tests for ProjectPicker and ProfileEditor default rows. Add bridge session tests for native-history registry persistence and path-one resume forwarding.
