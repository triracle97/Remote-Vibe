import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useImagePaste } from './useImagePaste';

function makeFile(name: string, type: string, sizeBytes: number): File {
  const data = new Uint8Array(sizeBytes);
  return new File([data], name, { type });
}

describe('useImagePaste', () => {
  beforeEach(() => {
    // FileReader.readAsDataURL needs a global; happy-dom provides it.
  });

  it('addImageFromFile accepts a small PNG and exposes it via images', async () => {
    const { result } = renderHook(() => useImagePaste());
    await act(async () => {
      await result.current.addImageFromFile(makeFile('a.png', 'image/png', 64));
    });
    expect(result.current.images).toHaveLength(1);
    expect(result.current.images[0]!.mime).toBe('image/png');
    expect(result.current.error).toBeNull();
  });

  it('rejects MIME outside the allowlist', async () => {
    const { result } = renderHook(() => useImagePaste());
    await act(async () => {
      await result.current.addImageFromFile(makeFile('a.svg', 'image/svg+xml', 64));
    });
    expect(result.current.images).toHaveLength(0);
    expect(result.current.error).toMatch(/MIME/);
  });

  it('rejects images > 10 MB', async () => {
    const { result } = renderHook(() => useImagePaste());
    await act(async () => {
      await result.current.addImageFromFile(makeFile('a.png', 'image/png', 11 * 1024 * 1024));
    });
    expect(result.current.images).toHaveLength(0);
    expect(result.current.error).toMatch(/10 MB/);
  });

  it('rejects > 4 images', async () => {
    const { result } = renderHook(() => useImagePaste());
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await result.current.addImageFromFile(makeFile(`a${i}.png`, 'image/png', 64));
      });
    }
    await act(async () => {
      await result.current.addImageFromFile(makeFile('a5.png', 'image/png', 64));
    });
    expect(result.current.images).toHaveLength(4);
    expect(result.current.error).toMatch(/4/);
  });

  it('removeImage drops the entry by id', async () => {
    const { result } = renderHook(() => useImagePaste());
    await act(async () => {
      await result.current.addImageFromFile(makeFile('a.png', 'image/png', 64));
    });
    const id = result.current.images[0]!.id;
    act(() => result.current.removeImage(id));
    expect(result.current.images).toHaveLength(0);
  });

  it('clear empties the list', async () => {
    const { result } = renderHook(() => useImagePaste());
    await act(async () => {
      await result.current.addImageFromFile(makeFile('a.png', 'image/png', 64));
    });
    act(() => result.current.clear());
    expect(result.current.images).toHaveLength(0);
  });

  it('rejects the 5th file in a back-to-back batch (no stale-closure race)', async () => {
    // The hook renders once and we call addImageFromFile 5 times in a row
    // without giving React a chance to re-render between calls. The cap MUST
    // be enforced inside the functional setImages updater — not by reading
    // the stale `images.length` from the original render closure.
    const { result } = renderHook(() => useImagePaste());
    await act(async () => {
      await Promise.all(
        [0, 1, 2, 3, 4].map((i) =>
          result.current.addImageFromFile(makeFile(`a${i}.png`, 'image/png', 64)),
        ),
      );
    });
    expect(result.current.images.length).toBe(4);
    expect(result.current.error).toMatch(/4/);
  });
});
