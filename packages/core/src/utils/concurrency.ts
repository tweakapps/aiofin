export async function collectConcurrent<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R[]>,
  opts: {
    concurrency: number;
    target?: number;
    onError?: (error: unknown, item: T, index: number) => void;
  }
): Promise<R[]> {
  const concurrency = Math.max(1, Math.trunc(opts.concurrency));
  const target = opts.target ?? Infinity;
  const results: R[][] = items.map(() => []);
  let cursor = 0;
  let collected = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length && collected < target) {
      const index = cursor++;
      try {
        const batch = await fn(items[index], index);
        results[index] = batch;
        collected += batch.length;
      } catch (error) {
        opts.onError?.(error, items[index], index);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results.flat();
}
