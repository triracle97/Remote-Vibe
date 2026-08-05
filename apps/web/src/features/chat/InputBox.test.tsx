import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor, renderHook, act, cleanup } from '@testing-library/react';
import { InputBox } from './InputBox';
import { useImagePaste, type UseImagePaste } from '../image-attach/useImagePaste';

// Tiny harness: drive the real `useImagePaste` hook from a renderHook so the
// InputBox sees a live image list (matches Chat.tsx's wiring), and expose its
// current value via a ref-like getter.
// vitest runs with globals: false, so RTL's auto-cleanup never registers.
// Without this every rendered InputBox stays mounted with its document paste
// listener, and one dispatch drives setState in all of them at once.
afterEach(cleanup);

function makeImagePaste(): { paste: UseImagePaste; getCurrent: () => UseImagePaste } {
  const { result } = renderHook(() => useImagePaste());
  // Each render of InputBox must receive a stable-ish reference; just hand
  // back result.current at call time. The test harness re-renders when state
  // changes via fireEvent, which re-reads result.current.
  return {
    get paste() {
      return result.current;
    },
    getCurrent: () => result.current,
  };
}

function defaultProps(overrides: Partial<Parameters<typeof InputBox>[0]> = {}) {
  const harness = makeImagePaste();
  return {
    onSend: vi.fn(),
    onStop: vi.fn(),
    disabled: false,
    alive: true,
    onResume: vi.fn().mockResolvedValue('new-id'),
    agent: 'claude' as const,
    imagePaste: harness.paste,
    sessionId: 'sess-test',
    ...overrides,
  };
}

