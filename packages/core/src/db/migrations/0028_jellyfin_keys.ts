import type { Migration } from './types.js';

export const jellyfinKeys: Migration = {
  id: 28,
  name: 'jellyfin_keys',
  up: {
    sqlite: `
      ALTER TABLE jellyfin_playstate ADD COLUMN series_key TEXT;

      UPDATE jellyfin_playstate
         SET series_key = json_extract(payload, '$.t') || '|' || json_extract(payload, '$.i')
       WHERE json_extract(payload, '$.k') = 'episode';

      CREATE INDEX IF NOT EXISTS idx_jellyfin_playstate_series
        ON jellyfin_playstate (uuid, series_key);

      CREATE INDEX IF NOT EXISTS idx_jellyfin_items_created
        ON jellyfin_items (created_at);
    `,
    postgres: `
      ALTER TABLE jellyfin_playstate ADD COLUMN IF NOT EXISTS series_key TEXT;

      UPDATE jellyfin_playstate
         SET series_key = (payload::jsonb ->> 't') || '|' || (payload::jsonb ->> 'i')
       WHERE payload::jsonb ->> 'k' = 'episode';

      CREATE INDEX IF NOT EXISTS idx_jellyfin_playstate_series
        ON jellyfin_playstate (uuid, series_key);

      CREATE INDEX IF NOT EXISTS idx_jellyfin_items_created
        ON jellyfin_items (created_at);
    `,
  },
};
