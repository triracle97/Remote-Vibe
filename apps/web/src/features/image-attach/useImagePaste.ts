import { useCallback, useState } from 'react';

export interface PendingImage {
  id: string;
  mime: string;
  base64: string;
  filename: string;
  sizeBytes: number;
  dataUrl: string;
}

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES = 4;
const MAX_BYTES = 10 * 1024 * 1024;

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

function newId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface UseImagePaste {
  images: PendingImage[];
  error: string | null;
  addImageFromFile(file: File): Promise<void>;
  removeImage(id: string): void;
  clear(): void;
}

export function useImagePaste(): UseImagePaste {
  // Single state object so {images, error} updates are atomic. A separate
  // useState for each could split the cap-rejection across two renders and
  // drop the error message under React 18 batching.
  const [state, setState] = useState<{ images: PendingImage[]; error: string | null }>({
    images: [],
    error: null,
  });
  const { images, error } = state;

  const addImageFromFile = useCallback(async (file: File) => {
    // Validate stable file properties up front. These don't depend on
    // current state, so eager `setError` via the single-state updater is safe.
    if (!ALLOWED_MIMES.has(file.type)) {
      setState((prev) => ({ ...prev, error: `Unsupported MIME ${file.type}; allowed: png/jpeg/webp/gif` }));
      return;
    }
    if (file.size > MAX_BYTES) {
      setState((prev) => ({
        ...prev,
        error: `Image is ${(file.size / 1024 / 1024).toFixed(1)} MB; max 10 MB per image`,
      }));
      return;
    }
    let dataUrl: string;
    try {
      dataUrl = await readAsDataURL(file);
    } catch (err) {
      setState((prev) => ({ ...prev, error: `Could not read file: ${(err as Error).message}` }));
      return;
    }
    const comma = dataUrl.indexOf(',');
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    // Atomic decision: a single functional updater either appends and
    // clears the error, or rejects and sets the error. Both `images` and
    // `error` live in one state object so React batching cannot drop the
    // error update (the prior `let rejected = false` side-channel was
    // racy under React 18 concurrent rendering).
    setState((prev) => {
      if (prev.images.length >= MAX_IMAGES) {
        return { ...prev, error: `At most ${MAX_IMAGES} images per message` };
      }
      return {
        images: [
          ...prev.images,
          {
            id: newId(),
            mime: file.type,
            base64,
            filename: file.name,
            sizeBytes: file.size,
            dataUrl,
          },
        ],
        error: null,
      };
    });
  }, []);

  const removeImage = useCallback((id: string) => {
    setState((prev) => ({ ...prev, images: prev.images.filter((img) => img.id !== id) }));
  }, []);

  const clear = useCallback(() => {
    setState({ images: [], error: null });
  }, []);

  return { images, error, addImageFromFile, removeImage, clear };
}
