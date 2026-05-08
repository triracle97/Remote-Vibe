import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { usePromptHistoryStore } from '../../store/prompt-history';

interface DropdownProps {
  currentProjectPath?: string;
  onPick(text: string): void;
  onClose(): void;
}

export function PromptHistoryDropdown({
  currentProjectPath,
  onPick,
  onClose,
}: DropdownProps): JSX.Element {
  const query = usePromptHistoryStore((s) => s.query);
  const setQuery = usePromptHistoryStore((s) => s.setQuery);
  const showProjectOnly = usePromptHistoryStore((s) => s.showProjectOnly);
  const toggleProjectOnly = usePromptHistoryStore((s) => s.toggleProjectOnly);
  const list = usePromptHistoryStore((s) => s.filtered(currentProjectPath));
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (highlighted >= list.length) setHighlighted(Math.max(0, list.length - 1));
  }, [list.length, highlighted]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(list.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = list[highlighted];
      if (pick) {
        onPick(pick.text);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="prompt-history absolute bottom-full left-0 right-0 mb-2 max-h-[40vh] overflow-y-auto z-30 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-2xl flex flex-col">
      <div className="prompt-history-row flex gap-2 p-2 border-b border-[var(--color-border)] items-center">
        <input
          ref={inputRef}
          className="prompt-history-search flex-1 bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded px-2 py-1 text-sm"
          type="text"
          placeholder="Search prompt history…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <label className="prompt-history-filter flex items-center gap-1 text-xs text-[var(--color-text-dim)]">
          <input
            type="checkbox"
            checked={showProjectOnly}
            onChange={toggleProjectOnly}
          />
          this project only
        </label>
      </div>
      <ul className="prompt-history-list list-none m-0 p-0 overflow-y-auto">
        {list.length === 0 && (
          <li className="prompt-history-empty px-3 py-2 text-sm text-[var(--color-text-dim)] text-center">
            No prompts
          </li>
        )}
        {list.map((p, i) => (
          <li
            key={p.text}
            className={`prompt-history-row-item w-full text-left px-3 py-2 min-h-[44px] cursor-pointer border-b border-[var(--color-border)] last:border-b-0${i === highlighted ? ' bg-[var(--color-surface-2)]' : ' hover:bg-[var(--color-surface-2)]'}`}
            onMouseEnter={() => setHighlighted(i)}
            onClick={() => onPick(p.text)}
          >
            <div className="prompt-history-text text-sm text-[var(--color-text)] whitespace-pre-wrap break-words">{p.text}</div>
            <div className="prompt-history-meta text-xs text-[var(--color-text-dim)] mt-0.5">
              {p.projectPaths.join(', ')} · {p.agents.join(',')}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
