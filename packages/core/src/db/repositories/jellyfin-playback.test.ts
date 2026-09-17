import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb, initDb } from '../db.js';
import { JellyfinRepository as repo } from './jellyfin.js';

const descriptor = { k: 'movie', t: 'movie', i: 'tt123' } as const;
let directory: string;
let uri: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'jellyfin-playback-'));
  uri = `sqlite://${join(directory, 'state.db')}`;
  await initDb(uri);
  for (const uuid of ['a', 'b']) {
    await getDb().exec(
      `INSERT INTO users (uuid, password_hash, config, config_salt) VALUES (?, '', '', '')`,
      [uuid]
    );
  }
});

afterEach(async () => {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
});

const event = (
  sessionId: string | undefined,
  event: 'start' | 'progress' | 'stop',
  positionTicks?: number,
  uuid = 'a',
  itemId = 'item'
) =>
  repo.recordPlayback(uuid, itemId, descriptor, {
    sessionId,
    event,
    positionTicks,
    runtimeTicks: 1000,
  });

const state = () => repo.getPlaystate('a', 'item');

test('migration and repository reject old unfinished sessions and duplicate starts after reopen', async () => {
  await event('old', 'start', 0);
  await event('old', 'progress', 200);
  await event('new', 'start', 0);
  await event('new', 'progress', 400);
  await closeDb();
  await initDb(uri);
  await event('old', 'start', 0);
  await event('old', 'stop', 950);
  await event('new', 'start', 0);
  const row = await state();
  assert.equal(row?.positionTicks, 400);
  assert.equal(row?.playCount, 0);
  assert.equal(row?.played, false);
});

test('completion is atomic and persistent; a distinct session counts a rewatch', async () => {
  await event('first', 'start', 0);
  await Promise.all([
    event('first', 'stop', 950),
    event('first', 'progress', 100),
    event('first', 'stop', 950),
  ]);
  await closeDb();
  await initDb(uri);
  await event('first', 'start', 0);
  await event('first', 'stop', 950);
  assert.equal((await state())?.playCount, 1);
  await event('second', 'start', 0);
  await event('second', 'progress', 300);
  await event('first', 'stop', 950);
  assert.equal((await state())?.positionTicks, 300);
  await event('second', 'stop', 950);
  assert.equal((await state())?.playCount, 2);
});

test('atomic upserts preserve concurrent favorite, resume and count patches', async () => {
  await Promise.all([
    repo.upsertPlaystate('a', 'item', descriptor, { favorite: true }),
    repo.upsertPlaystate('a', 'item', descriptor, { positionTicks: 123 }),
    ...Array.from({ length: 8 }, () =>
      repo.upsertPlaystate('a', 'item', descriptor, {
        played: true,
        incrementPlayCount: 'if-unplayed',
      })
    ),
  ]);
  const row = await state();
  assert.equal(row?.favorite, true);
  assert.equal(row?.positionTicks, 123);
  assert.equal(row?.playCount, 1);
});

test('session events are isolated by profile and item', async () => {
  await event('shared', 'stop', 950);
  await event('shared', 'progress', 200, 'b');
  await event('shared', 'progress', 300, 'a', 'other');
  assert.equal((await repo.getPlaystate('b', 'item'))?.positionTicks, 200);
  assert.equal((await repo.getPlaystate('a', 'other'))?.positionTicks, 300);
});

test('accepts new sessions beyond the history bound and retains recent replay protection', async () => {
  for (let i = 0; i < 258; i++) await event(`session-${i}`, 'start', i);
  assert.equal((await state())?.positionTicks, 257);
  await closeDb();
  await initDb(uri);
  await event('session-256', 'start', 0);
  await event('session-256', 'stop', 950);
  assert.equal((await state())?.positionTicks, 257);
  const record = await getDb().one<{ history: string }>(
    `SELECT history FROM jellyfin_playback_state WHERE uuid = ? AND item_id = ?`,
    ['a', 'item']
  );
  assert.equal(JSON.parse(record.history).length, 256);
});

test('runtime precedence uses client, selected source, metadata fallback, then stored duration', async () => {
  for (const [itemId, client, source, expected, played] of [
    ['client', 2000, 'file', 2000, false],
    ['source', undefined, 'file', 1000, true],
    ['metadata', undefined, undefined, 1500, false],
    ['invalid-client', -1, 'file', 1000, true],
  ] as const) {
    await repo.upsertPlaystate('a', itemId, descriptor, { runtimeTicks: 3000 });
    await repo.rememberPlaybackRuntimes('a', itemId, {
      fallback: 1500,
      sources: [{ id: 'file', ticks: 1000 }],
    });
    await repo.recordPlayback('a', itemId, descriptor, {
      event: 'stop',
      sessionId: itemId,
      positionTicks: 950,
      runtimeTicks: client,
      mediaSourceId: source,
    });
    const row = await repo.getPlaystate('a', itemId);
    assert.equal(row?.runtimeTicks, expected);
    assert.equal(row?.played, played);
    assert.equal(row?.playCount, played ? 1 : 0);
  }
  await repo.upsertPlaystate('a', 'stored', descriptor, { runtimeTicks: 1000 });
  await repo.recordPlayback('a', 'stored', descriptor, {
    event: 'stop',
    positionTicks: 950,
  });
  assert.equal((await repo.getPlaystate('a', 'stored'))?.playCount, 1);
});

test('legacy no-session events keep the pre-existing fallback semantics', async () => {
  await event(undefined, 'stop', 950);
  await event(undefined, 'start', 0);
  await event(undefined, 'progress', 100);
  assert.equal((await state())?.played, false);
  assert.equal((await state())?.playCount, 1);
  await event(undefined, 'start', 0);
  await event(undefined, 'progress', 300);
  await event(undefined, 'stop', undefined);
  const row = await state();
  assert.equal(row?.positionTicks, 300);
  assert.equal(row?.played, false);
  await event(undefined, 'stop', 950);
  assert.equal((await state())?.playCount, 2);
});