describe('InputBox — dead-session auto-prompt-on-send (T13)', () => {
  it('alive=true: clicking Send fires onSend immediately and clears the textarea', () => {
    const props = defaultProps();
    const { container } = render(<InputBox {...props} />);
    const ta = container.querySelector('textarea')!;
    fireEvent.change(ta, { target: { value: 'hello' } });
    const sendBtn = container.querySelectorAll('.input-actions button')[3] as HTMLButtonElement;
    fireEvent.click(sendBtn);
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSend).toHaveBeenCalledWith('hello');
    // Textarea should clear after a successful (alive) send.
    expect((container.querySelector('textarea')! as HTMLTextAreaElement).value).toBe('');
  });

  it('alive=false: clicking Send is intercepted, surfaces "Resume + send" CTA, and does NOT call onSend', () => {
    const props = defaultProps({ alive: false });
    const { container } = render(<InputBox {...props} />);
    const ta = container.querySelector('textarea')!;
    fireEvent.change(ta, { target: { value: 'hello' } });
    const sendBtn = container.querySelectorAll('.input-actions button')[3] as HTMLButtonElement;
    fireEvent.click(sendBtn);
    // Intercepted: no onSend yet.
    expect(props.onSend).not.toHaveBeenCalled();
    // Inline "Resume + send" CTA visible.
    const cta = container.querySelector('.resume-prompt .resume-prompt-button') as HTMLButtonElement;
    expect(cta).toBeTruthy();
    expect(cta.textContent).toMatch(/resume \+ send/i);
    // Captured text should still be in the textarea (user can edit while waiting).
    expect((container.querySelector('textarea')! as HTMLTextAreaElement).value).toBe('hello');
  });

  it('alive=false: clicking "Resume + send" calls onResume() then onSend(captured)', async () => {
    const order: string[] = [];
    const onResume = vi.fn().mockImplementation(async () => {
      order.push('resume');
      return 'new-id';
    });
    const onSend = vi.fn().mockImplementation(() => {
      order.push('send');
    });
    const props = defaultProps({ alive: false, onResume, onSend });
    const { container } = render(<InputBox {...props} />);
    const ta = container.querySelector('textarea')!;
    fireEvent.change(ta, { target: { value: 'hello' } });
    const sendBtn = container.querySelectorAll('.input-actions button')[3] as HTMLButtonElement;
    fireEvent.click(sendBtn);
    const cta = container.querySelector('.resume-prompt .resume-prompt-button') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(cta);
    });
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(order).toEqual(['resume', 'send']);
    // CTA dismissed after click.
    expect(container.querySelector('.resume-prompt .resume-prompt-button')).toBeNull();
  });

  it('alive=false: text typed AFTER submit (during resume in-flight) stays in textarea, not auto-sent', async () => {
    let resolveResume: (v: string) => void = () => {};
    const onResume = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveResume = resolve;
        }),
    );
    const onSend = vi.fn();
    const props = defaultProps({ alive: false, onResume, onSend });
    const { container } = render(<InputBox {...props} />);
    const ta = container.querySelector('textarea')!;
    // 1) Type "hello", click Send → captured + CTA shows.
    fireEvent.change(ta, { target: { value: 'hello' } });
    const sendBtn = container.querySelectorAll('.input-actions button')[3] as HTMLButtonElement;
    fireEvent.click(sendBtn);
    const cta = container.querySelector('.resume-prompt .resume-prompt-button') as HTMLButtonElement;
    // 2) Click Resume + send. onResume's promise is pending.
    fireEvent.click(cta);
    // 3) While resume in-flight, user types more text. Simulate by appending
    //    to the live textarea — the captured prefix gets stripped on click,
    //    so the textarea will be "" at this moment; type fresh content.
    await waitFor(() =>
      expect((container.querySelector('textarea')! as HTMLTextAreaElement).value).toBe(''),
    );
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'next-msg' } });
    // 4) Resolve the resume.
    await act(async () => {
      resolveResume('new-id');
      // Microtask flush.
      await Promise.resolve();
    });
    // The original captured "hello" should have been sent EXACTLY ONCE.
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith('hello');
    // The newly-typed text MUST still be in the textarea (not auto-sent).
    expect((container.querySelector('textarea')! as HTMLTextAreaElement).value).toBe('next-msg');
  });

  it('alive=false: empty textarea + click Send is a no-op (no CTA shown)', () => {
    const props = defaultProps({ alive: false });
    const { container } = render(<InputBox {...props} />);
    const sendBtn = container.querySelectorAll('.input-actions button')[3] as HTMLButtonElement;
    // Send button is disabled-by-validation when text is empty + no images.
    expect(sendBtn.disabled).toBe(true);
    // Force-click anyway via direct submit() path (just confirm no CTA).
    fireEvent.click(sendBtn);
    expect(container.querySelector('.resume-prompt .resume-prompt-button')).toBeNull();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('alive=false: textarea remains enabled (NOT disabled) so user can type', () => {
    const props = defaultProps({ alive: false });
    const { container } = render(<InputBox {...props} />);
    const ta = container.querySelector('textarea')! as HTMLTextAreaElement;
    expect(ta.disabled).toBe(false);
  });
});

/**
 * Enter-to-send.
 *
 * happy-dom has no real `matchMedia`, so the pointer capability is stubbed per
 * test — that flag is the whole behavioural switch.
 */
