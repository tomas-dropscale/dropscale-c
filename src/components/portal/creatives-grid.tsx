"use client";

import * as React from "react";
import {
  Download,
  Folder,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";

import type { CreativeDelivery } from "@/lib/supabase/types";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ageDays, shortDate } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { thumbTint } from "@/lib/portal/mock";

const THUMBS_SHOWN = 6; // 2 rows × 3 columns

function DeliveryCard({ delivery }: { delivery: CreativeDelivery }) {
  const { d } = useI18n();
  const hiddenCount = Math.max(0, delivery.file_count - THUMBS_SHOWN);

  return (
    <article className="panel transition-smooth overflow-hidden hover:border-[var(--border-strong)]">
      {/* Thumbnail mosaic — gradients stand in until real thumbnails exist */}
      <div className="grid grid-cols-3 gap-px bg-[var(--border-subtle)]">
        {Array.from({ length: THUMBS_SHOWN }, (_, index) => {
          const url = delivery.thumbnail_urls[index];
          const isLast = index === THUMBS_SHOWN - 1;

          return (
            <div key={index} className="relative aspect-square">
              {url ? (
                // eslint-disable-next-line @next/next/no-img-element -- external creative thumbnails, unknown domains
                <img src={url} alt="" className="size-full object-cover" />
              ) : (
                <div
                  className="size-full"
                  style={{ background: thumbTint(delivery.id, index) }}
                />
              )}
              {isLast && hiddenCount > 0 && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-[15px] font-semibold text-[var(--text-primary)]">
                  +{hiddenCount}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-start gap-3 p-4">
        <Folder className="mt-0.5 size-4 shrink-0 text-[var(--accent-gold)]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
            {delivery.name}
          </p>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
            {shortDate(delivery.created_at)} ·{" "}
            {fmt(d.creatives.files, { count: delivery.file_count })} ·{" "}
            {Number(delivery.size_mb).toFixed(1)} MB
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={delivery.status === "published" ? "gold" : "neutral"}>
            {delivery.status === "published" ? d.creatives.published : d.creatives.draft}
          </Badge>

          <DropdownMenu>
            <DropdownMenuTrigger
              className="transition-smooth rounded-md p-1 text-[var(--text-muted)] outline-none hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
              aria-label={d.creatives.deliveryActions}
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {/* Placeholder actions — wire up when file storage exists */}
              <DropdownMenuItem>
                <Download />
                {d.creatives.download}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Pencil />
                {d.creatives.rename}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="danger">
                <Trash2 />
                {d.creatives.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </article>
  );
}

export function CreativesGrid({ deliveries }: { deliveries: CreativeDelivery[] }) {
  const { d } = useI18n();
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<"all" | "published" | "draft">("all");
  const [period, setPeriod] = React.useState<"all" | "d30" | "d90">("all");

  const filtered = deliveries.filter((delivery) => {
    if (query && !delivery.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (status !== "all" && delivery.status !== status) return false;
    if (period !== "all") {
      const age = ageDays(delivery.created_at);
      if (period === "d30" && age > 30) return false;
      if (period === "d90" && age > 90) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={d.creatives.searchDeliveries}
            className="pl-9"
          />
        </div>

        <Select
          value={status}
          onValueChange={(value) => setStatus(value as typeof status)}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{d.creatives.allStatuses}</SelectItem>
            <SelectItem value="published">{d.creatives.published}</SelectItem>
            <SelectItem value="draft">{d.creatives.draft}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={period}
          onValueChange={(value) => setPeriod(value as typeof period)}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{d.creatives.allTime}</SelectItem>
            <SelectItem value="d30">{d.creatives.last30}</SelectItem>
            <SelectItem value="d90">{d.creatives.last90}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <div className="panel px-6 py-14 text-center text-[13px] text-[var(--text-secondary)]">
          {d.creatives.noMatches}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((delivery) => (
            <DeliveryCard key={delivery.id} delivery={delivery} />
          ))}
        </div>
      )}
    </div>
  );
}
