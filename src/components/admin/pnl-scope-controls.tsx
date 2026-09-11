"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AdminAnalyticsClient } from "@/lib/admin/analytics";
import type { AdminClientPnlStore } from "@/lib/admin/client-pnl";
import { pnlHref } from "@/lib/admin/pnl-href";

const ALL_STORES = "__all__";

export function PnlScopeControls({
  clients,
  clientId,
  stores,
  storeId,
  year,
  month,
}: {
  clients: AdminAnalyticsClient[];
  clientId: string | null;
  stores: AdminClientPnlStore[];
  storeId: string | null;
  year: number;
  month: number;
}) {
  const router = useRouter();
  const clientLabelId = React.useId();
  const storeLabelId = React.useId();

  return (
    <div className="grid flex-1 gap-3 sm:grid-cols-2 lg:max-w-[720px]">
      <div className="space-y-1.5">
        <span id={clientLabelId} className="label-caps block">
          1. Client
        </span>
        <Select
          value={clientId ?? ""}
          onValueChange={(value) => router.push(pnlHref({ clientId: value, year, month }))}
        >
          <SelectTrigger aria-labelledby={clientLabelId} className="w-full">
            <SelectValue placeholder="Choose a client" />
          </SelectTrigger>
          <SelectContent>
            {clients.map((client) => (
              <SelectItem key={client.id} value={client.id}>
                {client.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <span id={storeLabelId} className="label-caps block">
          2. Store
        </span>
        <Select
          value={storeId ?? ALL_STORES}
          disabled={!clientId}
          onValueChange={(value) =>
            router.push(
              pnlHref({
                clientId,
                storeId: value === ALL_STORES ? null : value,
                year,
                month,
              }),
            )
          }
        >
          <SelectTrigger aria-labelledby={storeLabelId} className="w-full">
            <SelectValue placeholder="Every store" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STORES}>Every store</SelectItem>
            {stores.map((store) => (
              <SelectItem key={store.accountId} value={store.accountId}>
                {store.storeName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
