"use client";

import * as React from "react";
import {
  BadgeDollarSign,
  CircleAlert,
  CircleCheck,
  Clock3,
  Layers,
  Link2,
  RefreshCw,
  Rocket,
  Trash2,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  ClientReportingCutoverQueue,
  ReportingCutoverClient,
} from "@/lib/client-onboarding/reporting-cutover";

/**
 * The admin surface for the staged reporting lifecycle.
 *
 * Every RPC behind these buttons has existed and been tested since migration
 * 0056 — stage, sync, promote, abandon — and none of them was ever reachable:
 * the queue was computed only for the hourly cron, so a source could be added
 * to a live client in theory and by nobody in practice.
 *
 * Nothing here is new behaviour. It calls the same action ids the cron calls,
 * through the same endpoint, with the same server-side eligibility checks. An
 * id that has gone stale is refused by the server rather than trusted here.
 */

type Feedback = { tone: "error" | "success"; message: string } | null;

const STATUS_LABEL: Record<ReportingCutoverClient["status"], string> = {
  bindings_required: "Sources not bound",
  ready_to_sync: "Ready to sync",
  ready_to_activate: "Ready to activate",
  active: "Live",
  replacement_required: "Replacement required",
  blocked: "Blocked",
};

function statusBadge(status: ReportingCutoverClient["status"]) {
  if (status === "active") return <Badge variant="success">Live</Badge>;
  if (status === "blocked" || status === "replacement_required") {
    return <Badge variant="danger">{STATUS_LABEL[status]}</Badge>;
  }
  return <Badge>{STATUS_LABEL[status]}</Badge>;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(body: unknown, fallback: string) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string") return error;
  }
  return fallback;
}

