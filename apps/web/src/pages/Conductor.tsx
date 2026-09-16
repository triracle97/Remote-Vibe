import { useEffect, type ReactNode } from 'react';
import { useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, FileText } from 'lucide-react';
import type { AppShellOutletContext } from '../shell/AppShell';
import type { PipelineSummary, SliceSummary, TicketSummary } from '../types/protocol';
import {
  useConductorStore,
  useSessionPipelines,
  selectTiedPipeline,
  pipelineBadgeLabel,
  sliceRoster,
} from '../store/conductor';
import { useConnectionStore } from '../store/connection';
import { PipelineDoc } from '../features/conductor/PipelineDoc';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Last path segment: a worktree is recognised by its name, not its prefix. */
function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function ticketTone(status: string | null): string {
  switch (status) {
    case 'done':
    case 'resolved':
      return 'text-[var(--color-ok,#2e7d32)]';
    case 'blocked':
      return 'text-[var(--color-danger)]';
    case 'dropped':
      return 'text-[var(--color-text-dim)] line-through';
    default:
      return 'text-[var(--color-text-dim)]';
  }
}

/**
 * Workers first, and a blocked one before anything else.
 *
 * A blocked slice is the only thing on this page that is waiting on a person,
 * so it goes where it will be seen before the scroll starts. Finished slices
 * keep their place at the bottom: they are the record, not the work.
 */
function orderSlices(slices: SliceSummary[]): SliceSummary[] {
  return slices
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        Number(b.s.blocked) - Number(a.s.blocked) ||
        Number(b.s.inFlight) - Number(a.s.inFlight) ||
        a.i - b.i,
    )
    .map((x) => x.s);
}

/**
 * The conductor pipeline, as a page rather than a drawer.
 *
 * It started as a slide-out panel, which was wrong for the content: these
 * artefacts run to 184K and 300K, and a 28rem column with a section dropdown
 * is not somewhere anyone reads a spec. One surface, full width, with the
 * browser's own back button doing the navigating.
 *
 * Since conductor learned to dispatch slices in parallel, the page's headline
 * is no longer "where has the pipeline got to" but "what is every worker
 * doing" — several slices run at once, each in its own worktree with its own
 * STATE.md, and the one in the foreground is only one of them.
 *
 * `?slice=<id>` opens a worker, `?doc=<abs path>` a document. Keeping both in
 * the URL rather than in component state is what makes back work, and what
 * makes a document linkable.
 */
