import "server-only";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

/**
 * A Supabase client that bypasses RLS. It is reserved for authenticated
 * server-only operations: signed Stripe webhooks, CRON_SECRET-protected jobs,
 * the atomic Google billing-start commit, and reviewed invoice issuance after
 * an admin session and the relevant source evidence have both been verified.
 *
 * Interactive requests still ride the viewer's own session. Returning null
 * when the service key is absent lets each machine route fail closed with a
 * clear 503 instead of ever falling back to broader browser permissions.
 */
export function createServiceClient(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  return createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
