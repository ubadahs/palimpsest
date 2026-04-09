/**
 * Bounded-concurrency async mapper.
 *
 * Unlike the simpler batch-and-await pattern (`for + slice + Promise.all`),
 * this keeps all worker slots busy at all times — a slow item in one slot
 * doesn't block the others from pulling the next item.
 *
 * Results preserve input order regardless of completion order.
 */
export async function pMap<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  options?: { concurrency?: number },
): Promise<R[]> {
  const concurrency = Math.max(1, options?.concurrency ?? Infinity);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await mapper(items[i]!, i);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
