import { getDb } from '../db.js';
import { join, sql } from '../sql.js';

export type JellyfinItemDescriptor =
  | { k: 'view'; t: string; c: string }
  | { k: 'genre'; t: string; c: string; g: string }
  | { k: 'movie'; t: string; i: string }
  | { k: 'series'; t: string; i: string }
  | { k: 'season'; t: string; i: string; s: number }
  | { k: 'episode'; t: string; i: string; s: number; e: number; v: string }
  | { k: 'person'; n: string }
  | { k: 'studio'; n: string };

export interface JellyfinPlaystateRow {
  itemId: string;
  payload: JellyfinItemDescriptor;
  positionTicks: number;
  runtimeTicks: number;
  played: boolean;
  playCount: number;
  favorite: boolean;
  lastPlayedAt: number | null;
  updatedAt: number;
}

interface PlaystateDbRow {
  item_id: string;
  payload: string;
  position_ticks: number | string;
  runtime_ticks: number | string;
  played: number | boolean;
  play_count: number | string;
  favorite: number | boolean;
  last_played_at: number | string | null;
  updated_at: number | string;
  [k: string]: unknown;
}

function toPlaystate(r: PlaystateDbRow): JellyfinPlaystateRow {
  return {
    itemId: r.item_id,
    payload: JSON.parse(r.payload),
    positionTicks: Number(r.position_ticks),
    runtimeTicks: Number(r.runtime_ticks),
    played: Boolean(Number(r.played)),
    playCount: Number(r.play_count),
    favorite: Boolean(Number(r.favorite)),
    lastPlayedAt: r.last_played_at == null ? null : Number(r.last_played_at),
    updatedAt: Number(r.updated_at),
  };
}

const CHUNK = 200;

function seriesKeyFor(d: JellyfinItemDescriptor): string | null {
  return d.k === 'episode' ? `${d.t}|${d.i}` : null;
}

export class JellyfinRepository {
  static async userVersions(uuids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const wanted = [...new Set(uuids.filter(Boolean))];
    if (!wanted.length) return out;
    const rows = await getDb().query<{
      uuid: string;
      updated_at: string | Date | null;
    }>(
      sql`SELECT uuid, updated_at FROM users
           WHERE uuid IN (${join(wanted.map((u) => sql`${u}`))})`
    );
    for (const r of rows) {
      out.set(
        r.uuid,
        r.updated_at instanceof Date
          ? r.updated_at.toISOString()
          : String(r.updated_at ?? '')
      );
    }
    return out;
  }

