import { describe, it, expect, beforeEach, vi } from 'vitest';
import { allTags, groupByPhase, matchesFilter, useBoardStore, type BoardFilter } from './boardStore';
import { cardVisualState, projectLabel, timeAgo } from './cardState';
import type { BoardSession, ClientMsg } from '../../types/protocol';

const sent: ClientMsg[] = [];
vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: () => ({
    send: (m: ClientMsg) => {
      sent.push(m);
    },
  }),
}));

function card(over: Partial<BoardSession> = {}): BoardSession {
  return {
    sessionId: 's1',
    agent: 'claude',
    projectPath: '/Volumes/Code/thing',
    additionalDirs: [],
    createdAt: 1000,
    lastActiveAt: 1000,
    endedAt: null,
    name: 'do the thing',
    namePinned: false,
    status: 'ended',
    alive: false,
    phase: 'planning',
    phasePinned: false,
    tags: [],
    archived: false,
    account: null,
    claudeConfigDir: null,
    headroom: false,
    resumable: false,
    model: null,
    effort: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      turns: 0,
    },
    ...over,
  };
}

const FILTER: BoardFilter = { search: '', tags: [], showDone: true, showArchived: false };

beforeEach(() => {
  sent.length = 0;
  useBoardStore.setState({ cards: {}, loaded: false, filter: FILTER, error: null });
});

describe('matchesFilter', () => {
  it('hides archived cards unless asked', () => {
    const c = card({ archived: true });
    expect(matchesFilter(c, FILTER)).toBe(false);
    expect(matchesFilter(c, { ...FILTER, showArchived: true })).toBe(true);
  });

  it('hides done cards when showDone is off', () => {
    const c = card({ phase: 'done' });
    expect(matchesFilter(c, FILTER)).toBe(true);
    expect(matchesFilter(c, { ...FILTER, showDone: false })).toBe(false);
  });

  it('requires every selected tag, not any', () => {
    const c = card({ tags: ['api'] });
    expect(matchesFilter(c, { ...FILTER, tags: ['api'] })).toBe(true);
    expect(matchesFilter(c, { ...FILTER, tags: ['api', 'bug'] })).toBe(false);
  });

  it('searches name, path and tags case-insensitively', () => {
    const c = card({ name: 'Fix Parser', projectPath: '/a/widgets', tags: ['urgent'] });
    for (const q of ['fix', 'PARSER', 'widgets', 'urg']) {
      expect(matchesFilter(c, { ...FILTER, search: q })).toBe(true);
    }
    expect(matchesFilter(c, { ...FILTER, search: 'nomatch' })).toBe(false);
  });

  it('does not crash on an unnamed card', () => {
    expect(matchesFilter(card({ name: null }), { ...FILTER, search: 'x' })).toBe(false);
  });
});

describe('groupByPhase', () => {
  it('buckets by phase and puts live sessions first', () => {
    const cards = {
      a: card({ sessionId: 'a', phase: 'planning', alive: false, lastActiveAt: 500 }),
      b: card({ sessionId: 'b', phase: 'planning', alive: true, lastActiveAt: 1 }),
      c: card({ sessionId: 'c', phase: 'done', alive: false, lastActiveAt: 9 }),
    };
    const g = groupByPhase(cards, FILTER);
    // 'b' is older but running — a running session is what you want to click.
    expect(g.get('planning')!.map((s) => s.sessionId)).toEqual(['b', 'a']);
    expect(g.get('done')!.map((s) => s.sessionId)).toEqual(['c']);
  });

  it('sorts by recency within the same liveness', () => {
    const cards = {
      old: card({ sessionId: 'old', lastActiveAt: 1 }),
      new: card({ sessionId: 'new', lastActiveAt: 99 }),
    };
    expect(groupByPhase(cards, FILTER).get('planning')!.map((s) => s.sessionId)).toEqual([
      'new',
      'old',
    ]);
  });

  it('omits filtered-out cards entirely', () => {
    const cards = { a: card({ archived: true }) };
    expect(groupByPhase(cards, FILTER).size).toBe(0);
  });
});

