import { X } from 'lucide-react';
import type { PendingImage } from './useImagePaste';

interface ImageThumbnailsProps {
  images: PendingImage[];
  onRemove(id: string): void;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ImageThumbnails({ images, onRemove }: ImageThumbnailsProps): JSX.Element | null {
  if (images.length === 0) return null;
  return (
    <ul className="image-thumbs flex flex-wrap gap-2 mb-2 list-none m-0 p-0">
      {images.map((img) => (
        <li key={img.id} className="image-thumb relative w-16">
          <div className="relative w-16 h-16 rounded overflow-hidden bg-[var(--color-surface-2)] border border-[var(--color-border)]">
            <img src={img.dataUrl} alt={img.filename} className="w-full h-full object-cover" />
            <button
              type="button"
              className="image-thumb-x absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center text-white bg-black/60 rounded-full"
              onClick={() => onRemove(img.id)}
              aria-label={`Remove ${img.filename}`}
            >
              <X size={12} />
            </button>
          </div>
          <div className="image-thumb-meta flex flex-col text-[0.65rem] text-[var(--color-text-dim)] mt-0.5">
            <span className="image-thumb-name overflow-hidden text-ellipsis whitespace-nowrap">{img.filename}</span>
            <span className="image-thumb-size">{humanSize(img.sizeBytes)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
