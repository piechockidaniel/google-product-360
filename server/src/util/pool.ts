export interface PoolResult<T, R> {
  item: T;
  index: number;
  ok: boolean;
  value?: R;
  error?: unknown;
}

/**
 * Runs `fn` over `items` with at most `concurrency` calls in flight. Results
 * keep the input order; failures are captured per item instead of aborting
 * the whole batch (unless `stopOnError` is set).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  options: { stopOnError?: boolean; onResult?: (result: PoolResult<T, R>) => void } = {},
): Promise<PoolResult<T, R>[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: PoolResult<T, R>[] = new Array(items.length);
  let next = 0;
  let stopped = false;

  const worker = async () => {
    while (!stopped) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index] as T;
      let result: PoolResult<T, R>;
      try {
        result = { item, index, ok: true, value: await fn(item, index) };
      } catch (error) {
        result = { item, index, ok: false, error };
        if (options.stopOnError) stopped = true;
      }
      results[index] = result;
      options.onResult?.(result);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (stopped) {
    const failure = results.find((r) => r && !r.ok);
    throw failure?.error ?? new Error('Batch stopped');
  }
  return results;
}
