"use client";

import { useRouter } from "next/navigation";
import { Store } from "lucide-react";

import { InlineRename } from "@/components/admin/inline-rename";
import { createClient } from "@/lib/supabase/client";

/**
 * Rename a store, from the campaigns screen.
 *
 * Stores get named by whoever created them — often the client, often badly
 * ("Loja 1", a myshopify subdomain) — and that name is what the agency reads on
 * every screen and what the client sees in their own sidebar. The team needs to
 * be able to fix it without going through them.
 *
 * Rendered in the open panel rather than beside the name in the <summary>: a
 * click on a control inside <summary> toggles the panel shut. Same reason the
 * CommissionRate control lives there.
 *
 * `store_name` is not one of the columns migration 0001's guard trigger
 * protects (status and client_id are), so the RLS update is all it takes.
 */
export function StoreName({ accountId, name }: { accountId: string; name: string }) {
  const router = useRouter();

  return (
    <InlineRename
      value={name}
      title="Store name"
      help="Shown everywhere, including in the client's own sidebar."
      maxLength={80}
      emptyMessage="A store needs a name."
      onSave={async (next) => {
        const { error } = await createClient()
          .from("ad_accounts")
          .update({ store_name: next })
          .eq("id", accountId);
        if (error) return error.message;
        router.refresh();
        return null;
      }}
    >
      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--text-secondary)] group-hover/rename:border-[var(--accent-gold)]/40">
        <Store className="size-3 text-[var(--text-muted)]" aria-hidden />
        Rename
      </span>
    </InlineRename>
  );
}
