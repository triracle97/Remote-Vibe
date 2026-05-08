import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor, renderHook, act } from '@testing-library/react';
import { InputBox } from './InputBox';
import { useImagePaste, type UseImagePaste } from '../image-attach/useImagePaste';

// Tiny harness: drive the real `useImagePaste` hook from a renderHook so the
// InputBox sees a live image list (matches Chat.tsx's wiring), and expose its
// current value via a ref-like getter.
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
