import { useEffect, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface Props {
  children: ReactNode;
  onClose: () => void;
  ariaLabel: string;
}

/**
 * Full-viewport overlay for inspecting a diagram or image.
 *
 * A portal rather than an in-place expansion: the transcript is a scrolling
 * column with clipping ancestors, so an absolutely-positioned overlay inside
 * it would be cropped.
 */
export function FullscreenModal({ children, onClose, ariaLabel }: Props): JSX.Element | null {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className="fixed inset-0 z-50 bg-[var(--color-bg)] flex flex-col"
    >
      <div className="flex justify-end p-2 shrink-0">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="p-2 rounded text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
        >
          <X size={18} aria-hidden />
        </button>
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>,
    document.body,
  );
}
