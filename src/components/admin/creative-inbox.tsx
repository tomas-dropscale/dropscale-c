"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  Search,
  Store,
  X,
} from "lucide-react";

import { ErrorBanner } from "@/components/finance/finance-ui";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  filterCreativeInboxRows,
  flattenCreativeInbox,
  groupCreativeInboxRows,
  type CreativeInboxFilter,
} from "@/lib/admin/creative-inbox-model";
import type { CreativeInbox } from "@/lib/admin/creatives";
import { collectionHandleFromUrl } from "@/lib/finance/rev-share";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { createClient } from "@/lib/supabase/client";
import type { CreativeSubmission, CreativeSubmissionStatus } from "@/lib/supabase/types";
import { cn } from "@/lib/utils";

const FILTER_ORDER: CreativeInboxFilter[] = ["all", "new", "in_use", "rejected"];

const STATUS_TONE: Record<CreativeSubmissionStatus, "neutral" | "gold" | "danger"> = {
  new: "neutral",
  in_use: "gold",
  rejected: "danger",
};

const ROW_GRID =
  "xl:grid-cols-[minmax(195px,1.5fr)_minmax(110px,.8fr)_minmax(145px,1fr)_minmax(105px,.7fr)_minmax(75px,.55fr)_minmax(116px,.75fr)]";

function MobileLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)] xl:hidden">
      {children}
    </span>
  );
}

/** The billing collection and whether its URL contains the handle rev-share needs. */
function CollectionLine({ url }: { url: string }) {
  const { d } = useI18n();
  const handle = collectionHandleFromUrl(url);
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The visible link remains selectable if clipboard permission is denied.
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="transition-smooth min-w-0 truncate text-[12px] text-[var(--text-secondary)] hover:text-[var(--accent-gold-strong)]"
      >
        {handle ? `/collections/${handle}` : url}
      </a>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={d.creativeInbox.copyCollection}
        title={d.creativeInbox.copyCollection}
        className="transition-smooth inline-flex size-10 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)] xl:size-8"
      >
        {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      </button>
      {!handle && (
        <span
          title={d.creativeInbox.noHandle}
          aria-label={d.creativeInbox.noHandle}
          className="shrink-0 text-[var(--warning-orange)]"
        >
          <AlertTriangle className="size-3.5" aria-hidden />
        </span>
      )}
    </div>
  );
}

