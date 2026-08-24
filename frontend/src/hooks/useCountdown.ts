import { useEffect, useRef, useState } from 'react';

/**
 * Counts down to an absolute server timestamp.
 *
 * Two details that matter:
 *   • it counts to `expiresAt`, never from a locally-started N-second timer, so a
 *     backgrounded tab or a sleeping laptop cannot drift out of step with the database;
 *   • `serverTime` from the same API response is used to measure and correct for clock
 *     skew, so a browser whose clock is ten minutes fast does not show a hold expiring
 *     early.
 *
 * The display is a courtesy. The server independently rejects an expired hold whatever
 * this timer says.
 */
export function useCountdown(
  expiresAt: string | null | undefined,
  serverTime?: string | null,
): { secondsLeft: number; expired: boolean } {
  const skewRef = useRef(0);

  useEffect(() => {
    skewRef.current = serverTime ? Date.now() - new Date(serverTime).getTime() : 0;
  }, [serverTime]);

  const compute = () => {
    if (!expiresAt) return 0;
    const target = new Date(expiresAt).getTime();
    return Math.max(0, Math.round((target - (Date.now() - skewRef.current)) / 1000));
  };

  const [secondsLeft, setSecondsLeft] = useState(compute);

  useEffect(() => {
    setSecondsLeft(compute());
    if (!expiresAt) return undefined;
    const id = setInterval(() => setSecondsLeft(compute()), 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);

  return { secondsLeft, expired: Boolean(expiresAt) && secondsLeft <= 0 };
}