function stubPointer(fine: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('pointer: fine') ? fine : !fine,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

describe('InputBox — Enter to send', () => {
  it('sends on a bare Enter when there is a real keyboard', () => {
    const restore = stubPointer(true);
    try {
      const props = defaultProps();
      const { container } = render(<InputBox {...props} />);
      const ta = container.querySelector('textarea')!;
      fireEvent.change(ta, { target: { value: 'ship it' } });
      fireEvent.keyDown(ta, { key: 'Enter' });
      expect(props.onSend).toHaveBeenCalledTimes(1);
      expect(vi.mocked(props.onSend).mock.calls[0]![0]).toBe('ship it');
    } finally {
      restore();
    }
  });

  it('inserts a newline on Shift+Enter instead of sending', () => {
    const restore = stubPointer(true);
    try {
      const props = defaultProps();
      const { container } = render(<InputBox {...props} />);
      const ta = container.querySelector('textarea')!;
      fireEvent.change(ta, { target: { value: 'line one' } });
      fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
      expect(props.onSend).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('never sends mid-composition', () => {
    // On a CJK or predictive keyboard Enter accepts the candidate; sending
    // there would fire off half a word.
    const restore = stubPointer(true);
    try {
      const props = defaultProps();
      const { container } = render(<InputBox {...props} />);
      const ta = container.querySelector('textarea')!;
      fireEvent.change(ta, { target: { value: 'にほん' } });
      fireEvent.keyDown(ta, { key: 'Enter', isComposing: true });
      expect(props.onSend).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('leaves Enter as a newline on a touch device', () => {
    // Software keyboards cannot produce Shift+Enter, so binding Enter to send
    // would leave no way to type a second line at all.
    const restore = stubPointer(false);
    try {
      const props = defaultProps();
      const { container } = render(<InputBox {...props} />);
      const ta = container.querySelector('textarea')!;
      fireEvent.change(ta, { target: { value: 'first line' } });
      fireEvent.keyDown(ta, { key: 'Enter' });
      expect(props.onSend).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('still sends on Cmd/Ctrl+Enter everywhere, including touch', () => {
    for (const fine of [true, false]) {
      const restore = stubPointer(fine);
      try {
        const props = defaultProps();
        const { container } = render(<InputBox {...props} />);
        const ta = container.querySelector('textarea')!;
        fireEvent.change(ta, { target: { value: 'go' } });
        fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
        expect(props.onSend).toHaveBeenCalledTimes(1);
        expect(vi.mocked(props.onSend).mock.calls[0]![0]).toBe('go');
      } finally {
        restore();
      }
    }
  });

  it('does not send an empty message', () => {
    const restore = stubPointer(true);
    try {
      const props = defaultProps();
      const { container } = render(<InputBox {...props} />);
      const ta = container.querySelector('textarea')!;
      fireEvent.keyDown(ta, { key: 'Enter' });
      expect(props.onSend).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

/** Fire a paste at the document with the given clipboard payload. */
function pasteFiles(files: File[]): void {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
    clipboardData: unknown;
  };
  event.clipboardData = {
    items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    files,
  };
  document.dispatchEvent(event);
}

const PNG = (): File => new File([new Uint8Array(8)], 'shot.png', { type: 'image/png' });

describe('InputBox — paste an image', () => {
  /**
   * The image hook lives in its own render root, so the object handed to
   * InputBox is a snapshot. Its `addImageFromFile` is stable, so calls land on
   * the real hook — but assertions have to read `getCurrent()` for live state.
   */
  function renderWithImages(overrides: Record<string, unknown> = {}) {
    const harness = makeImagePaste();
    const props = { ...defaultProps(overrides), imagePaste: harness.paste };
    const view = render(<InputBox {...props} />);
    return { harness, props, ...view };
  }

  it('attaches a pasted image without the composer being focused', async () => {
    // The bug this covers: paste used to be a React onPaste on the textarea, so
    // taking a screenshot and hitting ⌘V with focus anywhere else did nothing.
    const { harness } = renderWithImages();

    pasteFiles([PNG()]);

    await waitFor(() => {
      expect(harness.getCurrent().images.length).toBe(1);
    });
    expect(harness.getCurrent().images[0]!.mime).toBe('image/png');
  });

  it('leaves a text paste alone', async () => {
    const { harness } = renderWithImages();

    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: unknown;
    };
    event.clipboardData = {
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      files: [],
    };
    document.dispatchEvent(event);

    // Not prevented, so the browser still inserts the text normally.
    expect(event.defaultPrevented).toBe(false);
    expect(harness.getCurrent().images).toHaveLength(0);
  });

  it('attaches images on a codex session too', async () => {
    // `codex exec -i <FILE>` takes images, so the composer no longer gates on
    // the agent — only on whether the session can take input at all.
    const { harness } = renderWithImages({ agent: 'codex' as const });

    pasteFiles([PNG()]);

    await waitFor(() => {
      expect(harness.getCurrent().images.length).toBe(1);
    });
  });

  it('does not attach images once the session has ended', async () => {
    const { harness } = renderWithImages({ disabled: true });

    pasteFiles([PNG()]);

    await new Promise((r) => setTimeout(r, 20));
    expect(harness.getCurrent().images).toHaveLength(0);
  });

  it('stops listening once unmounted', async () => {
    const { harness, unmount } = renderWithImages();
    unmount();

    pasteFiles([PNG()]);

    await new Promise((r) => setTimeout(r, 20));
    expect(harness.getCurrent().images).toHaveLength(0);
  });
});

/** Fire a paste at the document carrying a drag/clipboard payload. */
function pastePayload(payload: {
  uriList?: string;
  plain?: string;
  files?: Array<{ name: string; type?: string }>;
}): void {
  const data: Record<string, string> = {};
  if (payload.uriList !== undefined) data['text/uri-list'] = payload.uriList;
  if (payload.plain !== undefined) data['text/plain'] = payload.plain;
  const files = (payload.files ?? []).map((f) => ({ name: f.name, type: f.type ?? '' }));
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
    clipboardData: unknown;
  };
  event.clipboardData = {
    getData: (t: string) => data[t] ?? '',
    items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    files,
  };
  // The handler sets state synchronously from a native listener, so the
  // dispatch has to be inside act() — otherwise React re-enters and throws
  // "Should not already be working".
  act(() => {
    document.dispatchEvent(event);
  });
}

describe('InputBox — paste a file path', () => {
  it('inserts the absolute path when the clipboard carries a file URI', async () => {
    const props = defaultProps();
    const { container } = render(<InputBox {...props} />);

    pastePayload({ uriList: 'file:///Users/me/repo/notes.md' });

    await waitFor(() => {
      expect(container.querySelector('textarea')!.value).toContain('/Users/me/repo/notes.md');
    });
  });

  it('appends to existing text rather than replacing it', async () => {
    const props = defaultProps();
    const { container } = render(<InputBox {...props} />);
    const ta = container.querySelector('textarea')!;
    fireEvent.change(ta, { target: { value: 'look at' } });

    pastePayload({ uriList: 'file:///Users/me/a.txt' });

    await waitFor(() => {
      expect(ta.value).toContain('/Users/me/a.txt');
    });
    expect(ta.value).toContain('look at');
  });

  it('inserts several paths at once', async () => {
    const props = defaultProps();
    const { container } = render(<InputBox {...props} />);

    pastePayload({ uriList: 'file:///Users/me/a.txt\nfile:///Users/me/b.txt' });

    await waitFor(() => {
      const value = container.querySelector('textarea')!.value;
      expect(value).toContain('/Users/me/a.txt');
      expect(value).toContain('/Users/me/b.txt');
    });
  });

  it('falls back to the filename when the clipboard has no path', async () => {
    // The ⌘C-in-Finder case: the browser strips the path, so the name goes in
    // immediately and is upgraded later if the index resolves it.
    const props = defaultProps();
    const { container } = render(<InputBox {...props} />);

    pastePayload({ files: [{ name: 'notes.md' }] });

    await waitFor(() => {
      expect(container.querySelector('textarea')!.value).toContain('notes.md');
    });
  });

  it('leaves a plain text paste to the browser', () => {
    const props = defaultProps();
    const { container } = render(<InputBox {...props} />);
    const ta = container.querySelector('textarea')!;

    pastePayload({ plain: 'just some prose' });

    // Not claimed, so the textarea is untouched and the browser inserts it.
    expect(ta.value).toBe('');
  });

  it('still prefers attaching an image over pasting its path', () => {
    const harness = makeImagePaste();
    const props = { ...defaultProps(), imagePaste: harness.paste };
    const { container } = render(<InputBox {...props} />);

    const png = new File([new Uint8Array(8)], 'shot.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: unknown;
    };
    event.clipboardData = {
      getData: () => '',
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }],
      files: [png],
    };
    document.dispatchEvent(event);

    // The path never lands in the composer — the image is the payload.
    expect(container.querySelector('textarea')!.value).toBe('');
  });
});
