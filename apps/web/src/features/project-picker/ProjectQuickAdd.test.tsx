import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ProjectQuickAdd } from './ProjectQuickAdd';
import { useConnectionStore } from '../../store/connection';
import { useFileExplorerStore } from '../../store/file-explorer';
import type { DirEntry } from '../../store/file-explorer';
import type { ClientMsg } from '../../types/protocol';

// vitest runs with `globals: false`, so RTL auto-cleanup never registers.
afterEach(cleanup);

let sent: ClientMsg[] = [];
let clientRegistered = true;
vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: () => {
    if (!clientRegistered) throw new Error('BridgeClient has not been registered yet');
    return { send: (m: ClientMsg) => sent.push(m) };
  },
}));

const ROOT = '/Volumes/WDSSD/Code';

function dir(name: string): DirEntry {
  return { name, kind: 'dir' };
}

function seed(entries: DirEntry[], root = ROOT): void {
  useFileExplorerStore.setState({ dirs: { [root]: entries } });
}

beforeEach(() => {
  sent = [];
  clientRegistered = true;
  useConnectionStore.setState({ allowedDirs: [ROOT] });
  useFileExplorerStore.setState({ dirs: {}, expanded: {}, loadingPaths: {} });
});

describe('ProjectQuickAdd', () => {
  it('asks the bridge to list each allowed root', () => {
    render(<ProjectQuickAdd selected={[]} onAdd={() => {}} />);
    expect(sent).toEqual([
      { type: 'list_dirs', path: ROOT, correlationId: expect.any(String) },
    ]);
  });

  it('lists each root only once across re-renders', () => {
    const { rerender } = render(<ProjectQuickAdd selected={[]} onAdd={() => {}} />);
    rerender(<ProjectQuickAdd selected={['/x']} onAdd={() => {}} />);
    expect(sent).toHaveLength(1);
  });

  it('does not crash when the client is not registered yet', () => {
    clientRegistered = false;
    expect(() => render(<ProjectQuickAdd selected={[]} onAdd={() => {}} />)).not.toThrow();
  });

  it('offers the root plus every subdirectory', () => {
    seed([dir('posRN1'), dir('nimbalyst')]);
    render(<ProjectQuickAdd selected={[]} onAdd={() => {}} />);
    expect(screen.getByLabelText(`Add ${ROOT}/posRN1`)).toBeTruthy();
    expect(screen.getByLabelText(`Add ${ROOT}/nimbalyst`)).toBeTruthy();
    expect(screen.getByLabelText(`Add ${ROOT}`)).toBeTruthy();
  });

  it('skips files — only directories are projects', () => {
    seed([dir('posRN1'), { name: 'README.md', kind: 'file' }]);
    render(<ProjectQuickAdd selected={[]} onAdd={() => {}} />);
    expect(screen.queryByLabelText(`Add ${ROOT}/README.md`)).toBeNull();
  });

  it('omits the root when includeRoots is false', () => {
    seed([dir('posRN1')]);
    render(<ProjectQuickAdd selected={[]} onAdd={() => {}} includeRoots={false} />);
    expect(screen.queryByLabelText(`Add ${ROOT}`)).toBeNull();
    expect(screen.getByLabelText(`Add ${ROOT}/posRN1`)).toBeTruthy();
  });

  it('hides paths that are already selected', () => {
    seed([dir('posRN1'), dir('nimbalyst')]);
    render(<ProjectQuickAdd selected={[`${ROOT}/posRN1`]} onAdd={() => {}} />);
    expect(screen.queryByLabelText(`Add ${ROOT}/posRN1`)).toBeNull();
    expect(screen.getByLabelText(`Add ${ROOT}/nimbalyst`)).toBeTruthy();
  });

  it('filters as you type', () => {
    seed([dir('posRN1'), dir('nimbalyst')]);
    render(<ProjectQuickAdd selected={[]} onAdd={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Filter projects/), { target: { value: 'nimb' } });
    expect(screen.queryByLabelText(`Add ${ROOT}/posRN1`)).toBeNull();
    expect(screen.getByLabelText(`Add ${ROOT}/nimbalyst`)).toBeTruthy();
  });

  it('matches case-insensitively', () => {
    seed([dir('posRN1')]);
    render(<ProjectQuickAdd selected={[]} onAdd={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Filter projects/), { target: { value: 'POSRN' } });
    expect(screen.getByLabelText(`Add ${ROOT}/posRN1`)).toBeTruthy();
  });

  it('ranks a name that starts with the query above one that merely contains it', () => {
    // Alphabetically 'my-admin' sorts first, so only ranking can flip these.
    seed([dir('my-admin'), dir('admin-panel')]);
    render(<ProjectQuickAdd selected={[]} onAdd={() => {}} includeRoots={false} />);
    fireEvent.change(screen.getByLabelText(/Filter projects/), { target: { value: 'admin' } });
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual([`Add ${ROOT}/admin-panel`, `Add ${ROOT}/my-admin`]);
  });

  it('ranks a match buried in the parent path last', () => {
    // Nothing here is *named* posRN1, but its parent path contains 'Code'.
    seed([dir('posRN1')]);
    render(<ProjectQuickAdd selected={[]} onAdd={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Filter projects/), { target: { value: 'code' } });
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    // The root is named 'Code' (rank 0); posRN1 only matches via its parent (rank 2).
    expect(labels).toEqual([`Add ${ROOT}`, `Add ${ROOT}/posRN1`]);
  });

  it('adds the clicked path and clears the filter', () => {
    seed([dir('posRN1')]);
    const onAdd = vi.fn();
    render(<ProjectQuickAdd selected={[]} onAdd={onAdd} />);
    const input = screen.getByLabelText(/Filter projects/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'pos' } });
    fireEvent.click(screen.getByLabelText(`Add ${ROOT}/posRN1`));
    expect(onAdd).toHaveBeenCalledWith(`${ROOT}/posRN1`);
    expect(input.value).toBe('');
  });

  it('Enter adds the top result', () => {
    seed([dir('posRN1'), dir('nimbalyst')]);
    const onAdd = vi.fn();
    render(<ProjectQuickAdd selected={[]} onAdd={onAdd} />);
    const input = screen.getByLabelText(/Filter projects/);
    fireEvent.change(input, { target: { value: 'nimb' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith(`${ROOT}/nimbalyst`);
  });

  it('accepts a pasted absolute path that is not in the list', () => {
    seed([dir('posRN1')]);
    const onAdd = vi.fn();
    render(<ProjectQuickAdd selected={[]} onAdd={onAdd} />);
    const input = screen.getByLabelText(/Filter projects/);
    fireEvent.change(input, { target: { value: '/somewhere/else' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('/somewhere/else');
  });

  it('does not offer a literal path that is already selected', () => {
    seed([]);
    render(<ProjectQuickAdd selected={['/somewhere/else']} onAdd={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Filter projects/), {
      target: { value: '/somewhere/else' },
    });
    expect(screen.queryByLabelText('Use "/somewhere/else"')).toBeNull();
  });

  it('does not treat a relative filter as a path', () => {
    seed([]);
    const onAdd = vi.fn();
    render(<ProjectQuickAdd selected={[]} onAdd={onAdd} />);
    const input = screen.getByLabelText(/Filter projects/);
    fireEvent.change(input, { target: { value: 'nothing-matches' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByText(/Paste an absolute path/)).toBeTruthy();
  });

  it('caps how many results it renders', () => {
    seed(Array.from({ length: 120 }, (_, i) => dir(`proj-${i}`)));
    render(<ProjectQuickAdd selected={[]} onAdd={() => {}} maxResults={5} />);
    expect(screen.getAllByRole('button')).toHaveLength(5);
  });

  it('shows a loading note until the listing arrives', () => {
    render(<ProjectQuickAdd selected={[]} onAdd={() => {}} includeRoots={false} />);
    expect(screen.getByText('Loading projects…')).toBeTruthy();
  });

  it('says so when a root has no subdirectories', () => {
    seed([]);
    render(<ProjectQuickAdd selected={[]} onAdd={() => {}} includeRoots={false} />);
    expect(screen.getByText('No projects found.')).toBeTruthy();
  });
});
