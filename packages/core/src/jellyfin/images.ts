import { Cache } from '../utils/cache.js';

export interface ItemImages {
  Primary?: string;
  Backdrop?: string;
  Logo?: string;
  Thumb?: string;
}

export interface RememberedImages {
  images: ItemImages;
  complete: boolean;
}

const imageCache = Cache.getInstance<string, RememberedImages>(
  'jellyfin-images',
  50_000
);
const TTL = 7 * 24 * 3600;
const EMPTY_TTL = 10 * 60;

function key(uuid: string, itemId: string): string {
  return `${uuid}|${itemId}`;
}

function isEmpty(images: ItemImages): boolean {
  return !images.Primary && !images.Backdrop && !images.Logo && !images.Thumb;
}

export function rememberImages(
  uuid: string,
  itemId: string,
  images: ItemImages,
  complete = false
): void {
  const empty = isEmpty(images);
  if (empty && !complete) return;
  void imageCache
    .set(key(uuid, itemId), { images, complete }, empty ? EMPTY_TTL : TTL)
    .catch(() => undefined);
}

export async function recallImages(
  uuid: string,
  itemId: string
): Promise<RememberedImages | undefined> {
  const entry = await imageCache.get(key(uuid, itemId)).catch(() => undefined);
  if (!entry) return undefined;
  if (typeof entry.complete !== 'boolean' || !entry.images)
    return { images: entry as unknown as ItemImages, complete: false };
  return entry;
}
