import type { PendingImage } from './useImagePaste';
import './ImageAttach.css';

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
    <ul className="image-thumbs">
      {images.map((img) => (
        <li key={img.id} className="image-thumb">
          <img src={img.dataUrl} alt={img.filename} />
          <button
            type="button"
            className="image-thumb-x"
            onClick={() => onRemove(img.id)}
            aria-label={`Remove ${img.filename}`}
          >
            ×
          </button>
          <div className="image-thumb-meta">
            <span className="image-thumb-name">{img.filename}</span>
            <span className="image-thumb-size">{humanSize(img.sizeBytes)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