export function Conductor(): JSX.Element {
  const { client } = useOutletContext<AppShellOutletContext>();
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const docPath = params.get('doc');
  const sliceId = params.get('slice');

  const connStatus = useConnectionStore((s) => s.status);
  // Scoped to this session: the store is global, and a scan started in another
  // session must not paint its pipelines onto this one.
  const { pipelines, warnings, loaded } = useSessionPipelines(id);
  const pinnedSlug = useConductorStore((s) => (id ? s.pinnedBySession[id] ?? null : null));
  const pin = useConductorStore((s) => s.pin);
  const agentSlug = useConductorStore((s) => (id ? s.agentTie[id] ?? null : null));
  const requestPipelines = useConductorStore((s) => s.requestPipelines);
  const doc = useConductorStore((s) => s.doc);
  const openDoc = useConductorStore((s) => s.openDoc);
  const closeDoc = useConductorStore((s) => s.closeDoc);

  const pipeline = selectTiedPipeline(pipelines, { pinnedSlug, agentSlug });

  // Reloading straight onto this URL, or opening it in a new tab, arrives with
  // an empty store — so the page asks for its own data rather than assuming
  // the session page already did. `loaded` is false for another session's
  // scan too, which is what makes switching sessions re-ask.
  useEffect(() => {
    if (!id || connStatus !== 'open' || loaded) return;
    requestPipelines(client, id);
  }, [client, id, connStatus, loaded, requestPipelines]);

  // The URL owns which document is open; the store follows it.
  useEffect(() => {
    if (!docPath) {
      if (doc) closeDoc();
      return;
    }
    if (doc?.path === docPath) return;
    const name = docPath.slice(docPath.lastIndexOf('/') + 1);
    openDoc(client, docPath, name);
  }, [docPath, doc, openDoc, closeDoc, client]);

  const openDocPath = (path: string): void => {
    // The slice rides along, so closing the document returns to the worker it
    // was opened from rather than to the overview.
    setParams(sliceId ? { slice: sliceId, doc: path } : { doc: path });
  };
  const backFromDoc = (): void => setParams(sliceId ? { slice: sliceId } : {});

  if (!pipeline) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <PageHeader
          title="Conductor"
          subtitle={loaded ? 'no pipeline found' : 'looking…'}
          onBack={() => navigate(`/session/${id}`)}
        />
        <div className="p-4 text-sm text-[var(--color-text-dim)]">
          {loaded
            ? 'No .pipeline/ directory in this session’s working dirs or their worktrees.'
            : 'Scanning…'}
          {warnings.length > 0 && (
            <ul className="list-none p-0 mt-3 m-0 text-xs font-mono">
              {warnings.map((w) => (
                <li key={w} className="py-0.5 break-all">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  if (docPath && doc) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <PageHeader title={doc.name} subtitle={pipeline.slug} onBack={backFromDoc} />
        <PipelineDoc doc={doc} />
      </div>
    );
  }

  const roster = orderSlices(sliceRoster(pipeline));
  // One slice is not a list worth tapping through — it is the pipeline.
  const inline = roster.length === 1 ? roster[0]! : null;
  const open = sliceId ? roster.find((s) => s.id === sliceId) ?? null : inline;

  if (open && (sliceId || inline)) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <PageHeader
          title={inline ? pipeline.slug : open.id}
          subtitle={inline ? pipelineBadgeLabel(pipeline) : sliceLabel(open)}
          onBack={inline ? () => navigate(`/session/${id}`) : () => setParams({})}
        />
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-screen-md w-full mx-auto p-4 flex flex-col gap-4">
            {inline && <Banners pipeline={pipeline} />}
            {inline && (
              <Summary pipeline={pipeline} running={roster.filter((s) => s.inFlight).length} />
            )}
            {/* Inline, the slice is the pipeline, and `Banners` has already
                said it is blocked. Twice is not twice as loud. */}
            <SliceDetail slice={open} onOpenDoc={openDocPath} banner={!inline} />
            <ArtefactCard
              title="Pipeline"
              artefacts={pipeline.artefacts}
              baseDir={pipeline.dir}
              onOpen={openDocPath}
            />
            <Warnings warnings={warnings} />
            <p className="text-[11px] text-[var(--color-text-dim)] font-mono break-all">
              {open.dir}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const running = roster.filter((s) => s.inFlight).length;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PageHeader
        title={pipeline.slug}
        subtitle={pipelineBadgeLabel(pipeline)}
        onBack={() => navigate(`/session/${id}`)}
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-screen-md w-full mx-auto p-4 flex flex-col gap-4">
          <Banners pipeline={pipeline} />

          {pipelines.length > 1 && (
            <section>
              <label
                htmlFor="conductor-pipeline-pick"
                className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-dim)] mb-1"
              >
                {pinnedSlug ? 'Pipeline (pinned)' : 'Pipeline (newest — pick to pin)'}
              </label>
              <select
                id="conductor-pipeline-pick"
                value={pipeline.slug}
                onChange={(e) => id && pin(id, e.target.value)}
                className="w-full min-h-[44px] bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] rounded-lg px-3"
              >
                {pipelines.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.slug}
                  </option>
                ))}
              </select>
            </section>
          )}

          <Summary pipeline={pipeline} running={running} />

          <Card title={`Workers — ${running} in flight`}>
            <ul
              aria-label="Workers"
              className="list-none p-0 m-0 divide-y divide-[var(--color-border)]"
            >
              {roster.map((s) => (
                <WorkerRow key={s.id} slice={s} onOpen={() => setParams({ slice: s.id })} />
              ))}
            </ul>
          </Card>

          <ArtefactCard
            title="Pipeline"
            artefacts={pipeline.artefacts}
            baseDir={pipeline.dir}
            onOpen={openDocPath}
          />

          <Warnings warnings={warnings} />

          <p className="text-[11px] text-[var(--color-text-dim)] font-mono break-all">
            {pipeline.dir}
          </p>
        </div>
      </div>
    </div>
  );
}

