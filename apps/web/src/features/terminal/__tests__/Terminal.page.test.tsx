import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Terminal } from '../../../pages/Terminal';
import { useTerminalsStore } from '../../../store/terminals';

vi.mock('../../../services/bridge-client-singleton', () => ({
  getBridgeClient: () => ({
    send: () => {},
    on: (_event: string, _fn: unknown) => () => {},
  }),
}));

afterEach(() => cleanup());

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/terminal/:id" element={<Terminal />} />
        <Route path="/sessions" element={<div>SESSIONS_PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Terminal page', () => {
  beforeEach(() => {
    useTerminalsStore.setState({ terminals: {}, order: [] });
  });

  it('redirects to /sessions when termId is unknown', () => {
    renderAt('/terminal/missing');
    expect(screen.getByText('SESSIONS_PAGE')).toBeTruthy();
  });

  it('renders the terminal container when termId exists', () => {
    useTerminalsStore.setState({
      terminals: {
        t1: { termId: 't1', cwd: '/p', createdAt: 1, alive: true },
      },
      order: ['t1'],
    });
    const { container } = renderAt('/terminal/t1');
    // The TerminalView wrapper has a flex flex-col root.
    expect(container.querySelector('.flex.flex-col')).toBeTruthy();
  });
});
