import { useEffect, useState, type JSX } from 'react';
import { Modal } from '../../shell/Modal';
import { BottomSheet } from '../../shell/BottomSheet';
import { DirPicker } from '../profiles/DirPicker';
import { ProjectQuickAdd } from '../project-picker/ProjectQuickAdd';
import { ModelEffortPicker } from '../model-picker/ModelEffortPicker';
import { useAccountsStore } from '../../store/accounts';
import { useJobsStore, type NewJobInput } from './jobsStore';
import type { AgentKind, EffortLevel, JobSummary } from '../../types/protocol';

interface Props {
  /** null = closed; a job = edit; 'new' = create. */
  target: JobSummary | 'new' | null;
  onClose: () => void;
  mobile: boolean;
  /** Seeds the project path for a new job. */
  defaultProjectPath?: string;
}

/** Create or edit a Backlog job. */
export function JobEditor({ target, onClose, mobile, defaultProjectPath = '' }: Props): JSX.Element {
  const body = target !== null ? (
    <Body target={target} onClose={onClose} defaultProjectPath={defaultProjectPath} />
  ) : null;
  const label = target === 'new' ? 'New job' : 'Edit job';

  return mobile ? (
    <BottomSheet open={target !== null} onClose={onClose} ariaLabel={label}>
      {body}
    </BottomSheet>
  ) : (
    <Modal open={target !== null} onClose={onClose} ariaLabel={label} maxWidthClass="max-w-lg">
      {body}
    </Modal>
  );
}