/** `3/ready · 6/7 tickets` — one line saying where a slice has got to. */
function sliceLabel(s: SliceSummary): string {
  const bits: string[] = [];
  if (s.phase) bits.push(s.step ? `${s.phase}/${s.step}` : `ph${s.phase}`);
  if (s.ticketsTotal !== null) bits.push(`${s.ticketsDone ?? 0}/${s.ticketsTotal} tickets`);
  if (s.branch) bits.push(baseName(s.branch));
  return bits.join(' · ') || s.id;
}

function Banners({ pipeline }: { pipeline: PipelineSummary }): JSX.Element {
  return (
    <>
      {pipeline.blocked && (
        <div className="flex items-start gap-2 p-3 rounded-xl border border-[var(--color-danger)] text-sm">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            <strong>BLOCKED.</strong> A loop did not converge and this pipeline is waiting on a
            decision.
          </span>
        </div>
      )}

      {!pipeline.inSessionDir && (
        <div className="flex items-start gap-2 p-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text-dim)]">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            This pipeline is not in the session’s own directory — it was found in worktree{' '}
            <code className="font-mono text-[var(--color-text)]">{pipeline.worktree}</code>. Normal
            when the skill runs from the main checkout, but check it is the work you meant.
          </span>
        </div>
      )}
    </>
  );
}

/** Fields worth pulling to the top. Everything else still renders below. */
const HEADLINE_KEYS = ['phase', 'step', 'slice', 'branch', 'base_commit'];

/**
 * The pipeline in one line: how much is running, how much is done, how much
 * may run at once.
 *
 * Root STATE.md stopped answering "where is it" when dispatch went parallel —
 * phase and step moved into each slice's own file, and what is left here is
 * the shape of the whole run.
 */
function Summary({
  pipeline,
  running,
}: {
  pipeline: PipelineSummary;
  running: number;
}): JSX.Element {
  const bits: string[] = [];
  if (running > 0) bits.push(`${running} running`);
  if (pipeline.slicesTotal !== null) {
    bits.push(`${pipeline.slicesDone ?? 0}/${pipeline.slicesTotal} merged`);
  }
  if (pipeline.concurrency !== null) bits.push(`${pipeline.concurrency} at once`);

  return (
    <Card title="State">
      <div data-testid="conductor-summary" className="px-3 pt-3 text-sm">
        {bits.length > 0 ? (
          <p className="m-0 font-mono">{bits.join(' · ')}</p>
        ) : (
          <p className="m-0 text-[var(--color-text-dim)]">Nothing counted in STATE.md yet.</p>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 p-3 m-0 text-sm">
        {HEADLINE_KEYS.filter((k) => pipeline.state[k]).map((k) => (
          <div key={k} className="contents">
            <dt className="text-[var(--color-text-dim)] font-mono text-xs self-center">{k}</dt>
            <dd className="m-0 font-mono truncate">{pipeline.state[k]}</dd>
          </div>
        ))}
      </dl>
      <details className="px-3 pb-3">
        <summary className="text-xs text-[var(--color-text-dim)] cursor-pointer min-h-[32px] flex items-center">
          All STATE.md fields
        </summary>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mt-2 m-0 text-xs">
          {Object.entries(pipeline.state).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[var(--color-text-dim)] font-mono self-center">{k}</dt>
              <dd className="m-0 font-mono break-all">{v || '—'}</dd>
            </div>
          ))}
        </dl>
      </details>
    </Card>
  );
}

