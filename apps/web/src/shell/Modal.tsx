import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface ModalProps {
  open: boolean;
  onClose(): void;
  ariaLabel: string;
  children: ReactNode;
  /** Tailwind max-width class, defaults to max-w-md */
  maxWidthClass?: string;
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Modal({
  open,
  onClose,
  ariaLabel,
  children,
  maxWidthClass = 'max-w-md',
}: ModalProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector));
    if (focusable.length === 0) {
      event.preventDefault();
      root.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.button
            type="button"
            data-testid="modal-backdrop"
            aria-label="Close"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm border-0 p-0 cursor-pointer"
            onClick={onClose}
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.18 }}
          />
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className={`relative w-full ${maxWidthClass} bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] rounded-2xl shadow-2xl overflow-hidden`}
            initial={reduce ? false : { scale: 0.92, opacity: 0, y: 16 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={reduce ? { scale: 1, opacity: 1, y: 0 } : { scale: 0.92, opacity: 0, y: 16 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