function Body({
  target,
  onClose,
  defaultProjectPath,
}: {
  target: JobSummary | 'new';
  onClose: () => void;
  defaultProjectPath: string;
}): JSX.Element {
  const createJob = useJobsStore((s) => s.createJob);
  const updateJob = useJobsStore((s) => s.updateJob);
  const codexAccounts = useAccountsStore((s) => s.accounts);
  const claudeConfigs = useAccountsStore((s) => s.claudeConfigs);

  const editing = target !== 'new' ? target : null;
  const [title, setTitle] = useState(editing?.title ?? '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [tags, setTags] = useState<string[]>(editing?.tags ?? []);
  const [tagDraft, setTagDraft] = useState('');
  const [agent, setAgent] = useState<AgentKind>(editing?.agent ?? 'claude');
  const [account, setAccount] = useState<string | null>(editing?.account ?? null);
  const [claudeConfig, setClaudeConfig] = useState<string | null>(editing?.claudeConfig ?? null);
  const [model, setModel] = useState<string | null>(editing?.model ?? null);
  const [effort, setEffort] = useState<EffortLevel | null>(editing?.effort ?? null);
  const [dirs, setDirs] = useState<string[]>(
    editing
      ? [editing.projectPath, ...editing.additionalDirs]
      : defaultProjectPath
        ? [defaultProjectPath]
        : [],
  );
  const [touched, setTouched] = useState(false);

  // Reopening on a different job must not keep the previous draft.
  useEffect(() => {
    setTitle(editing?.title ?? '');
    setNotes(editing?.notes ?? '');
    setTags(editing?.tags ?? []);
    setTagDraft('');
    setAgent(editing?.agent ?? 'claude');
    setAccount(editing?.account ?? null);
    setClaudeConfig(editing?.claudeConfig ?? null);
    setModel(editing?.model ?? null);
    setEffort(editing?.effort ?? null);
    setDirs(
      editing
        ? [editing.projectPath, ...editing.additionalDirs]
        : defaultProjectPath
          ? [defaultProjectPath]
          : [],
    );
    setTouched(false);
  }, [editing?.id, defaultProjectPath]);

  const commitTag = (): void => {
    const t = tagDraft.trim();
    if (t.length === 0) return;
    if (!tags.includes(t)) setTags([...tags, t]);
    setTagDraft('');
  };

  const titleOk = title.trim().length > 0;
  const dirsOk = dirs.length > 0;
  const canSave = titleOk && dirsOk;

  const save = (): void => {
    setTouched(true);
    if (!canSave) return;
    const input: NewJobInput = {
      title: title.trim(),
      notes,
      tags,
      projectPath: dirs[0]!,
      additionalDirs: dirs.slice(1),
      agent,
      account: agent === 'codex' ? account : null,
      claudeConfig: agent === 'claude' ? claudeConfig : null,
      model,
      effort,
    };
    if (editing) updateJob(editing.id, input);
    else createJob(input);
    onClose();
  };

  return (
    <div className="p-4 flex flex-col gap-3">
      <h2 className="text-base font-semibold text-[var(--color-text)]">
        {editing ? 'Edit job' : 'New job'}
      </h2>

      <Field label="What needs doing">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
          }}
          placeholder="fix the auth token expiry check"
          maxLength={200}
          aria-label="Job title"
          className={inputClass(touched && !titleOk)}
        />
        {touched && !titleOk && <Hint tone="danger">A title is required.</Hint>}
      </Field>

      <Field label="Details (optional)">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="Anything the agent should know before it starts. Sent as part of the first message."
          aria-label="Job notes"
          className={`${inputClass(false)} resize-y font-mono text-[13px]`}
        />
      </Field>

      <Field label="Tags">
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((t) => (
            <span
              key={t}
              className="text-[11px] pl-2 pr-1 py-0.5 rounded-full border border-[var(--color-border)] text-[var(--color-text-mute)] flex items-center gap-1"
            >
              {t}
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={() => setTags(tags.filter((x) => x !== t))}
                className="hover:text-[var(--color-danger)] px-0.5 leading-none"
              >
                ×
              </button>
            </span>
          ))}
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commitTag();
              }
            }}
            onBlur={commitTag}
            placeholder="add tag…"
            aria-label="Add tag"
            maxLength={40}
            className="text-[11px] px-2 py-1 w-28 rounded-full bg-transparent border border-dashed border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        <Hint>Carried over to the session when the job starts.</Hint>
      </Field>

      <Field label="Agent">
        <div className="flex gap-1.5">
          {(['claude', 'codex'] as const).map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={agent === a}
              onClick={() => setAgent(a)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                agent === a
                  ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] text-[var(--color-text)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-mute)]'
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </Field>

      {agent === 'claude' && claudeConfigs.length > 1 && (
        <Field label="Claude profile">
          <select
            value={claudeConfig ?? ''}
            onChange={(e) => setClaudeConfig(e.target.value || null)}
            aria-label="Claude profile"
            className={inputClass(false)}
          >
            <option value="">default</option>
            {claudeConfigs
              .filter((c) => c.name !== 'default')
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
          </select>
        </Field>
      )}

      {agent === 'codex' && codexAccounts.length > 1 && (
        <Field label="Codex account">
          <select
            value={account ?? ''}
            onChange={(e) => setAccount(e.target.value || null)}
            aria-label="Codex account"
            className={inputClass(false)}
          >
            <option value="">default</option>
            {codexAccounts.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Model & effort">
        <ModelEffortPicker
          agent={agent}
          model={model}
          effort={effort}
          onModelChange={setModel}
          onEffortChange={setEffort}
        />
      </Field>

      <Field label="Working directories">
        <DirPicker dirs={dirs} onChange={setDirs} />
        <ProjectQuickAdd
          selected={dirs}
          onAdd={(p) => setDirs([...dirs, p])}
          includeRoots={false}
        />
        {touched && !dirsOk && <Hint tone="danger">Pick at least one directory.</Hint>}
      </Field>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={save}
          className="flex-1 text-sm px-3 py-2 rounded-lg border border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] text-[var(--color-text)]"
        >
          {editing ? 'Save' : 'Add to Backlog'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-sm px-3 py-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-mute)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function inputClass(invalid: boolean): string {
  return [
    'w-full px-2.5 py-1.5 rounded-lg text-sm',
    'bg-[var(--color-surface-2)] text-[var(--color-text)]',
    'border',
    invalid ? 'border-[var(--color-danger)]' : 'border-[var(--color-border)]',
    'placeholder:text-[var(--color-text-dim)]',
    'focus:outline-none focus:border-[var(--color-accent)]',
  ].join(' ');
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-mute)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function Hint({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: 'danger';
}): JSX.Element {
  return (
    <span
      className="text-[11px]"
      style={{ color: tone === 'danger' ? 'var(--color-danger)' : 'var(--color-text-dim)' }}
    >
      {children}
    </span>
  );
}
