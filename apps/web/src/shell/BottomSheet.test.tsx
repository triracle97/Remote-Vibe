import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { BottomSheet } from './BottomSheet';

describe('BottomSheet', () => {
  afterEach(() => cleanup());

  it('renders nothing when closed', () => {
    render(
      <BottomSheet open={false} onClose={() => {}} ariaLabel="Test">
        <div>content</div>
      </BottomSheet>
    );
    expect(screen.queryByText('content')).toBeNull();
  });

  it('renders children when open', () => {
    render(
      <BottomSheet open={true} onClose={() => {}} ariaLabel="Test">
        <div>content</div>
      </BottomSheet>
    );
    expect(screen.getByText('content')).toBeDefined();
  });

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open={true} onClose={onClose} ariaLabel="Test">
        <div>content</div>
      </BottomSheet>
    );
    fireEvent.click(screen.getByTestId('bottom-sheet-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open={true} onClose={onClose} ariaLabel="Test">
        <button>focusable</button>
      </BottomSheet>
    );
    fireEvent.keyDown(screen.getAllByRole('dialog')[0]!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('exposes role="dialog" with aria-modal and aria-label', () => {
    render(
      <BottomSheet open={true} onClose={() => {}} ariaLabel="My Sheet">
        <div>x</div>
      </BottomSheet>
    );
    const dialogs = screen.getAllByRole('dialog');
    const dialog = dialogs[dialogs.length - 1]!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('My Sheet');
  });
});
