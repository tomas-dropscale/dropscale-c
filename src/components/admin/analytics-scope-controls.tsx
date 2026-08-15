"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Search } from "lucide-react";

import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import type { AdminAnalyticsClient } from "../../lib/admin/analytics";
import {
  analyticsBaseHref,
  analyticsClientHref,
  analyticsStoreHref,
} from "../../lib/admin/analytics-view";
import type { RangeSelection } from "../../lib/portal/range";
import { cn } from "../../lib/utils";

const ALL_STORES = "all";

function matchingClients(
  clients: AdminAnalyticsClient[],
  query: string,
): AdminAnalyticsClient[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return clients;
  return clients.filter((client) =>
    `${client.name}\n${client.email}`.toLowerCase().includes(needle),
  );
}

function ClientCombobox({
  clients,
  value,
  onValueChange,
  labelledBy,
}: {
  clients: AdminAnalyticsClient[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  labelledBy: string;
}) {
  const selectedClient = clients.find((client) => client.id === value) ?? null;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const id = React.useId().replaceAll(":", "");
  const popupId = `${id}-popup`;
  const listboxId = `${id}-clients`;
  const valueId = `${id}-value`;
  const matches = matchingClients(clients, query);
  const options: Array<AdminAnalyticsClient | null> = query.trim()
    ? matches
    : [null, ...matches];

  React.useEffect(() => {
    if (!open) return;

    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [open]);

  React.useEffect(() => {
    if (open && options.length > 0) {
      document
        .getElementById(`${id}-option-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, id, open, options.length]);

  function openList() {
    setQuery("");
    setActiveIndex(
      selectedClient
        ? clients.findIndex((client) => client.id === selectedClient.id) + 1
        : 0,
    );
    setOpen(true);
  }

  function selectClient(client: AdminAnalyticsClient | null) {
    onValueChange(client?.id ?? null);
    setOpen(false);
    setQuery("");
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(options.length - 1, 0));
    } else if (
      event.key === "Enter" &&
      activeIndex >= 0 &&
      activeIndex < options.length
    ) {
      event.preventDefault();
      selectClient(options[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-labelledby={`${labelledBy} ${valueId}`}
        className={cn(
          "transition-smooth flex h-10 w-full items-center justify-between gap-2 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3 text-sm text-[var(--text-primary)]",
          "hover:border-[var(--border-strong)] focus:outline-none focus-visible:border-[var(--accent-gold)]/50 focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/15",
        )}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openList();
          }
        }}
      >
        <span id={valueId} className="truncate">
          {selectedClient?.name ?? "All clients"}
        </span>
        <ChevronDown className="size-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />
      </button>

      <div
        id={popupId}
        role="dialog"
        aria-label="Choose client"
        hidden={!open}
        className="absolute top-full right-0 left-0 z-50 mt-1.5 overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-xl shadow-black/40"
      >
        <div className="relative border-b border-[var(--border-subtle)] p-1.5">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
          <Input
            ref={inputRef}
            role="combobox"
            aria-label="Search clients by name"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={
              options.length > 0 ? `${id}-option-${activeIndex}` : undefined
            }
            autoComplete="off"
            value={query}
            placeholder="Search client name…"
            className="h-8 bg-[var(--bg-panel)] pr-2 pl-8 text-[13px]"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleSearchKeyDown}
          />
        </div>

        <ul
          id={listboxId}
          role="listbox"
          aria-label="Clients"
          className="max-h-60 overflow-y-auto p-1"
        >
          {options.map((client, index) => {
            const selected = client ? client.id === value : value === null;
            return (
              <li
                key={client?.id ?? "all-clients"}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={selected}
                className={cn(
                  "transition-smooth relative flex min-h-9 cursor-pointer items-center rounded-lg py-2 pr-8 pl-2.5 text-[13px] text-[var(--text-primary)] outline-none select-none",
                  index === activeIndex && "bg-[var(--bg-panel-hover)]",
                )}
                onPointerMove={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectClient(client)}
              >
                <span className="truncate">{client?.name ?? "All clients"}</span>
                {selected && (
                  <Check className="absolute right-2.5 size-3.5 text-[var(--accent-gold)]" aria-hidden />
                )}
              </li>
            );
          })}
        </ul>
        {options.length === 0 && (
          <p role="status" className="px-2.5 py-3 text-center text-[12px] text-[var(--text-muted)]">
            No clients match “{query.trim()}”.
          </p>
        )}
      </div>
    </div>
  );
}

export function AnalyticsScopeControls({
  clients,
  clientId,
  stores,
  storeId,
  range,
}: {
  clients: AdminAnalyticsClient[];
  clientId: string | null;
  stores: Array<{
    id: string | null;
    name: string;
    domain: string;
    reportingState?: "running" | "partial" | "not_materialized";
    reportingCoverage?: { rows: number; expectedRows: number };
    updatedAt: string | null;
    adSpend: number;
  }>;
  storeId: string | null;
  range: RangeSelection;
}) {
  const router = useRouter();
  const clientLabelId = React.useId();

  function changeClient(nextClientId: string | null) {
    router.push(
      nextClientId
        ? analyticsClientHref(nextClientId, range)
        : analyticsBaseHref(range),
    );
  }

  function changeStore(nextStoreId: string) {
    if (!clientId) return;
    router.push(
      nextStoreId === ALL_STORES
        ? analyticsClientHref(clientId, range)
        : analyticsStoreHref(clientId, nextStoreId, range),
    );
  }

  return (
    <div className="grid flex-1 gap-3 sm:grid-cols-2 lg:max-w-[720px]">
      <div className="space-y-1.5">
        <span id={clientLabelId} className="label-caps block">
          1. Client
        </span>
        <ClientCombobox
          clients={clients}
          value={clientId}
          onValueChange={changeClient}
          labelledBy={clientLabelId}
        />
      </div>

      <div className="space-y-1.5">
        <span className="label-caps block">2. Store</span>
        <Select
          value={clientId ? storeId ?? ALL_STORES : undefined}
          disabled={!clientId}
          onValueChange={changeStore}
        >
          <SelectTrigger
            aria-label={
              clientId
                ? "Select store"
                : "Select a client before selecting a store"
            }
          >
            <SelectValue placeholder="Select a client" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STORES}>All stores</SelectItem>
            {stores.map((store, index) => (
              <SelectItem
                key={store.id ?? `not-activated-${store.domain}-${index}`}
                value={store.id ?? `not-activated:${index}`}
                disabled={store.id === null}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{store.domain || store.name}</span>
                  {store.reportingState === "running" && (
                    <Badge
                      variant="success"
                      title={`${store.updatedAt ? `Synced ${store.updatedAt}` : "Synced"} · complete selected-period grid${store.adSpend > 0 ? " · positive ad spend" : " · valid zero-spend data"}`}
                      aria-label="Running with complete selected-period data"
                    >
                      <span className="size-1.5 rounded-full bg-current" aria-hidden />
                      Running
                    </Badge>
                  )}
                  {store.reportingState === "partial" && (
                    <Badge
                      variant="warning"
                      title={store.reportingCoverage
                        ? `${store.reportingCoverage.rows} of ${store.reportingCoverage.expectedRows} account-days are materialised.`
                        : "Partial selected-period reporting grid."}
                      aria-label={store.reportingCoverage
                        ? `Partial. ${store.reportingCoverage.rows} of ${store.reportingCoverage.expectedRows} account-days are materialised.`
                        : "Partial selected-period reporting grid."}
                    >
                      Partial
                    </Badge>
                  )}
                  {store.id === null && (
                    <Badge
                      variant="neutral"
                      title="Verified Shopify connection without an activated reporting store."
                      aria-label="Not activated for reporting"
                    >
                      Not activated
                    </Badge>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
