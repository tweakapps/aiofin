import express, { type Request, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JellyfinRequestContext } from './context.js';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDriver } from '../../../../core/src/db/driver/sqlite.js';
import { runMigrations } from '../../../../core/src/db/migrations/runner.js';
import { JellyfinRepository } from '../../../../core/src/db/repositories/jellyfin.js';

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as SqliteDriver,
  getMetaLoose: vi.fn(),
  buildMediaSources: vi.fn(),
  decode: vi.fn(),
}));

vi.mock('../../../../core/src/db/db.js', () => ({ getDb: () => mocks.db }));
vi.mock('../../../../core/src/logging/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@aiostreams/core', () => ({
  config: {
    bootstrap: {},
    api: { jellyfinAttachSourcesClients: [], jellyfinMaxPlaybackSources: 20 },
  },
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  decodeJellyfinId: mocks.decode,
  decryptString: vi.fn(),
  encryptString: vi.fn(),
  JellyfinRepository,
  makeRequest: vi.fn(() => {
    throw new Error('Unexpected upstream request');
  }),
  recallImages: vi.fn(),
  rememberImages: vi.fn(),
  parseRuntimeToTicks: vi.fn((runtime: number | undefined) => runtime),
}));

vi.mock('./context.js', () => ({
  jf:
    (
      handler: (
        req: Request,
        res: express.Response,
        ctx: JellyfinRequestContext
      ) => Promise<void> | void
    ): RequestHandler =>
    async (req, res, next) => {
      try {
        await handler(req, res, {
          uuid: req.get('x-test-profile') ?? 'profile-a',
          userId: 'user-a',
          client: { name: 'Infuse', deviceId: 'device-a' },
          service: {
            getMetaLoose: mocks.getMetaLoose,
            buildMediaSources: mocks.buildMediaSources,
            resolveVideoId: async () => 'tt123',
          },
        } as unknown as JellyfinRequestContext);
      } catch (error) {
        next(error);
      }
    },
  qs: (req: Request, name: string) =>
    Object.entries(req.query).find(
      ([key, value]) =>
        key.toLowerCase() === name.toLowerCase() && typeof value === 'string'
    )?.[1],
  qi: vi.fn(),
  param: (req: Request, name: string) => req.params[name] ?? '',
}));

const SECOND = 10_000_000;
const RUNTIME = 1000 * SECOND;
const ITEM = 'abc123';
const PATHS = {
  start: '/Sessions/Playing',
  progress: '/Sessions/Playing/Progress',
  stop: '/Sessions/Playing/Stopped',
};

let server: Server;
let baseUrl: string;
let directory: string;

async function send(
  event: keyof typeof PATHS,
  position?: unknown,
  profile = 'profile-a',
  session?: string,
  extra: Record<string, unknown> = {}
) {
  const response = await fetch(`${baseUrl}${PATHS[event]}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-profile': profile,
    },
    body: JSON.stringify({
      ItemId: ITEM,
      PositionTicks: position,
      PlaySessionId: session,
      ...extra,
    }),
  });
  expect(response.status).toBe(204);
}

function state(profile = 'profile-a') {
  return JellyfinRepository.getPlaystate(profile, ITEM);
}

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'jellyfin-route-'));
  mocks.db = new SqliteDriver(join(directory, 'state.db'));
  await runMigrations(mocks.db);
  for (const uuid of ['profile-a', 'profile-b']) {
    await mocks.db.exec(
      `INSERT INTO users (uuid, password_hash, config, config_salt)
      VALUES (?, '', '', '')`,
      [uuid]
    );
    await JellyfinRepository.rememberPlaybackRuntimes(uuid, ITEM, {
      fallback: RUNTIME,
      sources: [],
    });
  }
  mocks.decode.mockResolvedValue({ k: 'movie', t: 'movie', i: 'tt123' });
  mocks.getMetaLoose.mockResolvedValue({ runtime: RUNTIME });
  mocks.buildMediaSources.mockResolvedValue({ sources: [], errors: [] });
  const { default: router } = await import('./playback.js');
  const app = express();
  app.use(express.json());
  app.use('/jellyfin', router);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jellyfin`;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  await mocks.db.close();
  await rm(directory, { recursive: true, force: true });
});

