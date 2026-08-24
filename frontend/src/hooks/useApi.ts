import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';

/** Loads once (and on demand) with explicit loading/error states for the UI to render. */
export function useApi<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    loader(controller.signal)
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err : new Error('Something went wrong'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload, setData };
}

/** Wraps a mutating call so pages get pending/error state without repeating try/catch. */
export function useMutation<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const run = useCallback(
    async (...args: TArgs): Promise<TResult | null> => {
      setPending(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Something went wrong'));
        return null;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );

  return { run, pending, error, setError };
}