/** Colour for a dispatch status. Blocked is the only one that shouts. */
function statusTone(s: SliceSummary): string {
  if (s.blocked) return 'text-[var(--color-danger)]';
  if (!s.inFlight) return 'text-[var(--color-text-dim)]';
  return 'text-[var(--color-text)]';
}

/**
 * One worker: which slice, where it is running, and how far it has got.
 *
 * The worktree name is on the row because with three slices in flight it is
 * the only thing that distinguishes two workers both sitting in phase 1 — and
 * it is what you need to know before you go and look at one.
 */
function WorkerRow({ slice, onOpen }: { slice: SliceSummary; onOpen(): void }): JSX.Element {
  const where = slice.foreground
    ? 'foreground'
    : slice.worktree
      ? baseName(slice.worktree)
      : slice.branch
        ? baseName(slice.branch)
        : '';

  return (
    <li data-slice={slice.id}>
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left flex flex-col gap-1 px-3 py-3 min-h-[56px] hover:bg-[var(--color-surface-2)]"
      >
        <span className="flex items-center gap-2 min-w-0">
          {slice.blocked && (
            <AlertTriangle
              size={14}
              className="shrink-0 text-[var(--color-danger)]"
              aria-hidden="true"
            />
          )}
          <code className={`font-mono text-sm shrink-0 ${statusTone(slice)}`}>{slice.id}</code>
          {slice.phase && (
            <span className="text-xs font-mono text-[var(--color-text-dim)] shrink-0">
              {slice.step ? `${slice.phase}/${slice.step}` : `ph${slice.phase}`}
            </span>
          )}
          {slice.ticketsTotal !== null && (
            <span className="text-xs font-mono text-[var(--color-text-dim)] shrink-0">
              {slice.ticketsDone ?? 0}/{slice.ticketsTotal}
            </span>
          )}
          {slice.currentTicket && (
            <span className="text-xs font-mono text-[var(--color-text-dim)] truncate">
              {slice.currentTicket}
              {slice.attempt ? ` ·a${slice.attempt}` : ''}
            </span>
          )}
        </span>
        <span className="flex items-center gap-2 min-w-0 text-[0.7rem] text-[var(--color-text-dim)]">
          {where && <span className="font-mono shrink-0">{where}</span>}
          <span className="truncate">
            {slice.blocked ? 'BLOCKED' : (slice.status ?? (slice.inFlight ? '' : 'merged'))}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Everything one slice owns: its state, its tickets, its own artefacts. */
function SliceDetail({
  slice,
  onOpenDoc,
  banner = true,
}: {
  slice: SliceSummary;
  onOpenDoc(path: string): void;
  /** False when the page already carries a blocked banner above this. */
  banner?: boolean;
}): JSX.Element {
  return (
    <div data-testid="slice-detail" data-slice={slice.id} className="flex flex-col gap-4">
      {banner && slice.blocked && (
        <div className="flex items-start gap-2 p-3 rounded-xl border border-[var(--color-danger)] text-sm">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            <strong>BLOCKED.</strong> {slice.id} stopped and is waiting on a decision.
          </span>
        </div>
      )}

      {(slice.status || slice.lastVerdict || slice.worktree) && (
        <Card title={slice.foreground ? 'Worker — foreground' : 'Worker'}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 p-3 m-0 text-xs">
            {slice.status && <Field k="status" v={slice.status} />}
            {slice.worktree && <Field k="worktree" v={slice.worktree} />}
            {slice.branch && <Field k="branch" v={slice.branch} />}
            {slice.lastSync && <Field k="last sync" v={slice.lastSync} />}
            {/* The verdict is prose and routinely the most useful thing on the
                page — it says what actually happened last. Never truncated. */}
            {slice.lastVerdict && <Field k="last verdict" v={slice.lastVerdict} />}
          </dl>
        </Card>
      )}

      {slice.tickets.length > 0 && slice.ticketsDir && (
        <Card
          title={`Tickets — ${slice.tickets.filter((t) => t.status === 'done').length}/${slice.tickets.length} done`}
        >
          <ul className="list-none p-0 m-0 divide-y divide-[var(--color-border)]">
            {slice.tickets.map((t) => (
              <TicketRow
                key={t.id}
                t={t}
                onOpen={() => onOpenDoc(`${slice.ticketsDir}/${t.id}.md`)}
              />
            ))}
          </ul>
        </Card>
      )}

      <ArtefactCard
        title={`Slice ${slice.id}`}
        artefacts={slice.artefacts}
        baseDir={slice.dir}
        onOpen={onOpenDoc}
      />
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="contents">
      <dt className="text-[var(--color-text-dim)] font-mono self-start">{k}</dt>
      <dd className="m-0 font-mono break-words whitespace-pre-wrap">{v}</dd>
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }): JSX.Element {
  if (warnings.length === 0) return <></>;
  return (
    <details className="text-xs text-[var(--color-text-dim)]">
      <summary className="cursor-pointer min-h-[32px] flex items-center">
        Scan warnings ({warnings.length})
      </summary>
      <ul className="list-none p-0 mt-2 m-0 font-mono">
        {warnings.map((w) => (
          <li key={w} className="py-0.5 break-all">
            {w}
          </li>
        ))}
      </ul>
    </details>
  );
}

function PageHeader({
  title,
  subtitle,
  onBack,
}: {
  title: string;
  subtitle: string;
  onBack(): void;
}): JSX.Element {
  return (
    <header className="flex items-center gap-2 px-2 py-2 min-h-[3rem] bg-[var(--color-surface)] border-b border-[var(--color-border)] shrink-0">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] rounded"
      >
        <ArrowLeft size={18} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate text-[var(--color-text)]">{title}</div>
        <code className="block text-[11px] font-mono text-[var(--color-text-dim)] truncate">
          {subtitle}
        </code>
      </div>
    </header>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
      <h2 className="px-3 py-2 text-xs font-bold uppercase tracking-wider text-[var(--color-text-dim)] border-b border-[var(--color-border)]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ArtefactCard({
  title,
  artefacts,
  baseDir,
  onOpen,
}: {
  title: string;
  artefacts: PipelineSummary['artefacts'];
  baseDir: string | null;
  onOpen(path: string): void;
}): JSX.Element {
  if (artefacts.length === 0 || !baseDir) return <></>;
  return (
    <Card title={title}>
      <ul className="list-none p-0 m-0 divide-y divide-[var(--color-border)]">
        {artefacts.map((a) => (
          <li key={a.name}>
            <button
              type="button"
              onClick={() => onOpen(`${baseDir}/${a.name}`)}
              className="w-full text-left flex items-center gap-2 px-3 py-3 min-h-[48px] text-sm hover:bg-[var(--color-surface-2)]"
            >
              <FileText size={15} className="shrink-0 text-[var(--color-text-dim)]" aria-hidden="true" />
              <span className="flex-1 truncate font-mono text-[var(--color-text)]">{a.name}</span>
              {/* Size is a status in its own right: conductor's failure mode
                  was a 184K spec nobody could read. */}
              <span className="text-[0.7rem] text-[var(--color-text-dim)] shrink-0">
                {humanSize(a.size)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TicketRow({ t, onOpen }: { t: TicketSummary; onOpen(): void }): JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left flex items-baseline gap-2 px-3 py-3 min-h-[48px] text-sm hover:bg-[var(--color-surface-2)]"
      >
        <code className="font-mono text-xs shrink-0 text-[var(--color-text)]">{t.id}</code>
        <span className="flex-1 min-w-0 truncate text-[var(--color-text)]">
          {t.title || <em className="text-[var(--color-text-dim)]">no title</em>}
        </span>
        {t.type && (
          <span className="shrink-0 text-[0.65rem] uppercase tracking-wide text-[var(--color-text-dim)]">
            {t.type}
          </span>
        )}
        <span className={`shrink-0 text-[0.65rem] font-mono ${ticketTone(t.status)}`}>
          {t.status ?? '—'}
        </span>
      </button>
    </li>
  );
}
