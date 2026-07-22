"use client";

import * as React from "react";
import { ExternalLink, Image as ImageIcon, PlayCircle, Search } from "lucide-react";

import type { CreativeAsset } from "@/lib/google-ads/portal";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function AssetCard({ asset }: { asset: CreativeAsset }) {
  const body = (
    <>
      <div className="relative aspect-video bg-[var(--bg-elevated)]">
        {asset.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- Google/YouTube asset URLs, unknown domains
          <img
            src={asset.thumbnailUrl}
            alt={asset.name}
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            <ImageIcon className="size-6 text-[var(--text-muted)]" aria-hidden />
          </div>
        )}
        {asset.kind === "video" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <PlayCircle className="size-9 text-white/90" aria-hidden />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2.5 p-3.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
            {asset.name}
          </p>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
            {asset.kind === "video"
              ? "YouTube video"
              : asset.width && asset.height
                ? `${asset.width} × ${asset.height}`
                : "Image"}
          </p>
        </div>
        <Badge variant={asset.kind === "video" ? "gold" : "neutral"}>
          {asset.kind === "video" ? "Video" : "Image"}
        </Badge>
        {asset.linkUrl && (
          <ExternalLink className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
        )}
      </div>
    </>
  );

  const className =
    "panel transition-smooth block overflow-hidden hover:border-[var(--border-strong)]";

  return asset.linkUrl ? (
    <a href={asset.linkUrl} target="_blank" rel="noreferrer" className={className}>
      {body}
    </a>
  ) : (
    <article className={className}>{body}</article>
  );
}

/** The account's real Google Ads creative library: images and YouTube videos. */
export function CreativeAssetsGrid({ assets }: { assets: CreativeAsset[] }) {
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<"all" | "image" | "video">("all");

  const filtered = assets.filter((asset) => {
    if (query && !asset.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (kind !== "all" && asset.kind !== kind) return false;
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
            placeholder="Search creatives..."
            className="pl-9"
          />
        </div>

        <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="image">Images</SelectItem>
            <SelectItem value="video">Videos</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <div className="panel px-6 py-14 text-center text-[13px] text-[var(--text-secondary)]">
          {assets.length === 0
            ? "No creatives in this account's library yet."
            : "No creatives match your filters."}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((asset) => (
            <AssetCard key={asset.id} asset={asset} />
          ))}
        </div>
      )}
    </div>
  );
}
