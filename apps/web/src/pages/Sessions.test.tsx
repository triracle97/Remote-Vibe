import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { Sessions } from './Sessions';
import { useSessionsStore } from '../store/sessions';

afterEach(() => cleanup());

function ContextWrapper(): JSX.Element {
  const fakeClient = {} as unknown;
  return <Outlet context={{ client: fakeClient }} />;
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/sessions']}>
      <Routes>
        <Route element={<ContextWrapper />}>
          <Route path="/sessions" element={<Sessions />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Sessions page', () => {
  it('shows empty state when no alive sessions', () => {
    useSessionsStore.setState({ sessions: {}, order: [] });
    renderPage();
    expect(screen.getByText(/no active sessions/i)).toBeDefined();
  });
});
