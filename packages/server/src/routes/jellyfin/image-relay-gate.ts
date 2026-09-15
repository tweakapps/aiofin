/** Bounds concurrent image relays. Over-limit callers wait up to maxWaitMs, then
 *  proceed anyway (fail-open) — an image is never worth blocking or erroring. */
export function createRelayGate(limit: number, maxWaitMs: number) {
  let active = 0;
  const queue: Array<{
    settled: boolean;
    resolve: (release: () => void) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  function makeRelease(takesSlot: boolean): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!takesSlot) return;
      active--;
      drain();
    };
  }

  function drain() {
    while (active < limit && queue.length > 0) {
      const waiter = queue.shift()!;
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      active++;
      waiter.resolve(makeRelease(true));
    }
  }

  async function acquire(): Promise<() => void> {
    if (active < limit) {
      active++;
      return makeRelease(true);
    }
    return new Promise<() => void>((resolve) => {
      const entry: {
        settled: boolean;
        resolve: (release: () => void) => void;
        timer: ReturnType<typeof setTimeout>;
      } = {
        settled: false,
        resolve,
        timer: setTimeout(() => {
          if (entry.settled) return;
          entry.settled = true;
          const idx = queue.indexOf(entry);
          if (idx !== -1) queue.splice(idx, 1);
          // Fail-open: proceed without ever having taken a slot.
          resolve(makeRelease(false));
        }, maxWaitMs),
      };
      queue.push(entry);
    });
  }

  return { acquire };
}

export type RelayGate = ReturnType<typeof createRelayGate>;