describe('mounted Jellyfin playback progress', () => {
  it('honors client runtime without requesting metadata on heartbeat', async () => {
    await send('stop', 950 * SECOND, 'profile-a', 'client-runtime', {
      RunTimeTicks: 2000 * SECOND,
    });
    expect(await state()).toMatchObject({
      played: false,
      playCount: 0,
      runtimeTicks: 2000 * SECOND,
      positionTicks: 950 * SECOND,
    });
    expect(mocks.getMetaLoose).not.toHaveBeenCalled();
  });

  it('uses the selected source duration when no client runtime is provided', async () => {
    await JellyfinRepository.rememberPlaybackRuntimes('profile-a', ITEM, {
      fallback: 2000 * SECOND,
      sources: [{ id: 'selected', ticks: RUNTIME }],
    });
    await send('stop', 950 * SECOND, 'profile-a', 'source-runtime', {
      MediaSourceId: 'selected',
    });
    expect(await state()).toMatchObject({
      played: true,
      playCount: 1,
      runtimeTicks: RUNTIME,
    });
  });
  it('ignores an older unfinished session after a newer start', async () => {
    await send('start', 0, 'profile-a', 'older');
    await send('progress', 200 * SECOND, 'profile-a', 'older');
    await send('start', 0, 'profile-a', 'newer');
    await send('progress', 400 * SECOND, 'profile-a', 'newer');
    await send('start', 0, 'profile-a', 'older');
    await send('stop', 950 * SECOND, 'profile-a', 'older');
    expect(await state()).toMatchObject({
      played: false,
      playCount: 0,
      positionTicks: 400 * SECOND,
    });
  });

  it('does not reset resume on duplicate starts', async () => {
    await send('start', 0, 'profile-a', 'same');
    await send('progress', 400 * SECOND, 'profile-a', 'same');
    await send('start', 0, 'profile-a', 'same');
    expect((await state())?.positionTicks).toBe(400 * SECOND);
  });
  it('ignores delayed events from a completed session while allowing a new rewatch', async () => {
    await send('start', 0, 'profile-a', 'session-a');
    await send('progress', 950 * SECOND, 'profile-a', 'session-a');
    await send('start', 0, 'profile-a', 'session-a');
    await send('progress', 100 * SECOND, 'profile-a', 'session-a');
    await send('stop', 100 * SECOND, 'profile-a', 'session-a');
    expect(await state()).toMatchObject({
      played: true,
      playCount: 1,
      positionTicks: 0,
    });
    await send('start', 0, 'profile-a', 'session-b');
    await send('progress', 200 * SECOND, 'profile-a', 'session-b');
    await send('stop', 950 * SECOND, 'profile-a', 'session-a');
    expect(await state()).toMatchObject({
      played: false,
      playCount: 1,
      positionTicks: 200 * SECOND,
    });
    await send('stop', 950 * SECOND, 'profile-a', 'session-b');
    expect(await state()).toMatchObject({
      played: true,
      playCount: 2,
      positionTicks: 0,
    });
  });

  it('serializes simultaneous completion and a delayed progress event', async () => {
    await send('start', 0, 'profile-a', 'concurrent');
    await Promise.all([
      send('stop', 950 * SECOND, 'profile-a', 'concurrent'),
      send('progress', 100 * SECOND, 'profile-a', 'concurrent'),
      send('stop', 950 * SECOND, 'profile-a', 'concurrent'),
    ]);
    expect(await state()).toMatchObject({
      played: true,
      playCount: 1,
      positionTicks: 0,
    });
  });

  it('does not share completed session markers between profiles', async () => {
    await send('stop', 950 * SECOND, 'profile-a', 'shared');
    await send('progress', 200 * SECOND, 'profile-b', 'shared');
    expect(await state('profile-b')).toMatchObject({
      played: false,
      playCount: 0,
      positionTicks: 200 * SECOND,
    });
  });

  it.each(['post', 'delete'])(
    'preserves completion after progress and a missing-position %s stop',
    async (method) => {
      await send('progress', 900 * SECOND);
      if (method === 'post') {
        await send('stop');
      } else {
        const response = await fetch(`${baseUrl}/PlayingItems/${ITEM}`, {
          method: 'DELETE',
        });
        expect(response.status).toBe(204);
      }
      expect(await state()).toMatchObject({
        played: true,
        playCount: 1,
        positionTicks: 0,
      });
    }
  );

  it('counts completion on progress before an explicit stop and duplicate stop', async () => {
    await send('progress', 900 * SECOND);
    expect(await state()).toMatchObject({
      played: true,
      playCount: 1,
      positionTicks: 0,
    });
    await send('stop', 950 * SECOND);
    await send('stop', 950 * SECOND);
    expect(await state()).toMatchObject({
      played: true,
      playCount: 1,
      positionTicks: 0,
    });
  });

  it('retains resume position for an early stop and a missing-position duplicate', async () => {
    await send('start', 0);
    await send('progress', 200 * SECOND);
    await send('stop', 250 * SECOND);
    await send('stop');
    expect(await state()).toMatchObject({
      played: false,
      playCount: 0,
      positionTicks: 250 * SECOND,
    });
  });

  it('counts a direct completing stop once', async () => {
    await send('stop', 900 * SECOND);
    await send('stop', 900 * SECOND);
    expect(await state()).toMatchObject({
      played: true,
      playCount: 1,
      positionTicks: 0,
    });
  });

  it.each([undefined, 0])(
    'starts a new viewing with position %s after completion',
    async (position) => {
      await send('stop', 950 * SECOND);
      await send('start', position);
      expect(await state()).toMatchObject({
        played: false,
        playCount: 1,
        positionTicks: 0,
      });
      await send('stop', 950 * SECOND);
      expect(await state()).toMatchObject({
        played: true,
        playCount: 2,
        positionTicks: 0,
      });
    }
  );

  it('recognizes a new viewing from below-threshold progress', async () => {
    await send('stop', 950 * SECOND);
    await send('progress', 100 * SECOND);
    expect(await state()).toMatchObject({
      played: false,
      playCount: 1,
      positionTicks: 100 * SECOND,
    });
    await send('progress', 900 * SECOND);
    await send('stop');
    expect(await state()).toMatchObject({
      played: true,
      playCount: 2,
      positionTicks: 0,
    });
  });

  it('does not throttle a completion threshold crossing', async () => {
    await send('progress', 899 * SECOND);
    await send('progress', 900 * SECOND);
    expect(await state()).toMatchObject({
      played: true,
      playCount: 1,
      positionTicks: 0,
    });
  });

  it('does not throttle below-threshold progress after completion', async () => {
    await send('stop', 900 * SECOND);
    await send('progress', 899 * SECOND);
    expect(await state()).toMatchObject({
      played: false,
      playCount: 1,
      positionTicks: 899 * SECOND,
    });
    await send('stop', 900 * SECOND);
    expect(await state()).toMatchObject({
      played: true,
      playCount: 2,
      positionTicks: 0,
    });
  });

  it('keeps completion, resume state, and throttling isolated by profile', async () => {
    await send('progress', 899 * SECOND, 'profile-a');
    await send('progress', 900 * SECOND, 'profile-b');
    await send('stop', undefined, 'profile-b');
    expect(await state('profile-a')).toMatchObject({
      played: false,
      playCount: 0,
      positionTicks: 899 * SECOND,
    });
    expect(await state('profile-b')).toMatchObject({
      played: true,
      playCount: 1,
      positionTicks: 0,
    });
  });

  it.each([-1, 'NaN', 'Infinity', '1e309', true, false, [], {}, ' ', null])(
    'ignores invalid ticks %j without losing resume or completion',
    async (position) => {
      await send('stop', 200 * SECOND);
      await send('progress', position);
      await send('stop', position);
      expect(await state()).toMatchObject({
        played: false,
        playCount: 0,
        positionTicks: 200 * SECOND,
      });
      await send('stop', 900 * SECOND);
      await send('progress', position);
      await send('stop', position);
      expect(await state()).toMatchObject({
        played: true,
        playCount: 1,
        positionTicks: 0,
      });
    }
  );

  it('accepts numeric ticks in a case-insensitive query on the legacy routes', async () => {
    const progress = await fetch(
      `${baseUrl}/PlayingItems/${ITEM}/Progress?positionticks=${900 * SECOND}`,
      { method: 'POST' }
    );
    expect(progress.status).toBe(204);
    const stop = await fetch(
      `${baseUrl}/PlayingItems/${ITEM}?PositionTicks=${950 * SECOND}`,
      { method: 'DELETE' }
    );
    expect(stop.status).toBe(204);
    expect(await state()).toMatchObject({
      played: true,
      playCount: 1,
      positionTicks: 0,
    });
  });
});
