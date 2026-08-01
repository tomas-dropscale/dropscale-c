/**
 * HST session-token rules, kept pure so they can be unit-tested.
 *
 * These live apart from lib/admin/hst.ts because that module reaches for
 * Supabase and the crypto helpers the moment it is imported, and the decisions
 * below are exactly the ones worth testing in isolation: getting `tokenIsFresh`
 * wrong is invisible until commissions quietly stop arriving.
 */

/** Renew a little before the token actually dies, not at the last second. */
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** "2026/07/26 20:57:52" (and ISO) → epoch ms, or 0 when unparseable. */
export function parseExpiry(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value.includes("T") ? value : value.replace(/-/g, "/")).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Is the stored access token good enough to send as-is?
 *
 * Only a KNOWN expiry still in the future counts. An unknown expiry — which is
 * what `parseExpiry` returns for the null column HST leaves behind whenever its
 * refresh response carries no `expires` field — deliberately reads as NOT
 * fresh, so the caller renews.
 *
 * This is the bug that made the integration need a human. The old test was
 * `expiresAt === 0 || expiresAt - MARGIN > now`, where an unknown expiry was
 * treated as "never expires": the token was reused until HST refused it, and
 * nothing ever attempted a renewal. Erring the other way costs one refresh call
 * per sync; erring the old way cost the whole integration until someone noticed
 * and pasted a new session by hand.
 */
export function tokenIsFresh(expiresAt: number, now: number): boolean {
  return expiresAt > 0 && expiresAt - EXPIRY_MARGIN_MS > now;
}

/**
 * Why a token can't be used, or null when it's fine.
 *
 * HTTP header values are ByteStrings: every character must fit in one byte.
 * A token carrying anything above U+00FF was copied from a view that elided
 * it — DevTools' Preview tab truncates long strings with "…" — and `fetch`
 * would only reject it much later, with an opaque message about a character
 * value of 8230. Catching it at paste time is the difference between a
 * one-line fix and an afternoon.
 */
export function tokenFault(token: string): string | null {
  const chars = [...token];
  const index = chars.findIndex((char) => (char.codePointAt(0) ?? 0) > 255);
  if (index === -1) return null;

  return chars[index] === "…"
    ? `it is truncated — there's a "…" at position ${index}. Copy the raw Response tab in F12, not Preview (Preview shortens long values).`
    : `it has a character that can't travel in an HTTP header ("${chars[index]}" at position ${index}). Copy the raw Response tab in F12.`;
}
