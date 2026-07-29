/**
 * The workspace cookie, split out from workspace.ts so the browser can set it.
 *
 * workspace.ts imports next/headers and react.cache and is server-only; a
 * client component importing the cookie NAME from there would drag all of that
 * into the bundle. Same split as the locale cookie in lib/i18n.
 */

export const WORKSPACE_COOKIE = "dropscale-workspace";

/** Persists the choice; Server Components read it on the next render. */
export function setWorkspaceCookie(workspaceId: string) {
  const oneYear = 60 * 60 * 24 * 365;
  document.cookie = `${WORKSPACE_COOKIE}=${workspaceId}; path=/; max-age=${oneYear}; samesite=lax`;
}
