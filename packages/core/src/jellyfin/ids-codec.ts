import { createHash } from 'crypto';
import type { JellyfinItemDescriptor } from '../db/repositories/jellyfin.js';
import { IdParser } from '../utils/id-parser.js';

const PACKED = 0xa1;
const HASHED = 0xb2;

const KIND_CODES: Record<string, number> = {
  movie: 1,
  series: 2,
  season: 3,
  episode: 4,
};
const KIND_BY_CODE = Object.fromEntries(
  Object.entries(KIND_CODES).map(([k, v]) => [v, k])
) as Record<number, 'movie' | 'series' | 'season' | 'episode'>;

const ID_TYPE_CODES: Record<string, number> = {
  imdbId: 1,
  themoviedbId: 2,
  thetvdbId: 3,
  kitsuId: 4,
  malId: 5,
  anilistId: 6,
  anidbId: 7,
  simklId: 8,
};
const ID_TYPE_BY_CODE = Object.fromEntries(
  Object.entries(ID_TYPE_CODES).map(([k, v]) => [v, k])
);
const ID_PREFIX_BY_TYPE: Record<string, string> = {
  imdbId: 'tt',
  themoviedbId: 'tmdb:',
  thetvdbId: 'tvdb:',
  kitsuId: 'kitsu:',
  malId: 'mal:',
  anilistId: 'anilist:',
  anidbId: 'anidb:',
  simklId: 'simkl:',
};

const MEDIA_TYPE_CODES: Record<string, number> = {
  movie: 1,
  series: 2,
  anime: 3,
  tv: 4,
  other: 5,
  channel: 6,
};
const MEDIA_TYPE_BY_CODE = Object.fromEntries(
  Object.entries(MEDIA_TYPE_CODES).map(([k, v]) => [v, k])
);

const NONE16 = 0xffff;
const MAX48 = 2 ** 48 - 1;

function rebuildBaseId(idType: string, numeric: number): string {
  const prefix = ID_PREFIX_BY_TYPE[idType];
  if (idType === 'imdbId') return `tt${String(numeric).padStart(7, '0')}`;
  return `${prefix}${numeric}`;
}

function tryPack(d: JellyfinItemDescriptor): string | null {
  if (
    d.k !== 'movie' &&
    d.k !== 'series' &&
    d.k !== 'season' &&
    d.k !== 'episode'
  )
    return null;
  const mediaCode = MEDIA_TYPE_CODES[d.t];
  if (!mediaCode) return null;
  const parsed = IdParser.parse(d.i, d.t);
  if (!parsed || parsed.season || parsed.episode) return null;
  const idTypeCode = ID_TYPE_CODES[parsed.type];
  if (!idTypeCode) return null;
  const rawValue = String(parsed.value);
  const numeric = Number(
    parsed.type === 'imdbId' ? rawValue.replace(/^tt/, '') : rawValue
  );
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > MAX48) return null;
  if (rebuildBaseId(parsed.type, numeric) !== d.i) return null;

  let season = NONE16;
  let episode = NONE16;
  if (d.k === 'season') {
    if (!Number.isInteger(d.s) || d.s < 0 || d.s >= NONE16) return null;
    season = d.s;
  } else if (d.k === 'episode') {
    if (!Number.isInteger(d.s) || d.s < 0 || d.s >= NONE16) return null;
    if (!Number.isInteger(d.e) || d.e < 0 || d.e >= NONE16) return null;
    if (parsed.generator(parsed.value, String(d.s), String(d.e)) !== d.v)
      return null;
    season = d.s;
    episode = d.e;
  }

  const buf = Buffer.alloc(16);
  buf[0] = PACKED;
  buf[1] = (KIND_CODES[d.k] << 4) | idTypeCode;
  buf[2] = mediaCode;
  buf.writeUIntBE(numeric, 3, 6);
  buf.writeUInt16BE(season, 9);
  buf.writeUInt16BE(episode, 11);
  return buf.toString('hex');
}

function tryUnpack(hex: string): JellyfinItemDescriptor | null {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 16 || buf[0] !== PACKED) return null;
  const kind = KIND_BY_CODE[buf[1] >> 4];
  const idType = ID_TYPE_BY_CODE[buf[1] & 0x0f];
  const mediaType = MEDIA_TYPE_BY_CODE[buf[2]];
  if (!kind || !idType || !mediaType) return null;
  const numeric = buf.readUIntBE(3, 6);
  const season = buf.readUInt16BE(9);
  const episode = buf.readUInt16BE(11);
  const baseId = rebuildBaseId(idType, numeric);
  switch (kind) {
    case 'movie':
    case 'series':
      return { k: kind, t: mediaType, i: baseId };
    case 'season':
      return { k: 'season', t: mediaType, i: baseId, s: season };
    case 'episode': {
      const parsed = IdParser.parse(baseId, mediaType);
      if (!parsed) return null;
      return {
        k: 'episode',
        t: mediaType,
        i: baseId,
        s: season,
        e: episode,
        v: parsed.generator(parsed.value, String(season), String(episode)),
      };
    }
  }
}

export function normaliseJellyfinId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

export function dashedGuid(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

export function canonicalDescriptor(d: JellyfinItemDescriptor): string {
  switch (d.k) {
    case 'view':
      return `view|${d.t}|${d.c}`;
    case 'genre':
      return `genre|${d.t}|${d.c}|${d.g}`;
    case 'movie':
    case 'series':
      return `${d.k}|${d.t}|${d.i}`;
    case 'season':
      return `season|${d.t}|${d.i}|${d.s}`;
    case 'episode':
      return `episode|${d.t}|${d.i}|${d.s}|${d.e}|${d.v}`;
    case 'person':
    case 'studio':
      return `${d.k}|${d.n}`;
  }
}

export function packJellyfinId(d: JellyfinItemDescriptor): string | null {
  return tryPack(d);
}

export function unpackJellyfinId(raw: string): JellyfinItemDescriptor | null {
  const id = normaliseJellyfinId(raw);
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  return tryUnpack(id);
}

export function hashJellyfinId(d: JellyfinItemDescriptor): string {
  const hash = createHash('md5').update(canonicalDescriptor(d)).digest();
  hash[0] = HASHED;
  return hash.toString('hex');
}

export function isHashedJellyfinId(id: string): boolean {
  return normaliseJellyfinId(id).slice(0, 2) === HASHED.toString(16);
}

export function uuidToJellyfinUserId(uuid: string): string {
  return normaliseJellyfinId(uuid);
}

export function jellyfinUserIdToUuid(id: string): string {
  return dashedGuid(normaliseJellyfinId(id));
}

export function streamIdToMediaSourceId(streamId: string): string {
  return createHash('md5').update(streamId).digest('hex');
}

export function imageTag(url: string): string {
  return createHash('md5').update(url).digest('hex').slice(0, 16);
}
