import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { ProjectPicker } from './ProjectPicker';
import { useProfileStore } from '../profiles/profileStore';
import { useAccountsStore } from '../../store/accounts';
import { useConnectionStore } from '../../store/connection';
import { useFileExplorerStore } from '../../store/file-explorer';

vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: () => ({ send: vi.fn() }),
}));

describe('ProjectPicker', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useProfileStore.setState({ profiles: [], loading: false });
    useAccountsStore.setState({
      accounts: [],
      selectedAccount: null,
      claudeConfigs: [],
      selectedClaudeConfig: null,
    });
    useConnectionStore.setState({ capabilities: { terminal: false }, allowedDirs: [] });
    useFileExplorerStore.setState({ dirs: {}, expanded: {}, loadingPaths: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it('suggests real projects under the bridge roots, empty dir list initially', () => {
    // Suggestions come from the bridge's own allowedDirs listing, not from a
    // compile-time sample list.
    useConnectionStore.setState({ allowedDirs: ['/Volumes/WDSSD/Code'] });
    useFileExplorerStore.setState({
      dirs: { '/Volumes/WDSSD/Code': [{ name: 'posRN1', kind: 'dir' }] },
    });
    const onPick = vi.fn();
    const { queryAllByTestId, getByLabelText, getByText } = render(
      <ProjectPicker onPick={onPick} onCancel={() => {}} />,
    );

    // Dir list starts empty — suggestions are offered, not pre-selected.
    expect(queryAllByTestId('dir-picker-row')).toHaveLength(0);

    fireEvent.click(getByLabelText('Add /Volumes/WDSSD/Code/posRN1'));
    expect(queryAllByTestId('dir-picker-row')).toHaveLength(1);

    fireEvent.click(getByText('Open'));
    expect(onPick).toHaveBeenCalledWith({
      agent: 'claude',
      dirs: ['/Volumes/WDSSD/Code/posRN1'],
      projectPath: '/Volumes/WDSSD/Code/posRN1',
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
    useConnectionStore.setState({ capabilities: { terminal: false }, allowedDirs: [] });
    useFileExplorerStore.setState({ dirs: {}, expanded: {}, loadingPaths: {} });
    render(<ProjectPicker onPick={() => {}} onCancel={() => {}} />);
    expect(screen.queryByLabelText(/terminal/i)).toBeNull();
  });
});

describe('ProjectPicker Claude profile', () => {
  const CONFIGS = [
    { name: 'default', agent: 'claude' as const, isDefault: true },
    { name: 'claude1', agent: 'claude' as const, isDefault: false },
  ];

  beforeEach(() => {
    window.localStorage.clear();
    useProfileStore.setState({ profiles: [], loading: false });
    useConnectionStore.setState({
      capabilities: { terminal: false },
      allowedDirs: ['/Volumes/WDSSD/Code'],
    });
    useFileExplorerStore.setState({
      dirs: { '/Volumes/WDSSD/Code': [{ name: 'posRN1', kind: 'dir' }] },
      expanded: {},
      loadingPaths: {},
    });
  });
  afterEach(cleanup);

  const pick = (): ReturnType<typeof vi.fn> => {
    const onPick = vi.fn();
    render(<ProjectPicker onPick={onPick} onCancel={() => {}} />);
    fireEvent.click(screen.getByLabelText('Add /Volumes/WDSSD/Code/posRN1'));
    return onPick;
  };

  it('hides the selector when only one profile exists', () => {
    useAccountsStore.setState({
      accounts: [],
      selectedAccount: null,
      claudeConfigs: [CONFIGS[0]!],
      selectedClaudeConfig: 'default',
    });
    render(<ProjectPicker onPick={() => {}} onCancel={() => {}} />);
    expect(screen.queryByLabelText('Claude profile')).toBeNull();
  });

  it('offers every profile once a second one is configured', () => {
    useAccountsStore.setState({
      accounts: [],
      selectedAccount: null,
      claudeConfigs: CONFIGS,
      selectedClaudeConfig: 'default',
    });
    render(<ProjectPicker onPick={() => {}} onCancel={() => {}} />);
    const select = screen.getByLabelText('Claude profile') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['default', 'claude1']);
    expect(select.options[0]!.textContent).toContain('(default)');
  });

  it('sends the chosen profile with the new session', () => {
    useAccountsStore.setState({
      accounts: [],
      selectedAccount: null,
      claudeConfigs: CONFIGS,
      selectedClaudeConfig: 'default',
    });
    const onPick = vi.fn();
    render(<ProjectPicker onPick={onPick} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Claude profile'), { target: { value: 'claude1' } });
    fireEvent.click(screen.getByLabelText('Add /Volumes/WDSSD/Code/posRN1'));
    fireEvent.click(screen.getByText('Open'));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude', claudeConfig: 'claude1' }),
    );
  });

  it('carries the profile through the recents shortcut too', () => {
    // The recents path builds its own payload; it used to drop the account.
    window.localStorage.setItem(
      'mrt.recentProjects',
      JSON.stringify(['/Volumes/WDSSD/Code/posRN1']),
    );
    useAccountsStore.setState({
      accounts: [],
      selectedAccount: null,
      claudeConfigs: CONFIGS,
      selectedClaudeConfig: 'claude1',
    });
    const onPick = vi.fn();
    render(<ProjectPicker onPick={onPick} onCancel={() => {}} />);
    fireEvent.click(screen.getByText('/Volumes/WDSSD/Code/posRN1'));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfig: 'claude1' }),
    );
  });

  it('does not attach a Claude profile to a Codex session', () => {
    useAccountsStore.setState({
      accounts: [],
      selectedAccount: null,
      claudeConfigs: CONFIGS,
      selectedClaudeConfig: 'claude1',
    });
    const onPick = vi.fn();
    render(<ProjectPicker onPick={onPick} onCancel={() => {}} />);
    fireEvent.click(screen.getByLabelText('Codex'));
    fireEvent.click(screen.getByLabelText('Add /Volumes/WDSSD/Code/posRN1'));
    fireEvent.click(screen.getByText('Open'));
    expect(onPick.mock.calls[0]![0]).not.toHaveProperty('claudeConfig');
  });
});
