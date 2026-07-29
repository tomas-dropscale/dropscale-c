"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, Store, X } from "lucide-react";

import type { CreativeInbox } from "@/lib/admin/creatives";
import type { CreativeSubmission, CreativeSubmissionStatus } from "@/lib/supabase/types";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/finance/finance-ui";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type Filter = CreativeSubmissionStatus | "all";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "in_use", label: "In use" },
  { value: "rejected", label: "Rejected" },
];

const STATUS_LABEL: Record<CreativeSubmissionStatus, string> = {
  new: "New",
  in_use: "In use",
  rejected: "Rejected",
};

const STATUS_TONE: Record<CreativeSubmissionStatus, "neutral" | "gold" | "danger"> = {
  new: "neutral",
  in_use: "gold",
  rejected: "danger",
};

/**
 * Client → store → batches, with the two actions that matter: open the link, and
 * say what happened to it.
 *
 * Marking is deliberately a round trip to the server (router.refresh) rather
 * than local optimism: with a status filter on, a batch you just marked may no
 * longer belong in the list at all, and guessing that in the client would be
 * more code than re-reading the truth.
 */
export function CreativeInboxView({
  inbox,
  status,
  adminId,
}: {
  inbox: CreativeInbox;
  status: Filter;
  adminId: string;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  async function mark(submission: CreativeSubmission, next: CreativeSubmissionStatus) {
    // Rejecting without a reason just turns into a message asking why.
    let reviewNotes: string | null = submission.review_notes;
    if (next === "rejected") {
      const reason = window.prompt("Why is this not usable? The client sees this.", reviewNotes ?? "");
      if (reason === null) return;
      reviewNotes = reason.trim() || null;
    }

    setBusyId(submission.id);
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
    setBusyId(null);

    if (updateError) {
      setError(updateError.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((filter) => {
          const active = filter.value === status;
          return (
            <Link
              key={filter.value}
              href={filter.value === "all" ? "/admin/creatives" : `/admin/creatives?status=${filter.value}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "transition-smooth rounded-full border px-3.5 py-1.5 text-[12.5px]",
                active
                  ? "border-[var(--accent-gold)]/35 bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"
                  : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]",
              )}
            >
              {filter.label}
            </Link>
          );
        })}

        <span className="ml-auto text-[12px] text-[var(--text-muted)]">
          {inbox.total} submission{inbox.total === 1 ? "" : "s"}
          {inbox.newCount > 0 && ` · ${inbox.newCount} new`}
        </span>
      </div>

      {inbox.clients.length === 0 ? (
        <div className="panel px-6 py-14 text-center text-[13px] text-[var(--text-secondary)]">
          {status === "all"
            ? "No client has submitted creatives yet."
            : `Nothing ${status === "in_use" ? "in use" : status}.`}
        </div>
      ) : (
        inbox.clients.map((client) => (
          <section key={client.clientId} className="panel overflow-hidden">
            <header className="flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] px-5 py-4">
              <Avatar name={client.clientName} seed={client.clientId} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold text-[var(--text-primary)]">
                  {client.clientName}
                </p>
                <p className="truncate text-[12px] text-[var(--text-muted)]">{client.clientEmail}</p>
              </div>
              {client.newCount > 0 && <Badge variant="gold">{client.newCount} new</Badge>}
            </header>

            <div className="divide-y divide-[var(--border-subtle)]">
              {client.stores.map((store) => (
                <div key={store.accountId} className="px-5 py-4">
                  <p className="mb-3 flex items-center gap-2 text-[12.5px] font-medium text-[var(--text-secondary)]">
                    <Store className="size-3.5 text-[var(--accent-gold)]" aria-hidden />
                    {store.storeName}
                  </p>

                  <ul className="space-y-2">
                    {store.submissions.map((submission) => (
                      <li
                        key={submission.id}
                        className="flex flex-wrap items-start gap-3 rounded-[10px] border border-[var(--border-subtle)] px-4 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                            {submission.title}
                          </p>
                          <p className="text-[11.5px] text-[var(--text-muted)]">
                            {new Date(submission.created_at).toLocaleDateString()}
                            {submission.submitted_by &&
                              inbox.submitterNames[submission.submitted_by] &&
                              ` · ${inbox.submitterNames[submission.submitted_by]}`}
                          </p>
                          {submission.notes && (
                            <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                              {submission.notes}
                            </p>
                          )}
                          {submission.review_notes && (
                            <p className="mt-1 text-[12px] leading-relaxed text-[var(--accent-gold-strong)]">
                              {submission.review_notes}
                            </p>
                          )}
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <Badge variant={STATUS_TONE[submission.status]}>
                            {STATUS_LABEL[submission.status]}
                          </Badge>

                          {/* noreferrer as well as noopener: the href is a URL a
                              client typed, and it does not need our page in its
                              referrer. */}
                          <a
                            href={submission.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="transition-smooth inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                          >
                            <ExternalLink className="size-3.5" aria-hidden />
                            Open
                          </a>

                          {submission.status !== "in_use" && (
                            <Button
                              variant="primary"
                              size="sm"
                              loading={busyId === submission.id}
                              onClick={() => void mark(submission, "in_use")}
                            >
                              <Check />
                              In use
                            </Button>
                          )}
                          {submission.status !== "rejected" && (
                            <Button
                              variant="danger"
                              size="sm"
                              loading={busyId === submission.id}
                              onClick={() => void mark(submission, "rejected")}
                            >
                              <X />
                              Reject
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
