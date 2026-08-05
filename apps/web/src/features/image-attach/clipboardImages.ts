/**
 * Pull image files out of a clipboard payload.
 *
 * Must be called synchronously inside the paste handler. `DataTransferItem` is
 * only valid for the lifetime of the event, and `getAsFile()` returns null once
 * the handler has yielded — which is why this is a plain function the caller
 * invokes before any `await`, rather than something async.
 *
 * Two shapes show up in practice, and both matter:
 *
 * - `items`, where a screenshot arrives as `kind: 'file'` with an image MIME.
 *   This is what Chrome and Safari give you for a copied screenshot.
 * - `files`, which Firefox populates and some browsers fill in even when
 *   `items` is empty.
 *
 * Reading both and de-duplicating is cheaper than guessing which browser is
 * running.
 */
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  const seen = new Set<string>();

  const take = (file: File | null): void => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    // A screenshot has no meaningful name, so identity is size + type + name.
    const key = `${file.name}:${file.size}:${file.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(file);
  };

  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    take(item.getAsFile());
  }
  for (const file of Array.from(data.files ?? [])) {
    take(file);
  }

  return out;
}
