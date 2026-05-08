import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { Projects } from './Projects';
import { useProjectsStore } from '../features/projects/projectsStore';

afterEach(() => cleanup());

function ContextWrapper(): JSX.Element {
  return <Outlet context={{ client: {} }} />;
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/projects']}>
      <Routes>
        <Route element={<ContextWrapper />}>
          <Route path="/projects" element={<Projects />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Projects page', () => {
  beforeEach(() => {
    localStorage.clear();
    useProjectsStore.setState({ paths: [] });
  });

  it('shows empty state when no projects', () => {
    renderPage();
    expect(screen.getByText(/no projects yet/i)).toBeDefined();
  });

  it('lists known projects with their paths', () => {
    useProjectsStore.setState({ paths: ['/Volumes/foo/bar', '/Volumes/baz'] });
    renderPage();
    expect(screen.getByText('bar')).toBeDefined();
    expect(screen.getByText('baz')).toBeDefined();
  });

  it('removes a project when delete clicked', () => {
    useProjectsStore.setState({ paths: ['/p1'] });
    renderPage();
    const deleteBtn = screen.getByRole('button', { name: /remove \/p1/i });
    fireEvent.click(deleteBtn);
    expect(useProjectsStore.getState().paths).toEqual([]);
  });
});
