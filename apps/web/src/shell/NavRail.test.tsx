import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NavRail } from './NavRail';

afterEach(() => cleanup());

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <NavRail />
    </MemoryRouter>
  );
}

describe('NavRail', () => {
  it('renders four nav links', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: /home/i })).toBeDefined();
    expect(screen.getByRole('link', { name: /sessions/i })).toBeDefined();
    expect(screen.getByRole('link', { name: /projects/i })).toBeDefined();
    expect(screen.getByRole('link', { name: /settings/i })).toBeDefined();
  });

  it('marks the current route as aria-current=page', () => {
    renderAt('/projects');
    const projects = screen.getByRole('link', { name: /projects/i });
    expect(projects.getAttribute('aria-current')).toBe('page');
    const home = screen.getByRole('link', { name: /home/i });
    expect(home.getAttribute('aria-current')).toBeNull();
  });
});
