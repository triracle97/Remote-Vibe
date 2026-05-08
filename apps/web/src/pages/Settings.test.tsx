import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { Settings } from './Settings';
import { useThemeStore } from '../shell/themeStore';

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
});
