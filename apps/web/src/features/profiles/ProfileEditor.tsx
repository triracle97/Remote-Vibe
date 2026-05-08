import { useEffect, useMemo, useState } from 'react';
import type { Profile } from '../../types/protocol';
import { useProfileStore } from './profileStore';
import { useAccountsStore } from '../../store/accounts';
import { DirPicker } from './DirPicker';
import { DEFAULT_WORKSPACE_DIRS } from '../project-picker/default-workspaces';

interface ProfileEditorProps {
  open: boolean;
  onClose: () => void;
  /** Pre-select tab on open. Defaults to 'claude'. */
  initialAgent?: 'claude' | 'codex';
}

interface DraftState {
  /** undefined ⇒ no draft open. 'new' ⇒ creating; otherwise editing existing key (`agent:name`). */
  key: string | 'new' | undefined;
  name: string;
  dirs: string[];
  account: string | null;
}

const NAME_RE = /^[A-Za-z0-9 _-]{1,40}$/;

const emptyDraft: DraftState = { key: undefined, name: '', dirs: [], account: null };

/**
 * Modal for managing profiles per agent.
 * - Tabs switch between Claude and Codex.
 * - Each row has Edit / Delete / Set-default buttons (≥ 44 px tap targets).
 * - Edit expands inline form (name, dirs, codex account).
 * - "+ New profile" appends a draft form.
 * - Full-screen at < 640 px (handled by CSS media query).
 */
