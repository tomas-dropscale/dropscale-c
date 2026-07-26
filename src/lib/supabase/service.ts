import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

/**
 * A Supabase client that bypasses RLS. Exactly one caller is entitled to it:
 * the Stripe webhook, which arrives with no session — its signature is its
 * authentication, and it has to write payment state nobody else may write.
 *
 * Everything else in this app deliberately rides the viewer's own session, and
 * should keep doing so. Returns null when the key isn't configured, so the
 * feature degrades to the page-load reconciliation instead of crashing.
 */
export function createServiceClient(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  return createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
