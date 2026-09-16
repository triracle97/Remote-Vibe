import { useEffect, type ReactNode } from 'react';
import { useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, FileText } from 'lucide-react';
import type { AppShellOutletContext } from '../shell/AppShell';
import type { PipelineSummary, TicketSummary } from '../types/protocol';
import { useConductorStore, selectTiedPipeline, pipelineBadgeLabel } from '../store/conductor';
import { useConnectionStore } from '../store/connection';
import { PipelineDoc } from '../features/conductor/PipelineDoc';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fields worth pulling to the top. Everything else still renders below. */
const HEADLINE_KEYS = ['phase', 'step', 'slice', 'slices_done', 'slices_total'];

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
 * The conductor pipeline, as a page rather than a drawer.
 *
 * It started as a slide-out panel, which was wrong for the content: these
 * artefacts run to 184K and 300K, and a 28rem column with a section dropdown
 * is not somewhere anyone reads a spec. One surface, full width, with the
 * browser's own back button doing the navigating.
 *
 * `?doc=<abs path>` selects a document. Keeping it in the URL rather than in
 * component state is what makes back work, and what makes a doc linkable.
 */
export function Conductor(): JSX.Element {
  const { client } = useOutletContext<AppShellOutletContext>();
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const docPath = params.get('doc');

  const connStatus = useConnectionStore((s) => s.status);
  const pipelines = useConductorStore((s) => s.pipelines);
  const loaded = useConductorStore((s) => s.loaded);
  const warnings = useConductorStore((s) => s.warnings);
  const pinnedSlug = useConductorStore((s) => s.pinnedSlug);
  const pin = useConductorStore((s) => s.pin);
  const agentSlug = useConductorStore((s) => (id ? s.agentTie[id] ?? null : null));
  const requestPipelines = useConductorStore((s) => s.requestPipelines);
  const doc = useConductorStore((s) => s.doc);
  const openDoc = useConductorStore((s) => s.openDoc);
  const closeDoc = useConductorStore((s) => s.closeDoc);

  const pipeline = selectTiedPipeline(pipelines, { pinnedSlug, agentSlug });

  // Reloading straight onto this URL, or opening it in a new tab, arrives with
  // an empty store — so the page asks for its own data rather than assuming
  // the session page already did.
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

  const openDocPath = (path: string): void => setParams({ doc: path });
  const backToOverview = (): void => setParams({});

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
        <PageHeader title={doc.name} subtitle={pipeline.slug} onBack={backToOverview} />
        <PipelineDoc doc={doc} />
      </div>
    );
  }

  const sliceDir = pipeline.slice ? `${pipeline.dir}/slices/${pipeline.slice}` : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PageHeader
        title={pipeline.slug}
        subtitle={pipelineBadgeLabel(pipeline)}
        onBack={() => navigate(`/session/${id}`)}
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-screen-md w-full mx-auto p-4 flex flex-col gap-4">
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
                <code className="font-mono text-[var(--color-text)]">{pipeline.worktree}</code>.
                Normal when the skill runs from the main checkout, but check it is the work you
                meant.
              </span>
            </div>
          )}

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
                onChange={(e) => pin(e.target.value)}
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

          <Card title="State">
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

          {pipeline.tickets.length > 0 && pipeline.ticketsDir && (
            <Card
              title={`Tickets — ${pipeline.tickets.filter((t) => t.status === 'done').length}/${pipeline.tickets.length} done`}
            >
              <ul className="list-none p-0 m-0 divide-y divide-[var(--color-border)]">
                {pipeline.tickets.map((t) => (
                  <TicketRow
                    key={t.id}
                    t={t}
                    onOpen={() => openDocPath(`${pipeline.ticketsDir}/${t.id}.md`)}
                  />
                ))}
              </ul>
            </Card>
          )}

          <ArtefactCard
            title={pipeline.slice ? `Slice ${pipeline.slice}` : 'Slice'}
            artefacts={pipeline.sliceArtefacts}
            baseDir={sliceDir}
            onOpen={openDocPath}
          />
          <ArtefactCard
            title="Pipeline"
            artefacts={pipeline.artefacts}
            baseDir={pipeline.dir}
            onOpen={openDocPath}
          />

          {warnings.length > 0 && (
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
          )}

          <p className="text-[11px] text-[var(--color-text-dim)] font-mono break-all">
            {pipeline.dir}
          </p>
        </div>
      </div>
    </div>
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
