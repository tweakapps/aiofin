import { JellyfinRepository, TaskManager } from '@aiostreams/core';

const ITEM_MAX_AGE_MS = 180 * 24 * 3600 * 1000;
const PRUNE_INTERVAL_MS = 24 * 3600 * 1000;

export function registerJellyfinTasks(): void {
  TaskManager.register({
    id: 'prune-jellyfin-items',
    label: 'Prune Jellyfin id mappings',
    description:
      'Deletes hashed Jellyfin item id mappings older than 180 days that no watch state references. Browsing re-creates them.',
    category: 'users',
    kind: 'scheduled',
    intervalMs: PRUNE_INTERVAL_MS,
    enabled: true,
    destructive: true,
    multiReplica: 'single',
    run: async () => {
      const n = await JellyfinRepository.pruneItems(ITEM_MAX_AGE_MS);
      return { ok: true, message: `pruned ${n} jellyfin id mappings` };
    },
  });
}
