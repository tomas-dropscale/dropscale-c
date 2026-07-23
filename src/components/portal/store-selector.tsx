"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Store } from "lucide-react";

import type { AdAccount } from "@/lib/supabase/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/lib/i18n/provider";

const ALL = "all";

/**
 * "All stores" vs one store, carried as ?store=<id>. Lives beside the range
 * picker in the dashboard header; the range params survive the change for the
 * same reason the store survives a range change — the two filters are
 * independent axes over the same query state.
 */
export function StoreSelector({
  accounts,
  current,
}: {
  accounts: AdAccount[];
  current: string | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { d } = useI18n();

  function apply(value: string) {
    const params = new URLSearchParams(searchParams);
    if (value === ALL) params.delete("store");
    else params.set("store", value);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <Select value={current ?? ALL} onValueChange={apply}>
      <SelectTrigger className="h-9 w-[190px]">
        <span className="flex min-w-0 items-center gap-2">
          <Store className="size-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden />
          <span className="truncate">
            <SelectValue />
          </span>
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{d.portal.allStoresOption}</SelectItem>
        {accounts.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {account.store_name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
