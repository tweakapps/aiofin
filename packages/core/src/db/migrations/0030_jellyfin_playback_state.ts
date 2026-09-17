import type { Migration } from './types.js';

const schema = `
  CREATE TABLE jellyfin_playback_state (
    uuid TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    generation BIGINT NOT NULL DEFAULT 0,
    session_id TEXT,
    history TEXT NOT NULL DEFAULT '[]',
    completed INTEGER NOT NULL DEFAULT 0,
    last_event TEXT,
    runtimes TEXT NOT NULL DEFAULT '{}',
    updated_at BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (uuid, item_id)
  );
`;

export const jellyfinPlaybackState: Migration = {
  id: 30,
  name: 'jellyfin_playback_state',
  up: { sqlite: schema, postgres: schema },
};