describe('allTags', () => {
  it('orders by usage then alphabetically', () => {
    const cards = {
      a: card({ sessionId: 'a', tags: ['api', 'bug'] }),
      b: card({ sessionId: 'b', tags: ['api'] }),
      c: card({ sessionId: 'c', tags: ['zeta', 'bug'] }),
    };
    expect(allTags(cards)).toEqual(['api', 'bug', 'zeta']);
  });
});

describe('board store server messages', () => {
  it('hydrates from all_sessions', () => {
    useBoardStore.getState().applyServerMsg({
      type: 'all_sessions',
      sessions: [card({ sessionId: 'x' })],
    });
    expect(useBoardStore.getState().loaded).toBe(true);
    expect(useBoardStore.getState().cards.x).toBeDefined();
  });

  it('marks a card live on session_created and dead on session_ended', () => {
    useBoardStore.setState({ cards: { x: card({ sessionId: 'x' }) } });
    useBoardStore.getState().applyServerMsg({
      type: 'system',
      event: 'session_created',
      sessionId: 'x',
      seq: 1,
    });
    expect(useBoardStore.getState().cards.x!.alive).toBe(true);
    useBoardStore.getState().applyServerMsg({
      type: 'system',
      event: 'session_ended',
      sessionId: 'x',
      seq: 2,
    });
    expect(useBoardStore.getState().cards.x!.alive).toBe(false);
    expect(useBoardStore.getState().cards.x!.status).toBe('ended');
  });

  it('re-fetches rather than inventing a card for an unknown session', () => {
    useBoardStore.getState().applyServerMsg({
      type: 'system',
      event: 'session_created',
      sessionId: 'unknown',
      seq: 1,
    });
    expect(sent).toContainEqual({ type: 'list_all_sessions', includeArchived: false });
    expect(useBoardStore.getState().cards.unknown).toBeUndefined();
  });

  it('ignores messages about sessions it does not know', () => {
    useBoardStore.getState().applyServerMsg({
      type: 'session_tags_changed',
      sessionId: 'ghost',
      tags: ['x'],
    });
    expect(useBoardStore.getState().cards).toEqual({});
  });

  it('drops a deleted card', () => {
    useBoardStore.setState({ cards: { x: card({ sessionId: 'x' }) } });
    useBoardStore.getState().applyServerMsg({ type: 'session_deleted', sessionId: 'x' });
    expect(useBoardStore.getState().cards.x).toBeUndefined();
  });

  it('applies a rename', () => {
    useBoardStore.setState({ cards: { x: card({ sessionId: 'x', name: 'old' }) } });
    useBoardStore.getState().applyServerMsg({
      type: 'session_renamed',
      sessionId: 'x',
      name: 'new',
      correlationId: '',
    });
    expect(useBoardStore.getState().cards.x!.name).toBe('new');
  });
});

