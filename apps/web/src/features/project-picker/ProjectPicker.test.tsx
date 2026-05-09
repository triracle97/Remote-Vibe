import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { ProjectPicker } from './ProjectPicker';
import { useProfileStore } from '../profiles/profileStore';
import { useAccountsStore } from '../../store/accounts';
import { useConnectionStore } from '../../store/connection';

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
    useConnectionStore.setState({ capabilities: { terminal: false } });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows default workspaces as tappable suggestions, empty dir list initially', () => {
    const onPick = vi.fn();
    const { queryAllByTestId, getByLabelText, getByText } = render(
      <ProjectPicker onPick={onPick} onCancel={() => {}} />,
    );

    // Dir list starts empty — defaults are now suggestions, not pre-selected.
    expect(queryAllByTestId('dir-picker-row')).toHaveLength(0);

    // Tap the first suggestion to add it.
    fireEvent.click(getByLabelText(`Add ${DEFAULT_DIRS[0]}`));
    expect(queryAllByTestId('dir-picker-row')).toHaveLength(1);

    fireEvent.click(getByText('Open'));
    expect(onPick).toHaveBeenCalledWith({
      agent: 'claude',
      dirs: [DEFAULT_DIRS[0]],
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

  it('shows Terminal radio when capabilities.terminal is true', () => {
    useConnectionStore.setState({ capabilities: { terminal: true } });
    render(<ProjectPicker onPick={() => {}} onCancel={() => {}} />);
    expect(screen.getByLabelText(/terminal/i)).toBeTruthy();
  });

  it('hides Terminal radio when capabilities.terminal is false', () => {
    useConnectionStore.setState({ capabilities: { terminal: false } });
    render(<ProjectPicker onPick={() => {}} onCancel={() => {}} />);
    expect(screen.queryByLabelText(/terminal/i)).toBeNull();
  });
});