export function ProfileEditor({
  open,
  onClose,
  initialAgent = 'claude',
}: ProfileEditorProps): JSX.Element | null {
  const profiles = useProfileStore((s) => s.profiles);
  const fetch = useProfileStore((s) => s.fetch);
  const save = useProfileStore((s) => s.save);
  const remove = useProfileStore((s) => s.delete);
  const setDefault = useProfileStore((s) => s.setDefault);
  const accounts = useAccountsStore((s) => s.accounts);

  const [agent, setAgent] = useState<'claude' | 'codex'>(initialAgent);
  const [draft, setDraft] = useState<DraftState>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      fetch();
      setAgent(initialAgent);
      setDraft(emptyDraft);
      setError(null);
    }
  }, [open, initialAgent, fetch]);

  const filtered = useMemo(
    () => profiles.filter((p) => p.agent === agent),
    [profiles, agent],
  );

  if (!open) return null;

  const startEdit = (p: Profile): void => {
    setDraft({
      key: `${p.agent}:${p.name}`,
      name: p.name,
      dirs: p.dirs.slice(),
      account: p.account,
    });
    setError(null);
  };

  const startNew = (): void => {
    const defaultAccount = agent === 'codex' ? accounts[0]?.name ?? null : null;
    setDraft({
      key: 'new',
      name: '',
      dirs: DEFAULT_WORKSPACE_DIRS.slice(),
      account: defaultAccount,
    });
    setError(null);
  };

  const cancelDraft = (): void => {
    setDraft(emptyDraft);
    setError(null);
  };

  const validateDraft = (): string | null => {
    const name = draft.name.trim();
    if (!name) return 'Name is required.';
    if (!NAME_RE.test(name))
      return 'Name must match [A-Za-z0-9 _-] and be 1-40 chars.';
    if (draft.dirs.length === 0) return 'At least one working dir is required.';
    if (agent === 'codex' && (!draft.account || !draft.account.trim()))
      return 'Codex profiles require an account.';
    // duplicate name check (only when creating, or when renaming)
    const collides = profiles.some(
      (p) =>
        p.agent === agent &&
        p.name === name &&
        draft.key !== `${agent}:${name}`,
    );
    if (collides) return `A ${agent} profile named "${name}" already exists.`;
    return null;
  };

  const submitDraft = async (): Promise<void> => {
    const err = validateDraft();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const existing = profiles.find(
        (p) => p.agent === agent && draft.key === `${agent}:${p.name}`,
      );
      const profile: Profile = {
        name: draft.name.trim(),
        agent,
        dirs: draft.dirs.slice(),
        account: agent === 'codex' ? draft.account : null,
        default: existing?.default ?? false,
      };
      await save(profile);
      // If renaming an existing profile, the old name needs deletion (server treats name as primary key).
      if (existing && existing.name !== profile.name) {
        await remove(existing.name, existing.agent);
      }
      setDraft(emptyDraft);
    } catch (e) {
      const msg =
        typeof e === 'object' && e && 'message' in e
          ? String((e as { message: unknown }).message)
          : 'Failed to save profile.';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (p: Profile): Promise<void> => {
    if (!window.confirm(`Delete profile "${p.name}"?`)) return;
    setBusy(true);
    try {
      await remove(p.name, p.agent);
    } catch (e) {
      const msg =
        typeof e === 'object' && e && 'message' in e
          ? String((e as { message: unknown }).message)
          : 'Failed to delete profile.';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const onSetDefault = async (p: Profile): Promise<void> => {
    setBusy(true);
    try {
      await setDefault(p.name, p.agent);
    } catch (e) {
      const msg =
        typeof e === 'object' && e && 'message' in e
          ? String((e as { message: unknown }).message)
          : 'Failed to set default profile.';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="profile-editor-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Manage profiles"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="profile-editor-modal">
        <div className="profile-editor-header">
          <h2>Manage profiles</h2>
          <button
            type="button"
            className="profile-editor-close"
            onClick={onClose}
            aria-label="close manage profiles"
          >
            ✕
          </button>
        </div>
        <div className="profile-editor-agent-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={agent === 'claude'}
            className={`profile-editor-agent-tab${agent === 'claude' ? ' is-active' : ''}`}
            onClick={() => {
              setAgent('claude');
              setDraft(emptyDraft);
              setError(null);
            }}
          >
            Claude
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={agent === 'codex'}
            className={`profile-editor-agent-tab${agent === 'codex' ? ' is-active' : ''}`}
            onClick={() => {
              setAgent('codex');
              setDraft(emptyDraft);
              setError(null);
            }}
          >
            Codex
          </button>
        </div>

        {filtered.length === 0 && draft.key !== 'new' && (
          <div className="profile-editor-empty">No {agent} profiles yet.</div>
        )}

        <ul className="profile-editor-list">
          {filtered.map((p) => {
            const k = `${p.agent}:${p.name}`;
            const editing = draft.key === k;
            return (
              <li key={k} data-testid="profile-row">
                <div className="profile-editor-row-header">
                  <span className="profile-editor-name" title={p.name}>
                    {p.name}
                    {p.default && <span className="profile-editor-default-badge">default</span>}
                  </span>
                  <div className="profile-editor-actions">
                    <button
                      type="button"
                      className="profile-editor-action"
                      onClick={() => (editing ? cancelDraft() : startEdit(p))}
                      disabled={busy}
                      aria-label={editing ? `cancel editing ${p.name}` : `edit ${p.name}`}
                    >
                      {editing ? 'Cancel' : 'Edit'}
                    </button>
                    <button
                      type="button"
                      className="profile-editor-action"
                      onClick={() => onSetDefault(p)}
                      disabled={busy || p.default}
                      aria-label={`set ${p.name} as default`}
                    >
                      {p.default ? 'Default' : 'Set default'}
                    </button>
                    <button
                      type="button"
                      className="profile-editor-action is-danger"
                      onClick={() => onDelete(p)}
                      disabled={busy}
                      aria-label={`delete ${p.name}`}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {editing && (
                  <DraftForm
                    draft={draft}
                    onChange={setDraft}
                    onSubmit={submitDraft}
                    onCancel={cancelDraft}
                    error={error}
                    busy={busy}
                    agent={agent}
                    accounts={accounts.map((a) => a.name)}
                  />
                )}
              </li>
            );
          })}
          {draft.key === 'new' && (
            <li data-testid="profile-row-new">
              <div className="profile-editor-row-header">
                <span className="profile-editor-name">New {agent} profile</span>
              </div>
              <DraftForm
                draft={draft}
                onChange={setDraft}
                onSubmit={submitDraft}
                onCancel={cancelDraft}
                error={error}
                busy={busy}
                agent={agent}
                accounts={accounts.map((a) => a.name)}
              />
            </li>
          )}
        </ul>

        {draft.key === undefined && (
          <button
            type="button"
            className="profile-editor-new"
            onClick={startNew}
            disabled={busy}
            aria-label="create new profile"
          >
            + New profile
          </button>
        )}
      </div>
    </div>
  );
}

interface DraftFormProps {
  draft: DraftState;
  onChange: (next: DraftState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  error: string | null;
  busy: boolean;
  agent: 'claude' | 'codex';
  accounts: string[];
}

function DraftForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
  error,
  busy,
  agent,
  accounts,
}: DraftFormProps): JSX.Element {
  return (
    <div className="profile-editor-edit">
      <div className="profile-editor-field">
        <label htmlFor="pf-name">Name</label>
        <input
          id="pf-name"
          type="text"
          value={draft.name}
          maxLength={40}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="my-profile"
          aria-label="profile name"
        />
      </div>
      <div className="profile-editor-field">
        <label>Working dirs (first = primary cwd)</label>
        <DirPicker dirs={draft.dirs} onChange={(dirs) => onChange({ ...draft, dirs })} />
      </div>
      {agent === 'codex' && (
        <div className="profile-editor-field">
          <label htmlFor="pf-account">Codex account</label>
          {accounts.length > 0 ? (
            <select
              id="pf-account"
              value={draft.account ?? ''}
              onChange={(e) => onChange({ ...draft, account: e.target.value || null })}
              aria-label="codex account"
            >
              <option value="">— Pick an account —</option>
              {accounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="pf-account"
              type="text"
              value={draft.account ?? ''}
              onChange={(e) => onChange({ ...draft, account: e.target.value || null })}
              placeholder="account name"
              aria-label="codex account"
            />
          )}
        </div>
      )}
      {error && (
        <div className="profile-editor-error" role="alert">
          {error}
        </div>
      )}
      <div className="profile-editor-actions">
        <button
          type="button"
          className="profile-editor-action"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="profile-editor-action is-primary"
          onClick={onSubmit}
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
