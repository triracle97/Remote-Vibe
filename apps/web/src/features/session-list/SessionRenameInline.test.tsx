import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { SessionRenameInline } from './SessionRenameInline';
import { useSessionsStore } from '../../store/sessions';

vi.mock('../../store/sessions', () => ({
  useSessionsStore: {
    getState: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionRenameInline', () => {
  it('renders input pre-filled with initialName', () => {
    const renameSession = vi.fn().mockResolvedValue(undefined);
    (useSessionsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ renameSession });

    const { container } = render(
      <SessionRenameInline sessionId="s1" initialName="My Session" onClose={() => {}} />,
    );
    const input = container.querySelector('input.session-rename-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe('My Session');
  });

  it('Save button calls renameSession and then onClose on success', async () => {
    const renameSession = vi.fn().mockResolvedValue(undefined);
    (useSessionsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ renameSession });
    const onClose = vi.fn();

    const { container } = render(
      <SessionRenameInline sessionId="s1" initialName="Old Name" onClose={onClose} />,
    );
    const input = container.querySelector('input.session-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New Name' } });

    const saveBtn = container.querySelector('button.session-rename-save')!;
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(renameSession).toHaveBeenCalledWith('s1', 'New Name');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Enter key submits and calls renameSession', async () => {
    const renameSession = vi.fn().mockResolvedValue(undefined);
    (useSessionsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ renameSession });
    const onClose = vi.fn();

    const { container } = render(
      <SessionRenameInline sessionId="s1" initialName="Name" onClose={onClose} />,
    );
    const input = container.querySelector('input.session-rename-input')!;
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(renameSession).toHaveBeenCalledWith('s1', 'Name');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape key calls onClose without saving', () => {
    const renameSession = vi.fn().mockResolvedValue(undefined);
    (useSessionsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ renameSession });
    const onClose = vi.fn();

    const { container } = render(
      <SessionRenameInline sessionId="s1" initialName="Name" onClose={onClose} />,
    );
    const input = container.querySelector('input.session-rename-input')!;
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(renameSession).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel button calls onClose without saving', () => {
    const renameSession = vi.fn().mockResolvedValue(undefined);
    (useSessionsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ renameSession });
    const onClose = vi.fn();

    const { container } = render(
      <SessionRenameInline sessionId="s1" initialName="Name" onClose={onClose} />,
    );
    const cancelBtn = container.querySelector('button.session-rename-cancel')!;
    fireEvent.click(cancelBtn);

    expect(renameSession).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows error message when renameSession rejects', async () => {
    const renameSession = vi.fn().mockRejectedValue({ message: 'session_name_invalid: too long' });
    (useSessionsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ renameSession });
    const onClose = vi.fn();

    const { container } = render(
      <SessionRenameInline sessionId="s1" initialName="Name" onClose={onClose} />,
    );
    const saveBtn = container.querySelector('button.session-rename-save')!;
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    const errorSpan = container.querySelector('span.session-rename-error');
    expect(errorSpan).toBeTruthy();
    expect(errorSpan!.textContent).toMatch(/session_name_invalid: too long/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows error when empty name is submitted', async () => {
    const renameSession = vi.fn().mockResolvedValue(undefined);
    (useSessionsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ renameSession });

    const { container } = render(
      <SessionRenameInline sessionId="s1" initialName="" onClose={() => {}} />,
    );
    const saveBtn = container.querySelector('button.session-rename-save')!;
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    const errorSpan = container.querySelector('span.session-rename-error');
    expect(errorSpan).toBeTruthy();
    expect(errorSpan!.textContent).toMatch(/cannot be empty/i);
    expect(renameSession).not.toHaveBeenCalled();
  });
});
