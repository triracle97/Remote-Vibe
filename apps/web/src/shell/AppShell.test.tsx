import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AppShell } from './AppShell';

afterEach(() => cleanup());

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/sessions" element={<div>SESSIONS</div>} />
          <Route path="/projects" element={<div>PROJECTS</div>} />
          <Route path="/settings" element={<div>SETTINGS</div>} />
          <Route path="/session/:id" element={<div>CHAT</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('AppShell', () => {
  it('renders nav and outlet content for /', () => {
    renderAt('/');
    expect(screen.getByRole('navigation', { name: /primary/i })).toBeDefined();
    expect(screen.getByText('HOME')).toBeDefined();
  });

  it('renders nav and outlet content for /settings', () => {
    renderAt('/settings');
    expect(screen.getByText('SETTINGS')).toBeDefined();
  });
});