export function ReportingSourcesManager({
  initialQueue,
  loadFailed,
}: {
  initialQueue: ClientReportingCutoverQueue;
  loadFailed: boolean;
}) {
  const [queue, setQueue] = React.useState(initialQueue);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [feedback, setFeedback] = React.useState<Feedback>(null);

  async function refresh() {
    setRefreshing(true);
    try {
      const response = await fetch("/api/admin/reporting-bindings", {
        cache: "no-store",
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(errorMessage(body, "The reporting queue could not be read."));
      }
      const next = (body as { queue?: ClientReportingCutoverQueue }).queue;
      if (next) setQueue(next);
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The reporting queue could not be read.",
      });
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * Every button is the same call. The server re-derives the queue and refuses
   * a stale id, so the worst outcome of a slow page is a clear rejection.
   */
  async function run(actionId: string, label: string) {
    setBusy(actionId);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/reporting-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(errorMessage(body, `${label} could not be completed.`));
      }
      setFeedback({ tone: "success", message: `${label} completed.` });
      await refresh();
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : `${label} could not be completed.`,
      });
    } finally {
      setBusy(null);
    }
  }

  /**
   * The step between Sync and Promote. A staged Google source needs its
   * immutable billing baseline captured, and the automatic path only considers
   * active bindings — so without this the source waits forever.
   */
  async function startBillingBaseline(accountId: string) {
    setBusy(accountId);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/google-ads/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(
          errorMessage(body, "The Google billing baseline could not be started."),
        );
      }
      setFeedback({
        tone: "success",
        message: "Billing baseline started. Promote is now available.",
      });
      await refresh();
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The Google billing baseline could not be started.",
      });
    } finally {
      setBusy(null);
    }
  }

  /**
   * A store bound on its own with a mapped Google account waiting outside is a
   * dead end the queue cannot describe: the account's identity already belongs
   * to the client's own legacy row, so no candidate is offered and no reason is
   * given. This rebuilds the pair onto that same row.
   */
  async function rebindSources(clientId: string, clientName: string) {
    setBusy(`rebind:${clientId}`);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/client-onboarding/rebind-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(
          errorMessage(body, `${clientName}'s sources could not be rebound.`),
        );
      }
      const result = body as {
        rebound?: { store: string; googleAccount: string | null; shape: string }[];
        skipped?: { reason: string }[];
      };
      const rebound = result.rebound ?? [];
      const bound = rebound
        .map((item) =>
          item.googleAccount
            ? `${item.store} + ${item.googleAccount} — ${item.shape}`
            : `${item.store} — ${item.shape}`,
        )
        .join("; ");
      setFeedback({
        tone: rebound.length > 0 ? "success" : "error",
        message: [
          rebound.length > 0
            ? `Rebound for ${clientName}: ${bound}.`
            : `Nothing was rebound for ${clientName}.`,
          ...(result.skipped ?? []).map((item) => item.reason),
        ].join(" "),
      });
      await refresh();
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : `${clientName}'s sources could not be rebound.`,
      });
    } finally {
      setBusy(null);
    }
  }

  if (loadFailed || !queue.available) {
    return (
      <div className="panel p-5 text-[13px] text-[var(--text-secondary)]">
        <p className="flex items-center gap-2 font-medium text-[var(--text-primary)]">
          <CircleAlert className="size-4 text-[var(--danger-red)]" aria-hidden />
          The reporting queue is unavailable
        </p>
        <p className="mt-2">
          It is computed from the same snapshot the hourly sync uses. If this
          persists, the reporting service is not configured on the server.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px] text-[var(--text-secondary)]">
          Sources waiting to be brought in, and the staged sources of each live
          client. A staged source proves 90 days of facts before it can be promoted.
        </p>
        <Button type="button" size="sm" loading={refreshing} onClick={() => void refresh()}>
          <RefreshCw aria-hidden /> Refresh
        </Button>
      </div>

      {feedback && (
        <p
          role="alert"
          className={`text-[12.5px] ${
            feedback.tone === "error"
              ? "text-[var(--danger-red)]"
              : "text-[var(--text-secondary)]"
          }`}
        >
          {feedback.message}
        </p>
      )}

      {queue.candidates.length > 0 && (
        <section className="panel p-4 sm:p-5">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
            <Layers className="size-4 text-[var(--accent-gold-strong)]" aria-hidden />
            Sources waiting to be brought in
          </h2>
          <ul className="mt-3 space-y-2.5">
            {queue.candidates.map((candidate) => (
              <li
                key={candidate.id}
                className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[var(--text-primary)]">
                      {candidate.clientName}
                      {candidate.existingAccountName
                        ? ` · ${candidate.existingAccountName}`
                        : ""}
                    </p>
                    <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
                      {candidate.sourceLabel}
                    </p>
                    <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
                      {candidate.message}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {candidate.requiresExplicitReview && (
                      <Badge variant="danger">Needs review</Badge>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      loading={busy === candidate.id}
                      onClick={() => void run(candidate.id, candidate.kind)}
                    >
                      <Zap aria-hidden /> {candidate.kind}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel p-4 sm:p-5">
        <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Clients</h2>
        <ul className="mt-3 space-y-3">
          {queue.clients.map((client) => (
            <li
              key={client.id}
              className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                    {client.name}
                    {statusBadge(client.status)}
                  </p>
                  <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
                    {client.boundSourceCount}/{client.sourceCount} sources bound ·{" "}
                    {client.syncedSourceCount} synced
                    {client.reportingCutoverAt
                      ? ` · live since ${client.reportingCutoverAt.slice(0, 10)}`
                      : ""}
                  </p>
                  <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
                    {client.message}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {client.status === "bindings_required" && (
                    <Button
                      type="button"
                      size="sm"
                      loading={busy === `rebind:${client.id}`}
                      onClick={() => void rebindSources(client.id, client.name)}
                    >
                      <Link2 aria-hidden /> Rebind sources
                    </Button>
                  )}
                  {client.syncActionId && (
                    <Button
                      type="button"
                      size="sm"
                      loading={busy === client.syncActionId}
                      onClick={() => void run(client.syncActionId!, "Sync")}
                    >
                      <RefreshCw aria-hidden /> Sync
                    </Button>
                  )}
                  {client.activateActionId && (
                    <Button
                      type="button"
                      size="sm"
                      loading={busy === client.activateActionId}
                      onClick={() => void run(client.activateActionId!, "Activate")}
                    >
                      <Rocket aria-hidden /> Activate
                    </Button>
                  )}
                </div>
              </div>

              {client.stagedSources.length > 0 && (
                <ul className="mt-3 space-y-2 border-t border-[var(--border-subtle)] pt-3">
                  {client.stagedSources.map((source) => (
                    <li
                      key={source.bindingId}
                      className="flex flex-wrap items-start justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-primary)]">
                          <Clock3
                            className="size-3.5 text-[var(--accent-gold-strong)]"
                            aria-hidden
                          />
                          {source.sourceLabel}
                          {source.billingReady && (
                            <CircleCheck
                              className="size-3.5 text-[var(--success-green,#7bbf7b)]"
                              aria-label="Billing ready"
                            />
                          )}
                        </p>
                        <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                          {source.syncedSourceCount}/{source.sourceCount} synced ·{" "}
                          {source.message}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {source.syncActionId && (
                          <Button
                            type="button"
                            size="sm"
                            loading={busy === source.syncActionId}
                            onClick={() => void run(source.syncActionId!, "Sync")}
                          >
                            <RefreshCw aria-hidden /> Sync
                          </Button>
                        )}
                        {source.needsBillingBaseline && !source.promoteActionId && (
                          <Button
                            type="button"
                            size="sm"
                            loading={busy === source.adAccountId}
                            onClick={() => void startBillingBaseline(source.adAccountId)}
                          >
                            <BadgeDollarSign aria-hidden /> Start billing baseline
                          </Button>
                        )}
                        {source.promoteActionId && (
                          <Button
                            type="button"
                            size="sm"
                            loading={busy === source.promoteActionId}
                            onClick={() => void run(source.promoteActionId!, "Promote")}
                          >
                            <Rocket aria-hidden /> Promote
                          </Button>
                        )}
                        {source.abandonActionId && (
                          <Button
                            type="button"
                            size="sm"
                            variant="danger"
                            loading={busy === source.abandonActionId}
                            onClick={() => void run(source.abandonActionId!, "Abandon")}
                          >
                            <Trash2 aria-hidden /> Abandon
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        {queue.clients.length === 0 && (
          <p className="mt-2 text-[12.5px] text-[var(--text-secondary)]">
            No client is in the reporting lifecycle right now.
          </p>
        )}
      </section>
    </div>
  );
}
