import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { ProfileEditor } from './ProfileEditor';
import { useProfileStore } from './profileStore';
import { useAccountsStore } from '../../store/accounts';
import type { Profile } from '../../types/protocol';

vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: () => ({ send: vi.fn() }),
}));

const mk = (over: Partial<Profile> = {}): Profile => ({
  name: 'main',
  agent: 'claude',
  dirs: ['/Users/me/repo'],
  account: null,
  default: false,
  ...over,
});

describe('ProfileEditor', () => {
  beforeEach(() => {
    useProfileStore.setState({ profiles: [], loading: false });
    useAccountsStore.setState({ accounts: [], selectedAccount: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('returns null when open=false', () => {
    const { container } = render(
      <ProfileEditor open={false} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the modal with header and tabs when open', () => {
    const { container } = render(<ProfileEditor open onClose={() => {}} />);
    expect(container.querySelector('.profile-editor-modal')).toBeTruthy();
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.textContent).toBe('Claude');
    expect(tabs[1]?.textContent).toBe('Codex');
  });

  it('shows the empty state when no profiles match the active tab', () => {
    useProfileStore.setState({
      profiles: [mk({ name: 'work', agent: 'codex' })],
    });
    const { container } = render(<ProfileEditor open onClose={() => {}} />);
    expect(container.querySelector('.profile-editor-empty')).toBeTruthy();
  });

  it('lists rows for each matching profile with Edit/Delete/Set-default buttons', () => {
    useProfileStore.setState({
      profiles: [
        mk({ name: 'a', dirs: ['/x'] }),
        mk({ name: 'b', dirs: ['/y'], default: true }),
      ],
    });
    const { getAllByTestId, container } = render(
      <ProfileEditor open onClose={() => {}} />,
    );
    const rows = getAllByTestId('profile-row');
    expect(rows).toHaveLength(2);
    // Row 0: Edit, Set default, Delete (3 buttons)
    const row0Buttons = rows[0]!.querySelectorAll('button');
    expect(row0Buttons.length).toBeGreaterThanOrEqual(3);
    expect(container.querySelectorAll('.profile-editor-default-badge')).toHaveLength(1);
  });

  it('clicking Edit expands inline form with DirPicker', () => {
    useProfileStore.setState({ profiles: [mk({ name: 'a', dirs: ['/x', '/y'] })] });
    const { container, getAllByTestId } = render(
      <ProfileEditor open onClose={() => {}} />,
    );
    const editBtn = getAllByTestId('profile-row')[0]!.querySelector(
      'button[aria-label="edit a"]',
    ) as HTMLButtonElement;
    fireEvent.click(editBtn);
    expect(container.querySelector('.profile-editor-edit')).toBeTruthy();
    expect(container.querySelector('[data-testid="dir-picker"]')).toBeTruthy();
  });

  it('clicking + New profile creates a new draft form for the active agent', () => {
    const { container } = render(<ProfileEditor open onClose={() => {}} />);
    const newBtn = container.querySelector('.profile-editor-new') as HTMLButtonElement;
    fireEvent.click(newBtn);
    expect(container.querySelector('[data-testid="profile-row-new"]')).toBeTruthy();
    expect(container.querySelector('.profile-editor-edit')).toBeTruthy();
  });

  it('switching to Codex tab shows codex profiles only', () => {
    useProfileStore.setState({
      profiles: [
        mk({ name: 'cl', agent: 'claude' }),
        mk({ name: 'cx', agent: 'codex', account: 'acct1' }),
      ],
    });
    const { container, getAllByTestId } = render(
      <ProfileEditor open onClose={() => {}} />,
    );
    expect(getAllByTestId('profile-row')).toHaveLength(1);
    const codexTab = container.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement;
    fireEvent.click(codexTab);
    const rows = getAllByTestId('profile-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toMatch(/cx/);
  });

  it('clicking the X close button calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<ProfileEditor open onClose={onClose} />);
    const closeBtn = container.querySelector('.profile-editor-close') as HTMLButtonElement;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the overlay backdrop calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<ProfileEditor open onClose={onClose} />);
    const overlay = container.querySelector('.profile-editor-overlay') as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a validation error when saving a draft with no name', async () => {
    const { container } = render(<ProfileEditor open onClose={() => {}} />);
    fireEvent.click(container.querySelector('.profile-editor-new') as HTMLButtonElement);
    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    expect(container.querySelector('.profile-editor-error')?.textContent).toMatch(/name/i);
  });

  it('Set default button is disabled when profile is already default', () => {
    useProfileStore.setState({
      profiles: [mk({ name: 'a', default: true })],
    });
    const { getAllByTestId } = render(<ProfileEditor open onClose={() => {}} />);
    const row = getAllByTestId('profile-row')[0]!;
    const setDefaultBtn = row.querySelector(
      'button[aria-label="set a as default"]',
    ) as HTMLButtonElement;
    expect(setDefaultBtn.disabled).toBe(true);
  });

  it('Delete button asks for confirmation and calls store.delete on confirm', async () => {
    useProfileStore.setState({ profiles: [mk({ name: 'a' })] });
    const removeMock = vi.fn().mockResolvedValue(undefined);
    useProfileStore.setState({ delete: removeMock });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { getAllByTestId } = render(<ProfileEditor open onClose={() => {}} />);
    const delBtn = getAllByTestId('profile-row')[0]!.querySelector(
      'button[aria-label="delete a"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(delBtn);
    });
    expect(confirmSpy).toHaveBeenCalled();
    expect(removeMock).toHaveBeenCalledWith('a', 'claude');
    confirmSpy.mockRestore();
  });
});
