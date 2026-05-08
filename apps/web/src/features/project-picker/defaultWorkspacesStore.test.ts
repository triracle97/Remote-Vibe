import { describe, it, expect, beforeEach } from 'vitest';
import { useDefaultWorkspacesStore } from './defaultWorkspacesStore';
import { DEFAULT_WORKSPACE_DIRS } from './default-workspaces';

describe('defaultWorkspacesStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useDefaultWorkspacesStore.setState({ paths: [...DEFAULT_WORKSPACE_DIRS] });
  });

  it('starts seeded from DEFAULT_WORKSPACE_DIRS', () => {
    expect(useDefaultWorkspacesStore.getState().paths).toEqual([...DEFAULT_WORKSPACE_DIRS]);
  });

  it('add appends and dedupes', () => {
    const { add } = useDefaultWorkspacesStore.getState();
    useDefaultWorkspacesStore.setState({ paths: [] });
    add('/x');
    add('/y');
    add('/x');
    expect(useDefaultWorkspacesStore.getState().paths).toEqual(['/x', '/y']);
  });

  it('remove drops a path', () => {
    useDefaultWorkspacesStore.setState({ paths: ['/a', '/b'] });
    useDefaultWorkspacesStore.getState().remove('/a');
    expect(useDefaultWorkspacesStore.getState().paths).toEqual(['/b']);
  });

  it('persists to localStorage', () => {
    useDefaultWorkspacesStore.setState({ paths: [] });
    useDefaultWorkspacesStore.getState().add('/z');
    expect(localStorage.getItem('mrt.defaultWorkspaces')).toContain('/z');
  });

  it('survives setItem failure', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('quota'); };
    try {
      useDefaultWorkspacesStore.setState({ paths: [] });
      useDefaultWorkspacesStore.getState().add('/q');
      expect(useDefaultWorkspacesStore.getState().paths).toEqual(['/q']);
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
