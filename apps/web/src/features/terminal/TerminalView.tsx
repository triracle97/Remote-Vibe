import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTerminalSession } from './useTerminalSession';
import { TerminalHelperBar } from './TerminalHelperBar';
import { useTerminalsStore } from '../../store/terminals';

interface Props {
  termId: string;
}

export function TerminalView({ termId }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const removeFromStore = useTerminalsStore((s) => s.remove);

  const session = useTerminalSession({
    termId,
    onData: (s) => xtermRef.current?.write(s),
    onExit: (code) => {
      xtermRef.current?.write(`\r\n\x1b[33m[process exited code=${code ?? '?'}]\x1b[0m\r\n`);
    },
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 14,
      cursorBlink: true,
      theme: {
        background: getCss('--color-bg') ?? '#000',
        foreground: getCss('--color-text') ?? '#eee',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    xtermRef.current = term;
    fitRef.current = fit;

    const onTermData = term.onData((d) => session.sendInput(d));

    const ro = new ResizeObserver(() => {
      // Debounce — fit + resize event are cheap but ResizeObserver fires fast.
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        try {
          fit.fit();
          session.resize(term.cols, term.rows);
        } catch { /* ignore (offscreen) */ }
      }, 100);
    });
    let resizeTimer = 0;
    ro.observe(container);

    term.focus();

    return () => {
      ro.disconnect();
      window.clearTimeout(resizeTimer);
      onTermData.dispose();
      term.dispose();
      removeFromStore(termId);
    };
    // session is intentionally captured once; sendInput/resize identities can change but we want one-time setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div ref={containerRef} className="flex-1 min-h-0 bg-[var(--color-bg)] p-1" />
      <TerminalHelperBar onSend={(d) => session.sendInput(d)} />
    </div>
  );
}

function getCss(varName: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v.length > 0 ? v : undefined;
}
