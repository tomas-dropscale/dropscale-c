import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Refreshes the Supabase session on every navigation and writes the rotated
 * tokens back to the browser.
 *
 * Without this, an expired access token was fatal. A Server Component's
 * `getUser()` still refreshes — auth-js rotates the refresh token as soon as it
 * sees an expired one — but a Server Component cannot write cookies, so
 * `setAll` in lib/supabase/server.ts throws and is swallowed. The rotation was
 * spent server-side and never saved, leaving the browser holding a refresh
 * token Supabase had already invalidated: the gate redirected to /login and the
 * next attempt failed too. Mobile hit it constantly, because a backgrounded tab
 * has no running timer to refresh the token before the navigation happens.
 *
 * Middleware is the one place in the request path that can both read the
 * request cookies and set response cookies, which is why the refresh belongs
 * here rather than in the gate.
 *
 * Still `middleware.ts`, not Next 16's `proxy.ts`, despite the deprecation
 * warning Next prints for it. A proxy file is pinned to the Node runtime, and
 * the Cloudflare adapter fails the build outright on Node middleware ("Node.js
 * middleware is not currently supported"); this convention still defaults to
 * edge, which is what deploys. Renaming the file breaks `npm run cf:build`.
 *
 * Edge is also why nothing here may reach for a Node built-in — @supabase/ssr
 * is fetch-based, so it doesn't.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  /**
   * The call itself is the point: it refreshes an expired token, and the
   * adapter above persists what comes back. The result is deliberately unused
   * and deliberately not trusted — the gate in dashboard/layout.tsx still
   * decides access with getUser(), now against a session that is current.
   *
   * getSession() rather than getUser() precisely BECAUSE it is not an auth
   * check: it only reaches the network when the token has actually expired,
   * where getUser() would add a round trip to Supabase on every request in the
   * app, in front of the one the gate already makes.
   */
  await supabase.auth.getSession();

  return response;
}

export const config = {
  matcher: [
    /**
     * Everything except static assets and images. API routes ARE included:
     * they read the session too, and a route handler reached with a stale
     * cookie would burn the refresh token exactly as a page render did.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
