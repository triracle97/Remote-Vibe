import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { List, X } from 'lucide-react';
import { docSections, type OpenDoc } from '../../store/conductor';
import { MarkdownRenderer } from '../markdown/MarkdownRenderer';
import { BottomSheet } from '../../shell/BottomSheet';
import { useIsDesktop } from '../../shell/useIsDesktop';

/**
 * How many sections to render before the rest is revealed by scrolling.
 *
 * The window only ever grows, matching how the transcript behaves. A whole
 * `PATHS.md` is 340 sections of markdown, each with its own parser run — doing
 * that up front locks the main thread for seconds on a phone.
 */
const INITIAL_SECTIONS = 12;
const MORE_SECTIONS = 12;

interface PipelineDocProps {
  doc: OpenDoc;
}

function sectionDomId(i: number): string {
  return `pipeline-doc-section-${i}`;
}

export function PipelineDoc({ doc }: PipelineDocProps): JSX.Element {
  const isDesktop = useIsDesktop();
  const [shown, setShown] = useState(INITIAL_SECTIONS);
  const [tocOpen, setTocOpen] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(
    () => (doc.state === 'text' ? docSections(doc.content) : []),
    [doc],
  );

  // A different document starts at its own top.
  useEffect(() => {
    setShown(INITIAL_SECTIONS);
    setTocOpen(false);
  }, [doc.path]);

  // Reveal more as the bottom comes into view. An observer rather than a
  // scroll handler so it costs nothing while the user is reading still.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || shown >= sections.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown((n) => Math.min(sections.length, n + MORE_SECTIONS));
        }
      },
      { root: scrollRef.current, rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, sections.length]);

  /**
   * Jump to a section, revealing up to it first.
   *
   * Without the reveal, every outline entry past the window would silently do
   * nothing — the element it names does not exist yet. Same reveal-then-jump
   * the transcript outline uses.
   */
  const jumpTo = useCallback(
    (index: number) => {
      setTocOpen(false);
      setShown((n) => (index + 1 > n ? index + 1 + MORE_SECTIONS : n));
      requestAnimationFrame(() => {
        document
          .getElementById(sectionDomId(index))
          ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    },
    [],
  );

  if (doc.state === 'loading') {
    return <p className="p-4 text-sm text-[var(--color-text-dim)]">Loading {doc.name}…</p>;
  }
  if (doc.state === 'error') {
    return <p className="p-4 text-sm text-[var(--color-danger)]">{doc.message}</p>;
  }

  const toc = (
    <nav aria-label="Document outline" className="text-sm">
      <ul className="list-none p-0 m-0">
        {sections.map((s, i) => (
          <li key={`${s.heading}-${i}`}>
            <button
              type="button"
              onClick={() => jumpTo(i)}
              className="w-full text-left px-3 py-1.5 min-h-[36px] rounded hover:bg-[var(--color-surface-2)] text-[var(--color-text-dim)] hover:text-[var(--color-text)] truncate"
              style={{ paddingLeft: `${(Math.max(1, s.level) - 1) * 12 + 12}px` }}
            >
              {s.heading}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Desktop keeps the outline permanently beside the text; a 340-entry
          index is the whole point of being able to navigate PATHS.md. */}
      {isDesktop && sections.length > 1 && (
        <aside className="w-64 shrink-0 border-r border-[var(--color-border)] overflow-y-auto py-2">
          {toc}
        </aside>
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-screen-md w-full mx-auto px-4 py-4">
          {sections.slice(0, shown).map((s, i) => (
            <section key={`${s.heading}-${i}`} id={sectionDomId(i)} className="scroll-mt-4">
              <MarkdownRenderer
                source={`${'#'.repeat(Math.max(1, s.level))} ${s.heading}\n\n${s.body}`}
              />
            </section>
          ))}

          {shown < sections.length && (
            <div ref={sentinelRef} className="py-6 text-center">
              <button
                type="button"
                onClick={() => setShown((n) => Math.min(sections.length, n + MORE_SECTIONS))}
                className="text-xs px-3 py-2 min-h-[36px] rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              >
                {sections.length - shown} more section{sections.length - shown === 1 ? '' : 's'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Phone: the outline is a sheet, reached from a floating button. A
          permanent 64px column would leave nothing for the prose. */}
      {!isDesktop && sections.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => setTocOpen(true)}
            aria-label="Document outline"
            className="fixed bottom-4 right-4 z-30 min-w-[48px] min-h-[48px] rounded-full bg-[var(--color-accent)] text-white shadow-lg flex items-center justify-center"
          >
            <List size={20} aria-hidden="true" />
          </button>
          <BottomSheet
            open={tocOpen}
            onClose={() => setTocOpen(false)}
            ariaLabel="Document outline"
            maxHeight="70dvh"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)]">
              <span className="text-xs uppercase tracking-wide text-[var(--color-text-dim)]">
                {sections.length} sections
              </span>
              <button
                type="button"
                onClick={() => setTocOpen(false)}
                aria-label="Close outline"
                className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)]"
              >
                <X size={18} />
              </button>
            </div>
            <div className="py-2">{toc}</div>
          </BottomSheet>
        </>
      )}
    </div>
  );
}
