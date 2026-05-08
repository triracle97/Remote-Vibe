import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

afterEach(() => cleanup());

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(
      <Modal open={false} onClose={() => {}} ariaLabel="Test">
        <p>body</p>
      </Modal>
    );
    expect(screen.queryByText('body')).toBeNull();
  });

  it('renders children when open and exposes role=dialog', () => {
    render(
      <Modal open={true} onClose={() => {}} ariaLabel="My Modal">
        <p>body</p>
      </Modal>
    );
    expect(screen.getByText('body')).toBeDefined();
    const dialogs = screen.getAllByRole('dialog');
    const dialog = dialogs[dialogs.length - 1]!;
    expect(dialog.getAttribute('aria-label')).toBe('My Modal');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} ariaLabel="Test">
        <p>body</p>
      </Modal>
    );
    fireEvent.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} ariaLabel="Test">
        <button>x</button>
      </Modal>
    );
    fireEvent.keyDown(screen.getAllByRole('dialog')[0]!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
