import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ProjectPicker } from './ProjectPicker';
import { useProfileStore } from '../profiles/profileStore';
import { useAccountsStore } from '../../store/accounts';

vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: () => ({ send: vi.fn() }),
}));

const DEFAULT_DIRS = [
  '/Volumes/WDSSD/Code/storybook-solid-js',
  '/Volumes/WDSSD/Code/posRN1',
  '/Volumes/WDSSD/Code/customer-management',
];

describe('ProjectPicker', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useProfileStore.setState({ profiles: [], loading: false });
    useAccountsStore.setState({ accounts: [], selectedAccount: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('prefills the default workspace dirs for a new session', () => {
    const onPick = vi.fn();
    const { getAllByTestId, getByText } = render(
      <ProjectPicker onPick={onPick} onCancel={() => {}} />,
    );

    const rows = getAllByTestId('dir-picker-row');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.textContent)).toEqual(
      DEFAULT_DIRS.map((dir) => expect.stringContaining(dir)),
    );

    fireEvent.click(getByText('Open'));
    expect(onPick).toHaveBeenCalledWith({
      agent: 'claude',
      dirs: DEFAULT_DIRS,
      projectPath: DEFAULT_DIRS[0],
    });
  });

  it('lets a saved default profile override the hardcoded default dirs', () => {
    useProfileStore.setState({
      profiles: [
        {
          name: 'saved',
          agent: 'claude',
          dirs: ['/Users/me/saved-primary', '/Users/me/saved-extra'],
          account: null,
          default: true,
        },
      ],
      loading: false,
    });

    const { getAllByTestId } = render(
      <ProjectPicker onPick={() => {}} onCancel={() => {}} />,
    );

    const rows = getAllByTestId('dir-picker-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('/Users/me/saved-primary');
    expect(rows[1]?.textContent).toContain('/Users/me/saved-extra');
  });
});