describe('board store optimistic mutations', () => {
  it('moves the card immediately and pins it', () => {
    useBoardStore.setState({ cards: { x: card({ sessionId: 'x', phase: 'planning' }) } });
    useBoardStore.getState().setPhase('x', 'verifying');
    expect(useBoardStore.getState().cards.x!.phase).toBe('verifying');
    expect(useBoardStore.getState().cards.x!.phasePinned).toBe(true);
    expect(sent[0]).toMatchObject({ type: 'set_session_phase', sessionId: 'x', phase: 'verifying' });
  });

  it('rolls the phase back and reports why when the bridge rejects it', () => {
    useBoardStore.setState({ cards: { x: card({ sessionId: 'x', phase: 'planning' }) } });
    useBoardStore.getState().setPhase('x', 'done');
    const correlationId = (sent[0] as { correlationId: string }).correlationId;
    useBoardStore.getState().applyServerMsg({
      type: 'error',
      code: 'session_not_found',
      message: 'gone',
      correlationId,
    });
    expect(useBoardStore.getState().cards.x!.phase).toBe('planning');
    expect(useBoardStore.getState().cards.x!.phasePinned).toBe(false);
    expect(useBoardStore.getState().error).toBe('gone');
  });

  it('restores a deleted card when deletion fails', () => {
    useBoardStore.setState({ cards: { x: card({ sessionId: 'x', name: 'keepme' }) } });
    useBoardStore.getState().remove('x');
    expect(useBoardStore.getState().cards.x).toBeUndefined();
    const correlationId = (sent[0] as { correlationId: string }).correlationId;
    useBoardStore.getState().applyServerMsg({
      type: 'error',
      code: 'session_not_found',
      message: 'nope',
      correlationId,
    });
    expect(useBoardStore.getState().cards.x).toBeDefined();
    expect(useBoardStore.getState().cards.x!.name).toBe('keepme');
    expect(useBoardStore.getState().error).toBe('nope');
  });

  it('ignores an unrelated error rather than rolling something back', () => {
    useBoardStore.setState({ cards: { x: card({ sessionId: 'x', phase: 'planning' }) } });
    useBoardStore.getState().setPhase('x', 'done');
    useBoardStore.getState().applyServerMsg({
      type: 'error',
      code: 'agent_not_installed',
      message: 'unrelated',
      correlationId: 'someone-elses-id',
    });
    expect(useBoardStore.getState().cards.x!.phase).toBe('done');
    expect(useBoardStore.getState().error).toBeNull();
  });

  it('re-fetches when archived visibility is toggled', () => {
    useBoardStore.getState().setFilter({ showArchived: true });
    expect(sent).toContainEqual({ type: 'list_all_sessions', includeArchived: true });
  });

  it('does not re-fetch for a plain search change', () => {
    useBoardStore.getState().setFilter({ search: 'abc' });
    expect(sent).toHaveLength(0);
  });

  it('toggles a tag on and off', () => {
    useBoardStore.getState().toggleTag('api');
    expect(useBoardStore.getState().filter.tags).toEqual(['api']);
    useBoardStore.getState().toggleTag('api');
    expect(useBoardStore.getState().filter.tags).toEqual([]);
  });
});

describe('cardState', () => {
  it('reads a dead session as idle regardless of hints', () => {
    expect(cardVisualState(card({ alive: false }), { processing: true }).state).toBe('idle');
  });

  it('prefers running over unread', () => {
    const info = cardVisualState(card({ alive: true }), { processing: true, unread: true });
    expect(info.state).toBe('running');
    expect(info.spin).toBe(true);
  });

  it('reads a live but quiet session as waiting on the human', () => {
    expect(cardVisualState(card({ alive: true }), {}).state).toBe('waiting');
  });
});

describe('turnRunning tracking', () => {
  const stateOf = (): boolean | undefined => useBoardStore.getState().cards['s1']?.turnRunning;

  beforeEach(() => {
    useBoardStore.setState({
      cards: { s1: card({ sessionId: 's1', alive: true, status: 'live', turnRunning: false }) },
      loaded: true,
    });
  });

  it('opens a turn on user input and closes it on result', () => {
    const store = useBoardStore.getState();
    store.applyServerMsg({ type: 'user', sessionId: 's1', seq: 2, payload: { text: 'go' } });
    expect(stateOf()).toBe(true);

    store.applyServerMsg({ type: 'assistant', sessionId: 's1', seq: 3, payload: { text: 'ok' } });
    expect(stateOf()).toBe(true);

    store.applyServerMsg({ type: 'result', sessionId: 's1', seq: 4, payload: {} });
    expect(stateOf()).toBe(false);
  });

  it('closes the turn when the session ends', () => {
    const store = useBoardStore.getState();
    store.applyServerMsg({ type: 'user', sessionId: 's1', seq: 2, payload: { text: 'go' } });
    store.applyServerMsg({
      type: 'system',
      event: 'session_ended',
      sessionId: 's1',
      seq: 5,
      exitCode: 0,
    });
    expect(stateOf()).toBe(false);
    expect(useBoardStore.getState().cards['s1']!.alive).toBe(false);
  });

  it('leaves mid-turn traffic on a dead-looking card as running, and revives it', () => {
    useBoardStore.setState({
      cards: { s1: card({ sessionId: 's1', alive: false, status: 'ended' }) },
    });
    useBoardStore
      .getState()
      .applyServerMsg({ type: 'user', sessionId: 's1', seq: 2, payload: { text: 'go' } });
    const c = useBoardStore.getState().cards['s1']!;
    expect(c.alive).toBe(true);
    expect(c.turnRunning).toBe(true);
  });
});

