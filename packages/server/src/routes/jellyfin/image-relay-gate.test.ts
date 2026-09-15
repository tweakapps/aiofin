import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRelayGate } from './image-relay-gate.js';

describe('createRelayGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves up to `limit` acquires immediately', async () => {
    const gate = createRelayGate(2, 5000);
    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    expect(typeof r1).toBe('function');
    expect(typeof r2).toBe('function');
  });

  it('queues the limit+1th acquire until a release happens', async () => {
    const gate = createRelayGate(1, 5000);
    const release1 = await gate.acquire();

    let resolved = false;
    const p = gate.acquire().then((release) => {
      resolved = true;
      return release;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    release1();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
    const release2 = await p;
    expect(typeof release2).toBe('function');
  });

  it('fails open after maxWaitMs: waiter resolves without a slot, its release is a no-op', async () => {
    const gate = createRelayGate(1, 1000);
    const release1 = await gate.acquire();

    let resolved = false;
    let waiterRelease: (() => void) | null = null;
    const p = gate.acquire().then((release) => {
      resolved = true;
      waiterRelease = release;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(resolved).toBe(true);

    // Calling the fail-open release should not free a "real" slot: a
    // subsequent acquire from a fresh caller must still queue (limit is 1
    // and release1 is still held).
    waiterRelease!();
    let thirdResolved = false;
    const p3 = gate.acquire().then(() => {
      thirdResolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(thirdResolved).toBe(false);

    // Releasing the real held slot (release1) should let the third
    // acquire proceed.
    release1();
    await vi.advanceTimersByTimeAsync(0);
    expect(thirdResolved).toBe(true);
    await p3;
  });

  it('releases are idempotent', async () => {
    const gate = createRelayGate(1, 5000);
    const release1 = await gate.acquire();

    let resolved = false;
    const p = gate.acquire().then(() => {
      resolved = true;
    });

    release1();
    release1(); // calling twice must not double-free / go negative
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
    await p;
  });

  it('drains waiters in FIFO order', async () => {
    const gate = createRelayGate(1, 5000);
    const release1 = await gate.acquire();

    const order: number[] = [];
    const p1 = gate.acquire().then((release) => {
      order.push(1);
      return release;
    });
    const p2 = gate.acquire().then((release) => {
      order.push(2);
      return release;
    });
    const p3 = gate.acquire().then((release) => {
      order.push(3);
      return release;
    });

    release1();
    await vi.advanceTimersByTimeAsync(0);
    const release2 = await p1;
    expect(order).toEqual([1]);

    release2();
    await vi.advanceTimersByTimeAsync(0);
    const release3 = await p2;
    expect(order).toEqual([1, 2]);

    release3();
    await vi.advanceTimersByTimeAsync(0);
    await p3;
    expect(order).toEqual([1, 2, 3]);
  });
});
