import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { Settings } from './Settings';
import { useThemeStore } from '../shell/themeStore';
import { useAccountsStore } from '../store/accounts';

const sentAccounts: Array<Record<string, unknown>> = [];
vi.mock('../services/bridge-client-singleton', () => ({
  getBridgeClient: () => ({ send: (m: Record<string, unknown>) => sentAccounts.push(m) }),
  hasBridgeClient: () => true,
}));
import { SHORTCUTS } from '../shell/shortcuts';

afterEach(() => cleanup());

function ContextWrapper(): JSX.Element {
  return <Outlet context={{ client: {} }} />;
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route element={<ContextWrapper />}>
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Settings page', () => {
  beforeEach(() => {
    localStorage.clear();
    useThemeStore.setState({ mode: 'system' });
  });

  it('renders Connection, Appearance, and Default agent sections', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /connection/i })).toBeDefined();
    expect(screen.getByRole('heading', { name: /appearance/i })).toBeDefined();
    expect(screen.getByRole('heading', { name: /default agent/i })).toBeDefined();
  });

  it('changes theme mode when a radio is selected', () => {
    renderPage();
    const dark = screen.getByRole('radio', { name: /dark/i });
    fireEvent.click(dark);
    expect(useThemeStore.getState().mode).toBe('dark');
  });

  it('renders Default workspaces section with add input', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /default workspaces/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /add default workspace/i })).toBeDefined();
  });

  it('renders Profiles section with manage button', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /^profiles$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /manage profiles/i })).toBeDefined();
  });

  it('renders Accounts heading', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /accounts/i })).toBeDefined();
  });
});

describe('Settings — keyboard shortcuts', () => {
  it('documents every shortcut on the page, not only behind the ? modal', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );
    expect(screen.getByText('Keyboard shortcuts')).toBeTruthy();
    for (const s of SHORTCUTS) {
      expect(screen.getByText(s.description)).toBeTruthy();
    }
  });

  it('tells you the ? key exists', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );
    expect(screen.getByText(/anywhere outside a text box/i)).toBeTruthy();
  });
});

describe('Settings — Claude profiles', () => {
  beforeEach(() => {
    useAccountsStore.setState({
      accounts: [],
      selectedAccount: null,
      claudeConfigs: [
        { name: 'default', agent: 'claude', isDefault: true, configDir: '/Users/me/.claude' },
        { name: 'alt', agent: 'claude', isDefault: false, configDir: '/Users/me/.claude1' },
      ],
      selectedClaudeConfig: 'default',
    });
    sentAccounts.length = 0;
  });

  function renderSettings() {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );
  }

  it('lists each profile with where it points', () => {
    renderSettings();
    expect(screen.getByText('/Users/me/.claude')).toBeTruthy();
    expect(screen.getByText('/Users/me/.claude1')).toBeTruthy();
  });

  it('adds a profile', () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'work' } });
    fireEvent.change(screen.getByLabelText('Profile config dir'), {
      target: { value: '~/.claude-work' },
    });
    fireEvent.click(screen.getByText('Add'));

    expect(sentAccounts).toContainEqual(
      expect.objectContaining({
        type: 'save_claude_config',
        name: 'work',
        configDir: '~/.claude-work',
      }),
    );
  });

  it('does not send an incomplete profile', () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'work' } });
    fireEvent.click(screen.getByText('Add'));
    expect(sentAccounts).toHaveLength(0);
  });

  it('removes a named profile but never the default', () => {
    renderSettings();
    // The default has nothing to fall back to, so it offers no remove control.
    expect(screen.queryByLabelText('Remove profile default')).toBeNull();

    fireEvent.click(screen.getByLabelText('Remove profile alt'));
    expect(sentAccounts).toContainEqual(
      expect.objectContaining({ type: 'delete_claude_config', name: 'alt' }),
    );
  });
});
