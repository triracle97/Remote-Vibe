import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { SessionList } from './SessionList';
import type { SessionView } from '../../store/sessions';
import { useSessionsStore } from '../../store/sessions';

vi.mock('../../store/sessions', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../store/sessions')>();
  return {
    ...mod,
    useSessionsStore: {
      ...mod.useSessionsStore,
      getState: vi.fn(),
    },
  };
});

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: 's1',
    agent: 'claude',
    projectPath: '/home/user/project',
    createdAt: 1,
    events: [],
    lastSeq: 0,
    alive: true,
    name: null,
    ...overrides,
  };
}

describe('SessionList', () => {
  it('renders "No active sessions" when list is empty', () => {
    const { container } = render(
      <SessionList sessions={[]} activeId={null} onSelect={() => {}} onNewSession={() => {}} />,
    );
    expect(container.textContent).toMatch(/no active sessions/i);
  });

  it('leads with the name, not the folder, when the session has one', () => {
    const name = 'My Custom Session Name That Is Quite Long';
    const session = makeSession({ name, projectPath: '/Users/me/code/repo' });
    const { container } = render(
      <SessionList sessions={[session]} activeId={null} onSelect={() => {}} onNewSession={() => {}} />,
    );
    const title = container.querySelector('.session-title');
    expect(title).toBeTruthy();
    expect(title!.textContent).toMatch(/My Custom Session Name That Is/);
    // 40-char truncation plus the ellipsis.
    expect(title!.textContent!.length).toBeLessThanOrEqual(41);
    // The folder is no longer the headline...
    expect(title!.textContent).not.toBe('repo');
    // ...but the path stays visible underneath, or you cannot tell which repo.
    expect(container.textContent).toContain('/Users/me/code/repo');
  });

  it('falls back to the folder as the headline when unnamed', () => {
    const session = makeSession({ name: null, projectPath: '/Users/me/code/repo' });
    const { container } = render(
      <SessionList sessions={[session]} activeId={null} onSelect={() => {}} onNewSession={() => {}} />,
    );
    expect(container.querySelector('.session-title')!.textContent).toBe('repo');
    // And the secondary row says so rather than showing a meaningless id.
    expect(container.querySelector('.session-name')!.textContent).toBe('unnamed');
  });

  it('shows the short session id beside the rename control once named', () => {
    const session = makeSession({ sessionId: 'abc123456789', name: 'Named' });
    const { container } = render(
      <SessionList sessions={[session]} activeId={null} onSelect={() => {}} onNewSession={() => {}} />,
    );
    // Two sessions can share a name; the id is what tells them apart.
    expect(container.querySelector('.session-name')!.textContent).toBe('abc12345');
  });

  it('pencil click opens rename inline (does not trigger row select)', () => {
    const renameSession = vi.fn().mockResolvedValue(undefined);
    (useSessionsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ renameSession });
    const onSelect = vi.fn();
    const session = makeSession({ name: 'foo' });

    const { container } = render(
      <SessionList sessions={[session]} activeId={null} onSelect={onSelect} onNewSession={() => {}} />,
    );
    const pencil = container.querySelector('button.session-rename-pencil')!;
    fireEvent.click(pencil);

    // Inline should now be visible
    const inline = container.querySelector('.session-rename-inline');
    expect(inline).toBeTruthy();

    // onSelect must NOT have been called (stopPropagation works)
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('clicking session button calls onSelect', () => {
    const onSelect = vi.fn();
    const session = makeSession();

    const { container } = render(
      <SessionList sessions={[session]} activeId={null} onSelect={onSelect} onNewSession={() => {}} />,
    );
    const btn = container.querySelector('.session-row button')!;
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith('s1');
  });

  it('calls onAfterSelect after selecting a session', () => {
    const onSelect = vi.fn();
    const onAfterSelect = vi.fn();
    const session = makeSession({ sessionId: 's1' });

    const { container } = render(
      <SessionList
        sessions={[session]}
        activeId={null}
        onSelect={onSelect}
        onNewSession={() => {}}
        onAfterSelect={onAfterSelect}
      />,
    );
    const btn = container.querySelector('.session-row button')!;
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith('s1');
    expect(onAfterSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.invocationCallOrder[0]!).toBeLessThan(
      onAfterSelect.mock.invocationCallOrder[0]!,
    );
  });

  it('marks active row when activeId matches', () => {
    const session = makeSession({ sessionId: 's1' });
    const { container } = render(
      <SessionList sessions={[session]} activeId="s1" onSelect={() => {}} onNewSession={() => {}} />,
    );
    const row = container.querySelector('.session-row');
    expect(row?.classList.contains('active')).toBe(true);
  });
});