  static async rememberItems(
    entries: { id: string; payload: JellyfinItemDescriptor }[]
  ): Promise<void> {
    if (!entries.length) return;
    const now = Date.now();
    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK);
      const values = join(
        slice.map((e) => sql`(${e.id}, ${JSON.stringify(e.payload)}, ${now})`)
      );
      await getDb().exec(
        sql`INSERT INTO jellyfin_items (id, payload, created_at)
            VALUES ${values}
            ON CONFLICT(id) DO NOTHING`
      );
    }
  }

  static async lookupItem(id: string): Promise<JellyfinItemDescriptor | null> {
    const row = await getDb().maybeOne<{ payload: string }>(
      sql`SELECT payload FROM jellyfin_items WHERE id = ${id}`
    );
    return row ? (JSON.parse(row.payload) as JellyfinItemDescriptor) : null;
  }

  static async getPlaystates(
    uuid: string,
    itemIds: string[]
  ): Promise<Map<string, JellyfinPlaystateRow>> {
    const out = new Map<string, JellyfinPlaystateRow>();
    if (!itemIds.length) return out;
    for (let i = 0; i < itemIds.length; i += CHUNK) {
      const slice = itemIds.slice(i, i + CHUNK);
      const rows = await getDb().query<PlaystateDbRow>(
        sql`SELECT * FROM jellyfin_playstate
             WHERE uuid = ${uuid} AND item_id IN (${join(slice.map((id) => sql`${id}`))})`
      );
      for (const r of rows) out.set(r.item_id, toPlaystate(r));
    }
    return out;
  }

  static async getPlaystate(
    uuid: string,
    itemId: string
  ): Promise<JellyfinPlaystateRow | null> {
    const row = await getDb().maybeOne<PlaystateDbRow>(
      sql`SELECT * FROM jellyfin_playstate WHERE uuid = ${uuid} AND item_id = ${itemId}`
    );
    return row ? toPlaystate(row) : null;
  }

  static async upsertPlaystate(
    uuid: string,
    itemId: string,
    payload: JellyfinItemDescriptor,
    patch: {
      positionTicks?: number;
      runtimeTicks?: number;
      played?: boolean;
      incrementPlayCount?: boolean | 'if-unplayed';
      favorite?: boolean;
      lastPlayedAt?: number | null;
    }
  ): Promise<JellyfinPlaystateRow> {
    const now = Date.now();
    const pos = patch.positionTicks ?? null;
    const rt = patch.runtimeTicks ?? null;
    const played = patch.played == null ? null : patch.played ? 1 : 0;
    const fav = patch.favorite == null ? null : patch.favorite ? 1 : 0;
    const incMode =
      patch.incrementPlayCount === 'if-unplayed'
        ? 2
        : patch.incrementPlayCount
          ? 1
          : 0;
    const setLastPlayed = patch.lastPlayedAt === undefined ? 0 : 1;
    const lastPlayed = patch.lastPlayedAt ?? null;
    const seriesKey = seriesKeyFor(payload);
    await getDb().exec(
      sql`INSERT INTO jellyfin_playstate
            (uuid, item_id, payload, series_key, position_ticks, runtime_ticks, played, play_count, favorite, last_played_at, updated_at)
          VALUES (${uuid}, ${itemId}, ${JSON.stringify(payload)}, ${seriesKey},
                  COALESCE(${pos}, 0), COALESCE(${rt}, 0), COALESCE(${played}, 0),
                  CASE WHEN ${incMode} > 0 THEN 1 ELSE 0 END,
                  COALESCE(${fav}, 0), ${lastPlayed}, ${now})
          ON CONFLICT(uuid, item_id) DO UPDATE SET
            payload = excluded.payload,
            series_key = excluded.series_key,
            position_ticks = COALESCE(${pos}, jellyfin_playstate.position_ticks),
            runtime_ticks = COALESCE(${rt}, jellyfin_playstate.runtime_ticks),
            played = COALESCE(${played}, jellyfin_playstate.played),
            play_count = jellyfin_playstate.play_count +
              CASE ${incMode}
                WHEN 1 THEN 1
                WHEN 2 THEN CASE WHEN jellyfin_playstate.played = 1 THEN 0 ELSE 1 END
                ELSE 0
              END,
            favorite = COALESCE(${fav}, jellyfin_playstate.favorite),
            last_played_at = CASE WHEN ${setLastPlayed} = 1 THEN ${lastPlayed} ELSE jellyfin_playstate.last_played_at END,
            updated_at = excluded.updated_at`
    );
    const row = await this.getPlaystate(uuid, itemId);
    if (row) return row;
    return {
      itemId,
      payload,
      positionTicks: pos ?? 0,
      runtimeTicks: rt ?? 0,
      played: !!played,
      playCount: incMode > 0 ? 1 : 0,
      favorite: !!fav,
      lastPlayedAt: lastPlayed,
      updatedAt: now,
    };
  }

  static async deletePlaystate(uuid: string, itemId: string): Promise<void> {
    await getDb().exec(
      sql`DELETE FROM jellyfin_playstate WHERE uuid = ${uuid} AND item_id = ${itemId}`
    );
  }

  static async listResume(
    uuid: string,
    limit: number,
    kinds: string[] = ['movie', 'episode']
  ): Promise<JellyfinPlaystateRow[]> {
    const rows = await getDb().query<PlaystateDbRow>(
      sql`SELECT * FROM jellyfin_playstate
           WHERE uuid = ${uuid} AND played = 0 AND position_ticks > 0
           ORDER BY updated_at DESC
           LIMIT ${Math.max(limit * 3, 30)}`
    );
    return rows
      .map(toPlaystate)
      .filter((r) => kinds.includes(r.payload.k))
      .slice(0, limit);
  }

  static async listRecentEpisodesBySeries(
    uuid: string,
    limit: number
  ): Promise<JellyfinPlaystateRow[]> {
    const rows = await getDb().query<PlaystateDbRow>(
      sql`SELECT * FROM jellyfin_playstate
           WHERE uuid = ${uuid} AND (played = 1 OR position_ticks > 0)
           ORDER BY updated_at DESC
           LIMIT 500`
    );
    const seen = new Set<string>();
    const out: JellyfinPlaystateRow[] = [];
    for (const r of rows.map(toPlaystate)) {
      if (r.payload.k !== 'episode') continue;
      const key = `${r.payload.t}|${r.payload.i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  static async listFavorites(
    uuid: string,
    kinds?: string[]
  ): Promise<JellyfinPlaystateRow[]> {
    const rows = await getDb().query<PlaystateDbRow>(
      sql`SELECT * FROM jellyfin_playstate
           WHERE uuid = ${uuid} AND favorite = 1
           ORDER BY updated_at DESC
           LIMIT 500`
    );
    return rows
      .map(toPlaystate)
      .filter((r) => !kinds || kinds.includes(r.payload.k));
  }

  static async listPlayed(
    uuid: string,
    kinds?: string[]
  ): Promise<JellyfinPlaystateRow[]> {
    const rows = await getDb().query<PlaystateDbRow>(
      sql`SELECT * FROM jellyfin_playstate
           WHERE uuid = ${uuid} AND played = 1
           ORDER BY updated_at DESC
           LIMIT 500`
    );
    return rows
      .map(toPlaystate)
      .filter((r) => !kinds || kinds.includes(r.payload.k));
  }

  static async listForSeries(
    uuid: string,
    type: string,
    seriesId: string
  ): Promise<JellyfinPlaystateRow[]> {
    const rows = await getDb().query<PlaystateDbRow>(
      sql`SELECT * FROM jellyfin_playstate
           WHERE uuid = ${uuid} AND series_key = ${`${type}|${seriesId}`}`
    );
    return rows.map(toPlaystate).filter((r) => r.payload.k === 'episode');
  }

  static async pruneItems(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const res = await getDb().exec(
      sql`DELETE FROM jellyfin_items
           WHERE created_at < ${cutoff}
             AND NOT EXISTS (
               SELECT 1 FROM jellyfin_playstate p WHERE p.item_id = jellyfin_items.id
             )`
    );
    return res.rowCount;
  }

  static async getDisplayPrefs(
    uuid: string,
    prefId: string,
    client: string
  ): Promise<Record<string, unknown> | null> {
    const row = await getDb().maybeOne<{ payload: string }>(
      sql`SELECT payload FROM jellyfin_display_prefs
           WHERE uuid = ${uuid} AND pref_id = ${prefId} AND client = ${client}`
    );
    return row ? JSON.parse(row.payload) : null;
  }

  static async setDisplayPrefs(
    uuid: string,
    prefId: string,
    client: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await getDb().exec(
      sql`INSERT INTO jellyfin_display_prefs (uuid, pref_id, client, payload, updated_at)
          VALUES (${uuid}, ${prefId}, ${client}, ${JSON.stringify(payload)}, ${Date.now()})
          ON CONFLICT(uuid, pref_id, client) DO UPDATE SET
            payload = excluded.payload, updated_at = excluded.updated_at`
    );
  }
}
