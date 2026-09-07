import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectConcurrent } from './concurrency.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('collectConcurrent', () => {
  it('keeps input order regardless of completion order', async () => {
    const out = await collectConcurrent(
      [50, 1, 40, 2, 30, 3],
      async (d, i) => {
        await sleep(d);
        return [i];
      },
      { concurrency: 3 }
    );
    assert.deepEqual(out, [0, 1, 2, 3, 4, 5]);
  });

  it('never exceeds the configured concurrency', async () => {
    let live = 0;
    let peak = 0;
    await collectConcurrent(
      Array.from({ length: 40 }, (_, i) => i),
      async () => {
        live++;
        peak = Math.max(peak, live);
        await sleep(5);
        live--;
        return [1];
      },
      { concurrency: 4 }
    );
    assert.equal(peak, 4);
  });

  it('stops claiming work once the target is met', async () => {
    let started = 0;
    const out = await collectConcurrent(
      Array.from({ length: 100 }, (_, i) => i),
      async () => {
        started++;
        await sleep(2);
        return [1, 1];
      },
      { concurrency: 4, target: 10 }
    );
    assert.ok(out.length >= 10);
    assert.ok(started < 20, `started ${started}`);
  });

  it('does not let one slow item hold back the ones behind it', async () => {
    const finished: number[] = [];
    await collectConcurrent(
      [200, 1, 1, 1, 1, 1],
      async (d, i) => {
        await sleep(d);
        finished.push(i);
        return [i];
      },
      { concurrency: 2 }
    );
    assert.equal(finished.at(-1), 0);
  });

  it('skips a throwing item without failing the batch', async () => {
    const errors: string[] = [];
    const out = await collectConcurrent(
      [1, 2, 3, 4],
      async (n) => {
        if (n % 2 === 0) throw new Error(`boom ${n}`);
        return [n];
      },
      { concurrency: 2, onError: (e) => errors.push((e as Error).message) }
    );
    assert.deepEqual(out, [1, 3]);
    assert.deepEqual(errors, ['boom 2', 'boom 4']);
  });

  it('handles empty input and clamps a nonsensical concurrency', async () => {
    assert.deepEqual(
      await collectConcurrent([], async () => [1], { concurrency: 8 }),
      []
    );
    assert.deepEqual(
      await collectConcurrent([1, 2, 3], async (n) => [n], { concurrency: 0 }),
      [1, 2, 3]
    );
  });
});
