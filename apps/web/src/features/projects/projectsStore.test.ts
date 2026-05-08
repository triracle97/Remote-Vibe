import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectsStore } from './projectsStore';

describe('projectsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useProjectsStore.setState({ paths: [] });
  });

  it('starts empty', () => {
    expect(useProjectsStore.getState().paths).toEqual([]);
  });

  it('add appends a path and dedupes case-sensitive', () => {
    const { add } = useProjectsStore.getState();
    add('/a');
    add('/b');
    add('/a');
    expect(useProjectsStore.getState().paths).toEqual(['/a', '/b']);
  });

  it('remove drops a path', () => {
    const { add, remove } = useProjectsStore.getState();
    add('/a');
    add('/b');
    remove('/a');
    expect(useProjectsStore.getState().paths).toEqual(['/b']);
  });

  it('move swaps positions', () => {
    const { add, move } = useProjectsStore.getState();
    add('/a');
    add('/b');
    add('/c');
    move(0, 2);
    expect(useProjectsStore.getState().paths).toEqual(['/b', '/c', '/a']);
  });

  it('persists to localStorage', () => {
    useProjectsStore.getState().add('/x');
    expect(localStorage.getItem('mrt.projects')).toContain('/x');
  });

  it('survives setItem failure', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    try {
      useProjectsStore.getState().add('/y');
      expect(useProjectsStore.getState().paths).toEqual(['/y']);
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
