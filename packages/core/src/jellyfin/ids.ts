import {
  JellyfinRepository,
  type JellyfinItemDescriptor,
} from '../db/index.js';
import { Cache } from '../utils/cache.js';
import { createLogger } from '../logging/logger.js';
import {
  canonicalDescriptor,
  hashJellyfinId,
  isHashedJellyfinId,
  normaliseJellyfinId,
  packJellyfinId,
  unpackJellyfinId,
} from './ids-codec.js';

export * from './ids-codec.js';

const logger = createLogger('jellyfin');

const idCache = Cache.getInstance<string, JellyfinItemDescriptor>(
  'jellyfin-ids',
  100_000
);
const ID_CACHE_TTL = 30 * 24 * 3600;

const persisted = new Set<string>();
const PERSISTED_MAX = 50_000;
let pending: { id: string; payload: JellyfinItemDescriptor }[] = [];
let flushTimer: NodeJS.Timeout | null = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const batch = pending;
    pending = [];
    try {
      await JellyfinRepository.rememberItems(batch);
    } catch (e) {
      logger.warn(
        `Failed to persist ${batch.length} jellyfin id mappings: ${e instanceof Error ? e.message : e}`
      );
      for (const b of batch) persisted.delete(b.id);
    }
  }, 250);
}

export function encodeJellyfinId(d: JellyfinItemDescriptor): string {
  const packed = packJellyfinId(d);
  if (packed) return packed;
  const id = hashJellyfinId(d);
  if (!persisted.has(id)) {
    if (persisted.size >= PERSISTED_MAX) persisted.clear();
    persisted.add(id);
    pending.push({ id, payload: d });
    scheduleFlush();
    void idCache.set(id, d, ID_CACHE_TTL).catch(() => undefined);
  }
  return id;
}

export async function decodeJellyfinId(
  raw: string
): Promise<JellyfinItemDescriptor | null> {
  const id = normaliseJellyfinId(raw);
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const unpacked = unpackJellyfinId(id);
  if (unpacked) return unpacked;
  if (!isHashedJellyfinId(id)) return null;
  const cached = await idCache.get(id).catch(() => undefined);
  if (cached) return cached;
  const stored = await JellyfinRepository.lookupItem(id);
  if (stored) {
    void idCache.set(id, stored, ID_CACHE_TTL).catch(() => undefined);
    return stored;
  }
  return null;
}

export { canonicalDescriptor };