export function CreativeInboxView({
  inbox,
  status,
  adminId,
  basePath = "/admin/creatives",
  readOnlyPreview = false,
}: {
  inbox: CreativeInbox;
  status: CreativeInboxFilter;
  adminId: string;
  basePath?: string;
  readOnlyPreview?: boolean;
}) {
  const router = useRouter();
  const { d, intl } = useI18n();
  const [error, setError] = React.useState<string | null>(null);
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [expandedClients, setExpandedClients] = React.useState<Set<string>>(() => new Set());
  const [expandedUploads, setExpandedUploads] = React.useState<Set<string>>(() => new Set());

  const rows = React.useMemo(() => flattenCreativeInbox(inbox), [inbox]);
  const visibleRows = React.useMemo(
    () => filterCreativeInboxRows(rows, { status, query }),
    [query, rows, status],
  );
  const clientGroups = React.useMemo(() => groupCreativeInboxRows(visibleRows), [visibleRows]);
  const dateFormatter = React.useMemo(
    () => new Intl.DateTimeFormat(intl, { dateStyle: "medium", timeStyle: "short" }),
    [intl],
  );

  const statusLabel: Record<CreativeSubmissionStatus, string> = {
    new: d.creativeInbox.statusNew,
    in_use: d.creativeInbox.statusInUse,
    rejected: d.creativeInbox.statusRejected,
  };
  const filterLabel: Record<CreativeInboxFilter, string> = {
    all: d.creativeInbox.filterAll,
    new: d.creativeInbox.filterNew,
    in_use: d.creativeInbox.filterInUse,
    rejected: d.creativeInbox.filterRejected,
  };
  function applyStatus(next: CreativeInboxFilter) {
    router.push(next === "all" ? basePath : `${basePath}?status=${next}`);
  }

  function clearFilters() {
    setQuery("");
    applyStatus("all");
  }

  function toggleExpanded(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function mark(submission: CreativeSubmission, next: CreativeSubmissionStatus) {
    if (readOnlyPreview) return;

    let reviewNotes: string | null = next === "in_use" ? null : submission.review_notes;
    if (next === "rejected") {
      const reason = window.prompt(d.creativeInbox.rejectPrompt, reviewNotes ?? "");
      if (reason === null) return;
      reviewNotes = reason.trim() || null;
    }

    const actionKey = `${submission.id}:${next}`;
    setBusyAction(actionKey);
    setError(null);
    const { error: updateError } = await createClient()
      .from("creative_submissions")
      .update({
        status: next,
        review_notes: reviewNotes,
        reviewed_at: new Date().toISOString(),
        reviewed_by: adminId,
      })
      .eq("id", submission.id);
    setBusyAction(null);

    if (updateError) {
      setError(updateError.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <section className="panel overflow-hidden">
        <header className="flex flex-col gap-3 border-b border-[var(--border-subtle)] px-4 py-4 md:flex-row md:items-end md:px-5">
          <div className="min-w-0 flex-1">
            <label htmlFor="creative-inbox-search" className="sr-only">
              {d.creativeInbox.searchLabel}
            </label>
            <div className="relative max-w-md">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-muted)]"
                aria-hidden
              />
              <Input
                id="creative-inbox-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={d.creativeInbox.searchPlaceholder}
                className="pl-9"
              />
            </div>
          </div>

          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end sm:gap-3">
            <div className="w-full sm:w-44">
              <label htmlFor="creative-inbox-status" className="sr-only">
                {d.creativeInbox.statusLabel}
              </label>
              <Select value={status} onValueChange={(value) => applyStatus(value as CreativeInboxFilter)}>
                <SelectTrigger id="creative-inbox-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FILTER_ORDER.map((filter) => (
                    <SelectItem key={filter} value={filter}>
                      {filterLabel[filter]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p aria-live="polite" className="shrink-0 text-[12px] tabular-nums text-[var(--text-muted)] sm:pb-2">
              {fmt(d.creativeInbox.clientResults, {
                clients: clientGroups.length,
                uploads: visibleRows.length,
              })}
            </p>
          </div>
        </header>

        {visibleRows.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-[13px] text-[var(--text-secondary)]">
              {status === "all" && !query.trim()
                ? d.creativeInbox.emptyAll
                : d.creativeInbox.emptyFiltered}
            </p>
            {(status !== "all" || query.trim()) && (
              <Button variant="secondary" size="sm" className="mt-4" onClick={clearFilters}>
                {d.creativeInbox.clearFilters}
              </Button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)]">
            {clientGroups.map((group) => {
              const isClientExpanded = expandedClients.has(group.clientId);
              const uploadsId = `creative-uploads-${group.clientId}`;

              return (
                <li key={group.clientId}>
                  <button
                    type="button"
                    onClick={() => toggleExpanded(setExpandedClients, group.clientId)}
                    aria-expanded={isClientExpanded}
                    aria-controls={uploadsId}
                    className="transition-smooth flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--bg-panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-gold)]/35 md:px-5"
                  >
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-[var(--text-muted)] transition-transform",
                        !isClientExpanded && "-rotate-90",
                      )}
                      aria-hidden
                    />
                    <Avatar name={group.clientName} seed={group.clientId} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-[var(--text-primary)]">
                        {group.clientName}
                      </span>
                      <span className="block truncate text-[11.5px] text-[var(--text-muted)]">
                        {group.clientEmail}
                      </span>
                    </span>
                    <Badge variant="neutral" className="shrink-0">
                      {fmt(d.creativeInbox.clientUploads, { count: group.counts.total })}
                    </Badge>
                    <span className="hidden items-center gap-2 lg:flex">
                      {group.counts.new > 0 && (
                        <Badge variant="neutral">
                          {group.counts.new} {d.creativeInbox.statusNew}
                        </Badge>
                      )}
                      {group.counts.in_use > 0 && (
                        <Badge variant="gold">
                          {group.counts.in_use} {d.creativeInbox.statusInUse}
                        </Badge>
                      )}
                      {group.counts.rejected > 0 && (
                        <Badge variant="danger">
                          {group.counts.rejected} {d.creativeInbox.statusRejected}
                        </Badge>
                      )}
                    </span>
                  </button>

                  {isClientExpanded && (
                    <div id={uploadsId} className="border-t border-[var(--border-subtle)]">
                      <div
                        className={cn(
                          "hidden items-center gap-x-3 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-5 py-2.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)] xl:grid",
                          ROW_GRID,
                        )}
                      >
                        <span>{d.creativeInbox.columnCreative}</span>
                        <span>{d.creativeInbox.columnStore}</span>
                        <span>{d.creativeInbox.columnCollection}</span>
                        <span>{d.creativeInbox.columnSubmitted}</span>
                        <span>{d.creativeInbox.columnStatus}</span>
                        <span className="text-right">{d.creativeInbox.columnActions}</span>
                      </div>

                      <ul className="divide-y divide-[var(--border-subtle)]">
                        {group.rows.map((row) => {
                          const { submission } = row;
                          const isExpanded = expandedUploads.has(submission.id);
                          const detailsId = `creative-details-${submission.id}`;
                          const rowBusy = busyAction?.startsWith(`${submission.id}:`) ?? false;

                          return (
                            <li key={submission.id} className="hover:bg-[var(--bg-panel-hover)]/35">
                  <div
                    className={cn(
                      "grid grid-cols-1 items-center gap-x-3 gap-y-4 px-4 py-4 sm:grid-cols-2 md:px-5 xl:py-3",
                      ROW_GRID,
                    )}
                  >
                    <div className="min-w-0 sm:col-span-2 xl:col-span-1">
                      <MobileLabel>{d.creativeInbox.columnCreative}</MobileLabel>
                      <button
                        type="button"
                        onClick={() => toggleExpanded(setExpandedUploads, submission.id)}
                        aria-expanded={isExpanded}
                        aria-controls={detailsId}
                        title={d.creativeInbox.details}
                        className="group flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/35 xl:min-h-8"
                      >
                        <ChevronDown
                          className={cn(
                            "size-4 shrink-0 text-[var(--text-muted)] transition-transform",
                            !isExpanded && "-rotate-90",
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-semibold text-[var(--text-primary)]">
                            {submission.title}
                          </span>
                          {row.submitterName && (
                            <span className="block truncate text-[11.5px] text-[var(--text-muted)]">
                              {row.submitterName}
                            </span>
                          )}
                        </span>
                      </button>
                    </div>

                    <div className="min-w-0">
                      <MobileLabel>{d.creativeInbox.columnStore}</MobileLabel>
                      <p className="flex min-w-0 items-center gap-2 text-[12.5px] text-[var(--text-secondary)]">
                        <Store className="size-3.5 shrink-0 text-[var(--accent-gold)]" aria-hidden />
                        <span className="truncate">{row.storeName}</span>
                      </p>
                    </div>

                    <div className="min-w-0">
                      <MobileLabel>{d.creativeInbox.columnCollection}</MobileLabel>
                      {submission.collection_url ? (
                        <CollectionLine url={submission.collection_url} />
                      ) : (
                        <span className="text-[12px] text-[var(--text-muted)]">—</span>
                      )}
                    </div>

                    <div className="min-w-0">
                      <MobileLabel>{d.creativeInbox.columnSubmitted}</MobileLabel>
                      <time
                        dateTime={submission.created_at}
                        className="text-[12px] leading-snug text-[var(--text-secondary)]"
                      >
                        {dateFormatter.format(new Date(submission.created_at))}
                      </time>
                    </div>

                    <div>
                      <MobileLabel>{d.creativeInbox.columnStatus}</MobileLabel>
                      <Badge variant={STATUS_TONE[submission.status]}>
                        {statusLabel[submission.status]}
                      </Badge>
                    </div>

                    <div className="sm:col-span-2 xl:col-span-1">
                      <MobileLabel>{d.creativeInbox.columnActions}</MobileLabel>
                      <div className="grid w-fit grid-cols-3 gap-2 xl:ml-auto">
                        <Button
                          asChild
                          variant="secondary"
                          size="icon"
                          className="size-10 xl:size-8"
                          title={d.creativeInbox.open}
                        >
                          <a
                            href={submission.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={d.creativeInbox.open}
                          >
                            <ExternalLink aria-hidden />
                          </a>
                        </Button>

                        {submission.status !== "in_use" && (
                          <Button
                            variant="primary"
                            size="icon"
                            className="size-10 xl:size-8"
                            disabled={readOnlyPreview || rowBusy}
                            onClick={() => void mark(submission, "in_use")}
                            aria-label={d.creativeInbox.markInUse}
                            title={d.creativeInbox.markInUse}
                          >
                            {busyAction === `${submission.id}:in_use` ? (
                              <Loader2 className="animate-spin" aria-hidden />
                            ) : (
                              <Check aria-hidden />
                            )}
                          </Button>
                        )}
                        {submission.status === "in_use" && (
                          <span className="size-10 xl:size-8" aria-hidden />
                        )}
                        {submission.status !== "rejected" && (
                          <Button
                            variant="danger"
                            size="icon"
                            className="size-10 xl:size-8"
                            disabled={readOnlyPreview || rowBusy}
                            onClick={() => void mark(submission, "rejected")}
                            aria-label={d.creativeInbox.markRejected}
                            title={d.creativeInbox.markRejected}
                          >
                            {busyAction === `${submission.id}:rejected` ? (
                              <Loader2 className="animate-spin" aria-hidden />
                            ) : (
                              <X aria-hidden />
                            )}
                          </Button>
                        )}
                        {submission.status === "rejected" && (
                          <span className="size-10 xl:size-8" aria-hidden />
                        )}
                      </div>
                    </div>
                  </div>

                  {isExpanded && (
                    <div
                      id={detailsId}
                      className="grid gap-4 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3 text-[12px] md:grid-cols-2 md:px-5 xl:grid-cols-4"
                    >
                      <div className="min-w-0">
                        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                          {d.creativeInbox.clientNotes}
                        </p>
                        <p className="mt-1 break-words leading-relaxed text-[var(--text-secondary)]">
                          {submission.notes || "—"}
                        </p>
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                          {d.creativeInbox.reviewNotes}
                        </p>
                        <p className="mt-1 break-words leading-relaxed text-[var(--text-secondary)]">
                          {submission.review_notes || "—"}
                        </p>
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                          {d.creativeInbox.sourceLink}
                        </p>
                        <a
                          href={submission.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 flex min-h-8 min-w-0 items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-gold-strong)]"
                        >
                          <span className="truncate">{submission.url}</span>
                          <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                        </a>
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                          {d.creativeInbox.columnCollection}
                        </p>
                        {submission.collection_url ? (
                          <>
                            <a
                              href={submission.collection_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-1 flex min-h-8 min-w-0 items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-gold-strong)]"
                            >
                              <span className="truncate">{submission.collection_url}</span>
                              <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                            </a>
                            {!collectionHandleFromUrl(submission.collection_url) && (
                              <p className="mt-1 flex items-start gap-1.5 leading-relaxed text-[var(--warning-orange)]">
                                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                                {d.creativeInbox.noHandle}
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="mt-1 text-[var(--text-muted)]">—</p>
                        )}
                      </div>
                    </div>
                  )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
