import { useEffect, useRef, useState } from 'react';
import { ErrorBanner, IconPot, IconTrash } from './ui';

/**
 * A phone photo is several megabytes and far more pixels than a recipe page
 * shows, so it is scaled down in the browser before it goes up.
 */
export async function shrinkPicture(file: Blob, maxSide = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 700_000) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that picture'))), 'image/jpeg', 0.85),
  );
}

interface Props {
  /** What to show now: an address, or nothing. */
  src: string | null;
  /** Says where the picture shown came from, when that is worth saying. */
  caption?: string;
  busy?: boolean;
  error?: unknown;
  onUpload: (picture: Blob) => void;
  onRemove?: () => void;
  /** Offered when the recipe has a source page to take the picture from. */
  onFromSource?: () => void;
}

export function PictureEditor({ src, caption, busy, error, onUpload, onRemove, onFromSource }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<unknown>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    setReadError(null);
    try {
      onUpload(await shrinkPicture(file));
    } catch (err) {
      setReadError(err);
    } finally {
      setReading(false);
      if (input.current) input.current.value = '';
    }
  };

  const working = busy || reading;

  return (
    <div className="stack">
      <div className={`picture${src ? '' : ' picture--empty'}`}>
        {src ? <img src={src} alt="" referrerPolicy="no-referrer" /> : <IconPot size={34} />}
        {working && <span className="picture__busy spinner" />}
      </div>
      {caption && <p className="tiny faint" style={{ margin: 0 }}>{caption}</p>}
      <div className="row row--wrap">
        <button type="button" className="btn btn--sm" disabled={working} onClick={() => input.current?.click()}>
          {src ? 'Replace…' : 'Upload a picture…'}
        </button>
        {onFromSource && (
          <button type="button" className="btn btn--sm btn--ghost" disabled={working} onClick={onFromSource}>
            Take it from the source page
          </button>
        )}
        {src && onRemove && (
          <button type="button" className="btn btn--sm btn--quiet" disabled={working} onClick={onRemove}>
            <IconTrash size={15} /> Remove
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <ErrorBanner error={readError ?? error} />
    </div>
  );
}

/** An object URL for a picture not uploaded yet, released when it changes. */
export function useBlobUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}
