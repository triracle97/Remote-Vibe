import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { usePromptHistoryStore } from '../../store/prompt-history';
import './PromptHistoryDropdown.css';

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
    <div className="prompt-history">
      <div className="prompt-history-row">
        <input
          ref={inputRef}
          className="prompt-history-search"
          type="text"
          placeholder="Search prompt history…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <label className="prompt-history-filter">
          <input
            type="checkbox"
            checked={showProjectOnly}
            onChange={toggleProjectOnly}
          />
          this project only
        </label>
      </div>
      <ul className="prompt-history-list">
        {list.length === 0 && <li className="prompt-history-empty">No prompts</li>}
        {list.map((p, i) => (
          <li
            key={p.text}
            className={`prompt-history-row-item${i === highlighted ? ' active' : ''}`}
            onMouseEnter={() => setHighlighted(i)}
            onClick={() => onPick(p.text)}
          >
            <div className="prompt-history-text">{p.text}</div>
            <div className="prompt-history-meta">
              {p.projectPaths.join(', ')} · {p.agents.join(',')}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
