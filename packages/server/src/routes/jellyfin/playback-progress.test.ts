import express, { type Request, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JellyfinRequestContext } from './context.js';

type Playstate = {
  positionTicks: number;
  runtimeTicks: number;
  played: boolean;
  playCount: number;
  lastPlayedAt?: number | null;
};

type Patch = Partial<Omit<Playstate, 'playCount'>> & {
  incrementPlayCount?: boolean | 'if-unplayed';
};

const mocks = vi.hoisted(() => ({
  rows: new Map<string, Playstate>(),
  getPlaystate: vi.fn(),
  upsertPlaystate: vi.fn(),
  getMetaLoose: vi.fn(),
}));

vi.mock('@aiostreams/core', () => ({
  config: { bootstrap: {}, api: {} },
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  decodeJellyfinId: vi.fn(async () => ({ k: 'movie', t: 'movie', i: 'tt123' })),
  decryptString: vi.fn(),
  encryptString: vi.fn(),
  JellyfinRepository: {
    getPlaystate: mocks.getPlaystate,
    upsertPlaystate: mocks.upsertPlaystate,
  },
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
          service: { getMetaLoose: mocks.getMetaLoose },
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

async function send(
  event: keyof typeof PATHS,
  position?: unknown,
  profile = 'profile-a',
  session?: string
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
    }),
  });
  expect(response.status).toBe(204);
}

function state(profile = 'profile-a') {
  return mocks.rows.get(`${profile}:${ITEM}`);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.rows.clear();
  mocks.getMetaLoose.mockResolvedValue({ runtime: RUNTIME });
  mocks.getPlaystate.mockImplementation(
    async (uuid: string, itemId: string) => {
      const row = mocks.rows.get(`${uuid}:${itemId}`);
      return row ? { ...row } : null;
    }
  );
  mocks.upsertPlaystate.mockImplementation(
    async (
      uuid: string,
      itemId: string,
      _descriptor: unknown,
      patch: Patch
    ) => {
      const key = `${uuid}:${itemId}`;
      const previous = mocks.rows.get(key) ?? {
        positionTicks: 0,
        runtimeTicks: 0,
        played: false,
        playCount: 0,
      };
      const increment =
        patch.incrementPlayCount === 'if-unplayed'
          ? !previous.played
          : patch.incrementPlayCount === true;
      const row = {
        positionTicks: patch.positionTicks ?? previous.positionTicks,
        runtimeTicks: patch.runtimeTicks ?? previous.runtimeTicks,
        played: patch.played ?? previous.played,
        playCount: previous.playCount + Number(increment),
        lastPlayedAt:
          patch.lastPlayedAt === undefined
            ? previous.lastPlayedAt
            : patch.lastPlayedAt,
      };
      mocks.rows.set(key, row);
      return { ...row };
    }
  );
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
});

describe('mounted Jellyfin playback progress', () => {
  it('ignores delayed events from a completed session while allowing a new rewatch', async () => {
    await send('start', 0, 'profile-a', 'session-a');
    await send('progress', 950 * SECOND, 'profile-a', 'session-a');
    await send('start', 0, 'profile-a', 'session-a');
    await send('progress', 100 * SECOND, 'profile-a', 'session-a');
    await send('stop', 100 * SECOND, 'profile-a', 'session-a');
    expect(state()).toMatchObject({
      played: true,
      playCount: 1,
      positionTicks: 0,
    });
    await send('start', 0, 'profile-a', 'session-b');
    await send('progress', 200 * SECOND, 'profile-a', 'session-b');
    await send('stop', 950 * SECOND, 'profile-a', 'session-a');
    expect(state()).toMatchObject({
      played: false,
      playCount: 1,
      positionTicks: 200 * SECOND,
    });
    await send('stop', 950 * SECOND, 'profile-a', 'session-b');
    expect(state()).toMatchObject({
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
    expect(state()).toMatchObject({
      played: true,
      playCount: 1,
      positionTicks: 0,
    });
  });

  it('does not share completed session markers between profiles', async () => {
    await send('stop', 950 * SECOND, 'profile-a', 'shared');
    await send('progress', 200 * SECOND, 'profile-b', 'shared');
    expect(state('profile-b')).toMatchObject({
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
      expect(state()).toMatchObject({
        played: true,
        playCount: 1,
        positionTicks: 0,
      });
    }
  );

  it('counts completion on progress before an explicit stop and duplicate stop', async () => {
    await send('progress', 900 * SECOND);
    expect(state()).toMatchObject({
      played: true,
      playCount: 1,
      positionTicks: 0,
    });
    await send('stop', 950 * SECOND);
    await send('stop', 950 * SECOND);
    expect(state()).toMatchObject({
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
    expect(state()).toMatchObject({
      played: false,
      playCount: 0,
      positionTicks: 250 * SECOND,
    });
  });

  it('counts a direct completing stop once', async () => {
    await send('stop', 900 * SECOND);
    await send('stop', 900 * SECOND);
    expect(state()).toMatchObject({
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
      expect(state()).toMatchObject({
        played: false,
        playCount: 1,
        positionTicks: 0,
      });
      await send('stop', 950 * SECOND);
      expect(state()).toMatchObject({
        played: true,
        playCount: 2,
        positionTicks: 0,
      });
    }
  );

  it('recognizes a new viewing from below-threshold progress', async () => {
    await send('stop', 950 * SECOND);
    await send('progress', 100 * SECOND);
    expect(state()).toMatchObject({
      played: false,
      playCount: 1,
      positionTicks: 100 * SECOND,
    });
    await send('progress', 900 * SECOND);
    await send('stop');
    expect(state()).toMatchObject({
      played: true,
      playCount: 2,
      positionTicks: 0,
    });
  });

  it('does not throttle a completion threshold crossing', async () => {
    await send('progress', 899 * SECOND);
    await send('progress', 900 * SECOND);
    expect(state()).toMatchObject({
      played: true,
      playCount: 1,
      positionTicks: 0,
    });
  });

  it('does not throttle below-threshold progress after completion', async () => {
    await send('stop', 900 * SECOND);
    await send('progress', 899 * SECOND);
    expect(state()).toMatchObject({
      played: false,
      playCount: 1,
      positionTicks: 899 * SECOND,
    });
    await send('stop', 900 * SECOND);
    expect(state()).toMatchObject({
      played: true,
      playCount: 2,
      positionTicks: 0,
    });
  });

  it('keeps completion, resume state, and throttling isolated by profile', async () => {
    await send('progress', 899 * SECOND, 'profile-a');
    await send('progress', 900 * SECOND, 'profile-b');
    await send('stop', undefined, 'profile-b');
    expect(state('profile-a')).toMatchObject({
      played: false,
      playCount: 0,
      positionTicks: 899 * SECOND,
    });
    expect(state('profile-b')).toMatchObject({
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
      expect(state()).toMatchObject({
        played: false,
        playCount: 0,
        positionTicks: 200 * SECOND,
      });
      await send('stop', 900 * SECOND);
      await send('progress', position);
      await send('stop', position);
      expect(state()).toMatchObject({
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
    expect(state()).toMatchObject({
      played: true,
      playCount: 1,
      positionTicks: 0,
    });
  });
});
