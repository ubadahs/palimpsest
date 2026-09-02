/**
 * Bounded-concurrency async mapper.
 *
 * Unlike the simpler batch-and-await pattern (`for + slice + Promise.all`),
 * this keeps all worker slots busy at all times — a slow item in one slot
 * doesn't block the others from pulling the next item.
 *
 * Results preserve input order regardless of completion order, so a caller
 * that appends them in sequence produces the same output at any concurrency.
 *
 * The first rejection stops the dispatch of further items: workers already
 * mid-item finish that item, no new item starts, and the first error is
 * rethrown. A fatal provider error therefore costs at most `concurrency`
 * calls, not the rest of the queue.
 */
export async function pMap<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  options?: { concurrency?: number },
): Promise<R[]> {
  const concurrency = Math.max(1, options?.concurrency ?? Infinity);
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed && nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = await mapper(items[i]!, i);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Share one in-flight promise between callers that ask for the same key.
 *
 * Concurrent workers can issue identical model requests before the first has
 * returned and populated the exact-result cache; with this, the second caller
 * awaits the first request instead of paying for its own. Settled entries are
 * dropped so a later identical request goes through the normal cache path.
 */
export function dedupeInFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const started = start().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}
