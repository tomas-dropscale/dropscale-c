import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/types";
import { supabaseEnv } from "@/lib/supabase/env";

/**
 * Supabase client for Server Components, Route Handlers and Server Actions.
 * Must be created per request — never cache it in module scope, or you leak
 * one user's session into another's.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = supabaseEnv();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component: the browser client refreshes the
          // session cookie on the next client-side call, so ignoring is safe.
        }
      },
    },
  });
}

/**
 * Authenticated user plus their clients row, or nulls when there is no
 * session. A user WITHOUT a clients row is not a portal client (e.g. a staff
 * account) — the layout treats that the same as not being signed in.
 */
export async function getSessionClient() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { user: null, client: null };

  const { data: client } = await supabase
    .from("portal_clients")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  return { user, client };
}
