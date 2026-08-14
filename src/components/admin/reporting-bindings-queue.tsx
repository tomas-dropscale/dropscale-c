"use client";

import * as React from "react";
import { Link2, Megaphone, Store } from "lucide-react";
import { useRouter } from "next/navigation";

import { FormAlert } from "@/components/auth/auth-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  ReportingBindingQueue,
  ReportingBindingQueueItem,
  ReportingBindingQueueStatus,
} from "@/lib/client-onboarding/reporting-bindings";

const STATUS: Record<
  ReportingBindingQueueStatus,
  { label: string; variant: "neutral" | "gold" | "success" | "warning" | "danger" }
> = {
  eligible: { label: "Exact match", variant: "gold" },
  bound: { label: "Bound", variant: "success" },
  no_exact_legacy_match: { label: "No legacy match", variant: "warning" },
  agency_access_required: { label: "Agency access required", variant: "danger" },
  ambiguous_legacy_match: { label: "Ambiguous match", variant: "danger" },
  waiting_for_shopify_anchor: { label: "Waiting for store anchor", variant: "neutral" },
  legacy_already_bound: { label: "Legacy identity in use", variant: "warning" },
  legacy_identity_reserved: { label: "Reserved for exact source", variant: "neutral" },
  client_not_approved: { label: "Client not approved", variant: "danger" },
  internal_owner: { label: "Internal owner", variant: "neutral" },
};

function sourceLabel(item: ReportingBindingQueueItem) {
  if (item.shopify && item.googleAds) {
    return `${item.shopify.domain} + ${item.googleAds.customerId}`;
  }
  return item.shopify?.domain ?? item.googleAds?.customerId ?? "Unknown source";
}

export function ReportingBindingsQueue({ queue }: { queue: ReportingBindingQueue }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<{
    tone: "error" | "success";
    message: string;
  } | null>(null);
  const eligible = queue.items.filter((item) => item.canCommit).length;
  const blocked = queue.items.filter(
    (item) => item.status !== "eligible" && item.status !== "bound",
  ).length;

  async function commit(item: ReportingBindingQueueItem) {
    setBusy(item.id);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/reporting-bindings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: item.id }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "The exact binding could not be committed.",
        );
      }
      setFeedback({
        tone: "success",
        message: "Reporting identity bound. Financial history and client activation were unchanged.",
      });
      router.refresh();
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "The binding request failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="reporting-bindings-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h3 id="reporting-bindings-title" className="label-caps">
            V2 reporting bindings
          </h3>
          <p className="max-w-4xl text-[13px] leading-relaxed text-[var(--text-muted)]">
            Point connected V2 assets at existing reporting identities. This never creates an ad
            account, changes activation or rewrites spend and billing history.
          </p>
        </div>
        {queue.available && (
          <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <Badge variant={eligible ? "gold" : "neutral"}>{eligible} exact</Badge>
            <Badge variant={blocked ? "warning" : "neutral"}>{blocked} blocked</Badge>
          </div>
        )}
      </div>

      {feedback && <FormAlert tone={feedback.tone}>{feedback.message}</FormAlert>}
      {!queue.available ? (
        <FormAlert>
          Reporting bindings are unavailable. No match can be committed until the audit loads
          successfully.
        </FormAlert>
      ) : queue.items.length === 0 ? (
        <p className="text-[13px] text-[var(--text-muted)]">No connected V2 assets to audit.</p>
      ) : (
        <ul className="overflow-hidden rounded-[12px] border border-[var(--border-subtle)]">
          {queue.items.map((item) => {
            const status = STATUS[item.status];
            return (
              <li
                key={item.id}
                className="grid gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] p-4 last:border-b-0 lg:grid-cols-[minmax(170px,0.8fr)_minmax(220px,1.25fr)_minmax(190px,1fr)_auto] lg:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                    {item.clientName}
                  </p>
                  <p className="truncate text-[11.5px] text-[var(--text-muted)]">
                    {item.clientEmail || item.rolloutSurface.replaceAll("_", " ")}
                  </p>
                </div>

                <div className="flex min-w-0 items-start gap-2">
                  {item.assetKind === "google_ads" ? (
                    <Megaphone className="mt-0.5 size-3.5 shrink-0 text-[var(--accent-gold)]" />
                  ) : (
                    <Store className="mt-0.5 size-3.5 shrink-0 text-[var(--accent-gold)]" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] text-[var(--text-primary)]">
                      {sourceLabel(item)}
                    </p>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                      {item.message}
                    </p>
                  </div>
                </div>

                <div className="min-w-0">
                  <Badge variant={status.variant}>{status.label}</Badge>
                  {item.legacyAccount && (
                    <p className="mt-1.5 truncate text-[11.5px] text-[var(--text-muted)]">
                      Existing: {item.legacyAccount.name}
                    </p>
                  )}
                </div>

                <div className="flex justify-end">
                  {item.canCommit ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      loading={busy === item.id}
                      disabled={Boolean(busy)}
                      onClick={() => commit(item)}
                    >
                      <Link2 />
                      Bind exact match
                    </Button>
                  ) : (
                    <span className="text-[11px] text-[var(--text-muted)]">No write available</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
