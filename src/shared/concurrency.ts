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

/**
 * A shared bound on concurrent calls to one resource, for work that is
 * started from many places at once (several `pMap` workers, say) but must not
 * overload what serves it. Calls past the bound wait in arrival order; a
 * waiting call has not started, so any timeout it sets begins only once it
 * holds a slot.
 */
export function createConcurrencyLimiter(
  limit: number,
): <T>(task: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `Concurrency limit must be a positive integer: ${String(limit)}`,
    );
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) {
      active += 1;
      next();
    }
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < limit) {
      active += 1;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}
