import { useEffect, useRef } from "react";

type UsePollOptions<T> = {
  fetch: () => Promise<T>;
  onSuccess: (data: T) => void;
  intervalMs: number;
  enabled?: boolean;
};

/**
 * Polls `fetch` on an interval while `enabled` is true. Uses refs so `fetch` /
 * `onSuccess` always see the latest closure without resetting the interval on
 * every parent render.
 */
export function usePoll<T>(options: UsePollOptions<T>): void {
  const { fetch, onSuccess, intervalMs, enabled = true } = options;
  const fetchRef = useRef(fetch);
  const onSuccessRef = useRef(onSuccess);
  fetchRef.current = fetch;
  onSuccessRef.current = onSuccess;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const id = window.setInterval(() => {
      void fetchRef.current().then((data) => {
        onSuccessRef.current(data);
      });
    }, intervalMs);

    return () => window.clearInterval(id);
  }, [enabled, intervalMs]);
}