describe('timeAgo', () => {
  it('compresses to a scannable unit', () => {
    const now = 1_000_000_000;
    expect(timeAgo(now, now)).toBe('now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h');
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d');
    expect(timeAgo(now - 14 * 86_400_000, now)).toBe('2w');
  });

  it('never shows a negative age for a clock skew', () => {
    expect(timeAgo(2000, 1000)).toBe('now');
  });
});

describe('projectLabel', () => {
  it('uses the last path segment', () => {
    expect(projectLabel('/Volumes/WDSSD/Code/thing')).toBe('thing');
    expect(projectLabel('/Volumes/WDSSD/Code/thing/')).toBe('thing');
  });
});

describe('archivePhase', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('archives every card in the column and reports the count', () => {
    useBoardStore.setState({
      cards: {
        a: card({ sessionId: 'a', phase: 'done' }),
        b: card({ sessionId: 'b', phase: 'done' }),
        c: card({ sessionId: 'c', phase: 'implementing' }),
      },
    });

    expect(useBoardStore.getState().archivePhase('done')).toBe(2);

    const state = useBoardStore.getState();
    expect(state.cards.a!.archived).toBe(true);
    expect(state.cards.b!.archived).toBe(true);
    // A card in another column is none of its business.
    expect(state.cards.c!.archived).toBe(false);
  });

  it('sends one archive_session per card', () => {
    useBoardStore.setState({
      cards: {
        a: card({ sessionId: 'a', phase: 'done' }),
        b: card({ sessionId: 'b', phase: 'done' }),
      },
    });
    useBoardStore.getState().archivePhase('done');

    const archives = sent.filter((m) => (m as { type: string }).type === 'archive_session');
    expect(archives).toHaveLength(2);
    expect(archives.every((m) => (m as { archived: boolean }).archived === true)).toBe(true);
    // Distinct correlation ids, so one rejection rolls back only its own card.
    const ids = archives.map((m) => (m as { correlationId: string }).correlationId);
    expect(new Set(ids).size).toBe(2);
  });

  it('does nothing, and sends nothing, for an empty column', () => {
    useBoardStore.setState({ cards: { c: card({ sessionId: 'c', phase: 'planning' }) } });
    expect(useBoardStore.getState().archivePhase('done')).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('skips cards already archived', () => {
    useBoardStore.setState({
      cards: {
        a: card({ sessionId: 'a', phase: 'done', archived: true }),
        b: card({ sessionId: 'b', phase: 'done' }),
      },
    });
    expect(useBoardStore.getState().archivePhase('done')).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('leaves cards hidden by the current filter alone', () => {
    // Archiving something the user cannot see would be a surprise they have no
    // way to notice, let alone undo.
    useBoardStore.setState({
      cards: {
        a: card({ sessionId: 'a', phase: 'done', tags: ['api'] }),
        b: card({ sessionId: 'b', phase: 'done', tags: ['ui'] }),
      },
      filter: { ...useBoardStore.getState().filter, tags: ['api'] },
    });

    expect(useBoardStore.getState().archivePhase('done')).toBe(1);
    expect(useBoardStore.getState().cards.a!.archived).toBe(true);
    expect(useBoardStore.getState().cards.b!.archived).toBe(false);
  });

  it('rolls a card back when the bridge rejects its archive', () => {
    useBoardStore.setState({ cards: { a: card({ sessionId: 'a', phase: 'done' }) } });
    useBoardStore.getState().archivePhase('done');
    const correlationId = (sent[0] as { correlationId: string }).correlationId;

    useBoardStore.getState().applyServerMsg({
      type: 'error',
      code: 'session_not_found',
      message: 'gone',
      correlationId,
    } as never);

    expect(useBoardStore.getState().cards.a!.archived).toBe(false);
  });
});
