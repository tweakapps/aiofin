import type { Migration } from './types.js';

export const jellyfin: Migration = {
  id: 27,
  name: 'jellyfin',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS jellyfin_items (
        id          TEXT PRIMARY KEY,
        payload     TEXT NOT NULL,
        created_at  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS jellyfin_playstate (
        uuid             TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        item_id          TEXT NOT NULL,
        payload          TEXT NOT NULL,
        position_ticks   INTEGER NOT NULL DEFAULT 0,
        runtime_ticks    INTEGER NOT NULL DEFAULT 0,
        played           INTEGER NOT NULL DEFAULT 0,
        play_count       INTEGER NOT NULL DEFAULT 0,
        favorite         INTEGER NOT NULL DEFAULT 0,
        last_played_at   INTEGER,
        updated_at       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (uuid, item_id)
      );

      CREATE INDEX IF NOT EXISTS idx_jellyfin_playstate_uuid_updated
        ON jellyfin_playstate (uuid, updated_at DESC);

      CREATE TABLE IF NOT EXISTS jellyfin_display_prefs (
        uuid        TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        pref_id     TEXT NOT NULL,
        client      TEXT NOT NULL,
        payload     TEXT NOT NULL,
        updated_at  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (uuid, pref_id, client)
      );
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS jellyfin_items (
        id          TEXT PRIMARY KEY,
        payload     TEXT NOT NULL,
        created_at  BIGINT NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS jellyfin_playstate (
        uuid             TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        item_id          TEXT NOT NULL,
        payload          TEXT NOT NULL,
        position_ticks   BIGINT NOT NULL DEFAULT 0,
        runtime_ticks    BIGINT NOT NULL DEFAULT 0,
        played           INTEGER NOT NULL DEFAULT 0,
        play_count       INTEGER NOT NULL DEFAULT 0,
        favorite         INTEGER NOT NULL DEFAULT 0,
        last_played_at   BIGINT,
        updated_at       BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (uuid, item_id)
      );

      CREATE INDEX IF NOT EXISTS idx_jellyfin_playstate_uuid_updated
        ON jellyfin_playstate (uuid, updated_at DESC);

      CREATE TABLE IF NOT EXISTS jellyfin_display_prefs (
        uuid        TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        pref_id     TEXT NOT NULL,
        client      TEXT NOT NULL,
        payload     TEXT NOT NULL,
        updated_at  BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (uuid, pref_id, client)
      );
    `,
  },
};
