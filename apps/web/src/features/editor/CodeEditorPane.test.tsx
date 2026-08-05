import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { CodeEditorPane } from './CodeEditorPane';
import { useFileExplorerStore, type SelectedFile } from '../../store/file-explorer';
import type { BridgeClient } from '../../services/bridge-client';

/**
 * Monaco is stubbed out. Pulling the real editor into a happy-dom test would
 * drag in web workers and a canvas it cannot provide; what is under test here
 * is the save/confirm/conflict wiring around it, so the stub just exposes the
 * two hooks the pane actually drives: `onGetContent` and `onSave`.
 */
let stubContent = 'edited';
vi.mock('./MonacoCodeEditor', () => ({
  default: ({
    onGetContent,
    onSave,
  }: {
    onGetContent?: (fn: () => string) => void;
    onSave?: () => void;
  }) => {
    onGetContent?.(() => stubContent);
    return (
      <button type="button" data-testid="monaco-stub" onClick={() => onSave?.()}>
        editor
      </button>
    );
  },
}));

const FILE: Extract<SelectedFile, { state: 'text' }> = {
  state: 'text',
  path: '/p/a.ts',
  content: 'original',
  bytesRead: 8,
  truncated: false,
  hash: 'h1',
};

function makeClient(): { client: BridgeClient; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    send: (m: unknown) => {
      sent.push(m as Record<string, unknown>);
    },
  } as unknown as BridgeClient;
  return { client, sent };
}

// vitest runs with globals: false, so RTL's auto-cleanup never registers.
afterEach(cleanup);

describe('CodeEditorPane', () => {
  beforeEach(() => {
    stubContent = 'edited';
    useFileExplorerStore.setState({
      selectedFile: FILE,
      editor: { dirty: false, saving: false, error: null, conflict: false },
      pendingWriteId: null,
    });
  });

  it('disables save until the editor reports a change', async () => {
    const { client } = makeClient();
    render(<CodeEditorPane client={client} file={FILE} />);
    const save = await screen.findByRole('button', { name: /save/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    useFileExplorerStore.getState().setDirty(true);
    const enabled = await screen.findByRole('button', { name: /^save$/i });
    expect((enabled as HTMLButtonElement).disabled).toBe(false);
  });

  it('confirming an ordinary save still carries the hash', async () => {
    const { client, sent } = makeClient();
    render(<CodeEditorPane client={client} file={FILE} />);
    useFileExplorerStore.getState().setDirty(true);

    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm save/i }));
    // Confirming intent must not waive the concurrency check.
    expect(sent[0]).toMatchObject({ baseHash: 'h1' });
  });

  it('asks for confirmation before the first write, then sends it', async () => {
    const { client, sent } = makeClient();
    render(<CodeEditorPane client={client} file={FILE} />);
    useFileExplorerStore.getState().setDirty(true);

    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }));
    // Nothing on the wire yet — just the confirmation.
    expect(sent).toHaveLength(0);
    expect(screen.getByText(/overwrite \/p\/a\.ts on disk\?/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /confirm save/i }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'write_file',
      path: '/p/a.ts',
      content: 'edited',
    });
  });

  it('cancel backs out of the confirmation without writing', async () => {
    const { client, sent } = makeClient();
    render(<CodeEditorPane client={client} file={FILE} />);
    useFileExplorerStore.getState().setDirty(true);

    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(sent).toHaveLength(0);
    expect(await screen.findByRole('button', { name: /^save$/i })).toBeTruthy();
  });

  it('⌘S routes through the same confirmation', async () => {
    const { client, sent } = makeClient();
    render(<CodeEditorPane client={client} file={FILE} />);
    useFileExplorerStore.getState().setDirty(true);

    // The stub calls onSave when clicked, standing in for the keybinding.
    fireEvent.click(await screen.findByTestId('monaco-stub'));
    expect(sent).toHaveLength(0);
    fireEvent.click(await screen.findByTestId('monaco-stub'));
    expect(sent).toHaveLength(1);
  });

  it('sends baseHash on a normal save and drops it after a conflict', async () => {
    const { client, sent } = makeClient();
    render(<CodeEditorPane client={client} file={FILE} />);
    useFileExplorerStore.getState().setDirty(true);

    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm save/i }));
    expect(sent[0]).toMatchObject({ baseHash: 'h1' });

    // Bridge refuses: the file moved under us.
    useFileExplorerStore.getState().applyServerError({
      type: 'error',
      code: 'file_conflict',
      message: 'changed on disk',
      correlationId: sent[0]!.correlationId as string,
    });

    const overwrite = await screen.findByRole('button', { name: /overwrite anyway/i });
    fireEvent.click(overwrite);
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toHaveProperty('baseHash');
  });

  it('offers a reload out of a conflict instead of overwriting', async () => {
    const { client, sent } = makeClient();
    render(<CodeEditorPane client={client} file={FILE} />);
    useFileExplorerStore.setState({
      editor: { dirty: true, saving: false, error: 'File changed on disk.', conflict: true },
    });

    fireEvent.click(await screen.findByRole('button', { name: /reload/i }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'read_file', path: '/p/a.ts' });
  });

  it('shows a save failure without offering to overwrite', async () => {
    const { client } = makeClient();
    render(<CodeEditorPane client={client} file={FILE} />);
    useFileExplorerStore.setState({
      editor: { dirty: true, saving: false, error: 'File is too large to save.', conflict: false },
    });

    expect(await screen.findByText(/too large to save/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /overwrite anyway/i })).toBeNull();
  });

  it('discard re-reads the file from disk', async () => {
    const { client, sent } = makeClient();
    render(<CodeEditorPane client={client} file={FILE} />);
    useFileExplorerStore.getState().setDirty(true);

    fireEvent.click(await screen.findByRole('button', { name: /discard changes/i }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'read_file', path: '/p/a.ts' });
  });

  it('marks the header dirty while there are unsaved edits', async () => {
    const { client } = makeClient();
    render(<CodeEditorPane client={client} file={FILE} />);
    expect(screen.queryByLabelText(/unsaved changes/i)).toBeNull();
    useFileExplorerStore.getState().setDirty(true);
    expect(await screen.findByLabelText(/unsaved changes/i)).toBeTruthy();
  });
});
