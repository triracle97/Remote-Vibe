import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface BottomSheetProps {
  open: boolean;
  onClose(): void;
  ariaLabel: string;
  children: ReactNode;
  /** Optional max height as CSS value, defaults to 80vh */
  maxHeight?: string;
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function BottomSheet({
  open,
  onClose,
  ariaLabel,
  children,
  maxHeight = '80vh',
}: BottomSheetProps): JSX.Element {
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
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <motion.button
            type="button"
            data-testid="bottom-sheet-backdrop"
            aria-label="Close"
            className="absolute inset-0 bg-black/55 border-0 p-0 cursor-pointer"
            onClick={onClose}
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="relative bg-[var(--color-surface)] text-[var(--color-text)] border-t border-[var(--color-border)] rounded-t-2xl shadow-2xl overflow-hidden"
            style={{ maxHeight, paddingBottom: 'env(safe-area-inset-bottom)' }}
            initial={reduce ? false : { y: '100%' }}
            animate={{ y: 0 }}
            exit={reduce ? { y: 0 } : { y: '100%' }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            <div className="h-6 w-full flex items-center justify-center">
              <div className="h-1.5 w-12 bg-[var(--color-text-dim)] rounded-full opacity-50" />
            </div>
            <div className="overflow-y-auto" style={{ maxHeight: `calc(${maxHeight} - 1.5rem)` }}>
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
