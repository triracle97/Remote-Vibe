import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NavRail, NAV_TABS } from './NavRail';

afterEach(() => cleanup());

/**
 * The routes that earn a tab.
 *
 * Deliberately a literal rather than an import: the job of the first test is to
 * catch a route that the router serves but the nav never links to. `/board` was
 * exactly that — reachable only by typing the URL, and invisible on a phone
 * where there is no address bar in view.
 *
 * `/sessions` is intentionally NOT here. Board is a superset of it and Home
 * previews the live ones, so it keeps its route but loses its tab.
 */
const NAV_ROUTES = ['/', '/board', '/projects', '/settings'];

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <NavRail />
    </MemoryRouter>
  );
}

describe('NavRail', () => {
  it('links to exactly the routes that earn a tab', () => {
    renderAt('/');
    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs.sort()).toEqual([...NAV_ROUTES].sort());
  });

  it('exposes the same tabs the session sheet renders', () => {
    // Session.tsx builds its mobile route row from NAV_TABS, so this is what
    // stops the two navigations drifting apart.
    expect(NAV_TABS.map((t) => t.to)).toEqual(NAV_ROUTES);
  });

  it('marks the current route as aria-current=page', () => {
    renderAt('/projects');
    const projects = screen.getByRole('link', { name: /projects/i });
    expect(projects.getAttribute('aria-current')).toBe('page');
    const home = screen.getByRole('link', { name: /home/i });
    expect(home.getAttribute('aria-current')).toBeNull();
  });

  it('does not light Home up on every route', () => {
    renderAt('/board');
    expect(screen.getByRole('link', { name: /board/i }).getAttribute('aria-current')).toBe('page');
    // `end` on the "/" tab is what makes this true.
    expect(screen.getByRole('link', { name: /home/i }).getAttribute('aria-current')).toBeNull();
  });

  it('gives every tab a touch-sized target', () => {
    renderAt('/');
    for (const { label } of NAV_TABS) {
      const link = screen.getByRole('link', { name: label });
      expect(link.className).toContain('min-h-[52px]');
    }
  });

  it('lays the mobile bar out as equal tracks plus a reserved quota slot', () => {
    renderAt('/');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav.className).toContain(`repeat(${NAV_TABS.length},`);
    // Equal `1fr` tracks, not flex-1 + truncate: the tabs have to stay the same
    // width on a 320px screen. The quota ring gets its own fixed track so that
    // its first appearance mid-session does not resize them.
    // Track count must follow NAV_TABS, or a tab silently overflows the row.
    expect(nav.className).toContain('grid-cols-[repeat(4,minmax(0,1fr))_2.5rem]');
  });
});
