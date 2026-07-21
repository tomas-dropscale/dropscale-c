"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/types";
import { supabaseEnv } from "@/lib/supabase/env";

/**
 * Supabase client for the browser. `createBrowserClient` caches the instance
 * internally, so calling this from several components is safe.
 */
export function createClient() {
  const { url, anonKey } = supabaseEnv();
  return createBrowserClient<Database>(url, anonKey);
}
