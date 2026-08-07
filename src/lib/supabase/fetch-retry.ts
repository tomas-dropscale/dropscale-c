import "server-only";

/**
 * Fetch with transparent retries for idempotent reads.
 *
 * Cloudflare Worker → Supabase connections drop intermittently ("Network
 * connection lost"), and one dropped read used to surface to the client as an
 * empty store list, a false 404 or an error page. A dropped connection almost
 * always succeeds on an immediate retry, so reads absorb up to two retries
 * with a short backoff and the blip never becomes visible.
 *
 * ONLY requests without a body-bearing method are retried. A POST (an RPC, an
 * insert, a Stripe-adjacent write) may have been processed even though the
 * connection died on the way back — blindly replaying one can duplicate a
 * money operation, so writes keep failing loudly and their callers' own
 * idempotency machinery stays the single retry authority.
 */
const RETRIES = 2;
const BACKOFF_MS = [100, 250];

function isIdempotent(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (
    init?.method ??
    (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  return method === "GET" || method === "HEAD";
}

export function fetchWithReadRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (!isIdempotent(input, init)) return fetch(input, init);

  const attempt = async (remaining: number): Promise<Response> => {
    try {
      return await fetch(input, init);
    } catch (error) {
      if (remaining <= 0) throw error;
      const wait = BACKOFF_MS[RETRIES - remaining] ?? 250;
      await new Promise((resolve) => setTimeout(resolve, wait));
      return attempt(remaining - 1);
    }
  };
  return attempt(RETRIES);
}
