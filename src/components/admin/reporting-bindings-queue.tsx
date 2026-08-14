"use client";

import * as React from "react";
import {
  Ban,
  Database,
  Link2,
  RefreshCw,
  Rocket,
  ShieldAlert,
  Upload,
} from "lucide-react";
import { useRouter } from "next/navigation";

import { FormAlert } from "@/components/auth/auth-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  ClientReportingCutoverQueue,
  ReportingCutoverCandidate,
  ReportingCutoverClient,
} from "@/lib/client-onboarding/reporting-cutover";

const CLIENT_STATUS: Record<
  ReportingCutoverClient["status"],
  { label: string; variant: "neutral" | "gold" | "success" | "warning" | "danger" }
> = {
  bindings_required: { label: "Bindings required", variant: "warning" },
  ready_to_sync: { label: "Ready for 90-day sync", variant: "gold" },
  ready_to_activate: { label: "Ready to activate", variant: "success" },
  active: { label: "Reporting active", variant: "success" },
  replacement_required: { label: "Replacement required", variant: "warning" },
  blocked: { label: "Blocked", variant: "danger" },
};

const CANDIDATE_LABEL: Record<ReportingCutoverCandidate["kind"], string> = {
  provision: "Provision identity",
  adopt: "Adopt identity",
  restage: "Restage identity",
  upgrade: "Upgrade exact reconnect",
};

export function ReportingBindingsQueue({ queue }: { queue: ClientReportingCutoverQueue }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<{
    tone: "error" | "success";
    message: string;
  } | null>(null);

  async function execute(actionId: string, success: string, confirmMessage?: string) {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setBusy(actionId);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/reporting-bindings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "The reporting workflow action could not be completed.",
        );
      }
      setFeedback({ tone: "success", message: success });
      router.refresh();
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "The reporting workflow action failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-5" aria-labelledby="reporting-cutover-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h3 id="reporting-cutover-title" className="label-caps">
            Phase 2 reporting cutover
          </h3>
          <p className="max-w-4xl text-[13px] leading-relaxed text-[var(--text-muted)]">
            Provision or adopt stable reporting identities, run an explicit 90-day source sync,
            then activate the dedicated reporting marker. Billing boundaries and historical spend
            remain unchanged.
          </p>
        </div>
        {queue.available && (
          <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <Badge variant={queue.candidates.length ? "gold" : "neutral"}>
              {queue.candidates.length} actions
            </Badge>
            <Badge variant="neutral">{queue.clients.length} clients</Badge>
          </div>
        )}
      </div>

      {feedback && <FormAlert tone={feedback.tone}>{feedback.message}</FormAlert>}
      {!queue.available ? (
        <FormAlert>
          Phase 2 reporting controls are unavailable. The schema marker and service RPCs must be
          deployed before any cutover write can run.
        </FormAlert>
      ) : (
        <>
          <div className="overflow-hidden rounded-[12px] border border-[var(--border-subtle)]">
            {queue.clients.map((client) => {
              const status = CLIENT_STATUS[client.status];
              return (
                <React.Fragment key={client.id}>
                  <div className="grid gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] p-4 lg:grid-cols-[minmax(180px,1fr)_minmax(220px,1.35fr)_auto] lg:items-center">
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                        {client.name}
                      </p>
                      <p className="truncate text-[11.5px] text-[var(--text-muted)]">
                        {client.email}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={status.variant}>{status.label}</Badge>
                        <span className="text-[11px] text-[var(--text-muted)]">
                          {client.boundSourceCount}/{client.sourceCount} authoritative ·{" "}
                          {client.syncedSourceCount}/{client.sourceCount} synced
                        </span>
                      </div>
                      <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                        {client.message}
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                      {client.syncActionId && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          loading={busy === client.syncActionId}
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void execute(
                              client.syncActionId!,
                              "The exact 90-day reporting sources were synced and receipted.",
                            )
                          }
                        >
                          <RefreshCw aria-hidden />
                          Sync 90 days
                        </Button>
                      )}
                      {client.activateActionId && (
                        <Button
                          type="button"
                          size="sm"
                          variant="primary"
                          loading={busy === client.activateActionId}
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void execute(
                              client.activateActionId!,
                              "The dedicated reporting cutover marker is active.",
                              `Activate reporting for ${client.name}? This requires complete 90-day receipts.`,
                            )
                          }
                        >
                          <Rocket aria-hidden />
                          Activate reporting
                        </Button>
                      )}
                      {!client.syncActionId &&
                        !client.activateActionId &&
                        client.status !== "active" && (
                          <span className="text-[11px] text-[var(--text-muted)]">
                            No cutover write
                          </span>
                        )}
                    </div>
                  </div>
                  {client.stagedSources.map((source) => (
                    <div
                      key={source.bindingId}
                      className="grid gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3 pl-7 lg:grid-cols-[minmax(180px,1fr)_minmax(280px,1.35fr)_auto] lg:items-center"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Badge variant="warning">Staged</Badge>
                          <p className="truncate text-[12.5px] text-[var(--text-primary)]">
                            {source.sourceLabel}
                          </p>
                        </div>
                        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                          {source.syncedSourceCount}/{source.sourceCount} receipts ·{" "}
                          {source.billingReady ? "billing ready" : "billing pending"}
                        </p>
                      </div>
                      <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                        {source.message}
                      </p>
                      <div className="flex flex-wrap justify-end gap-2">
                        {source.syncActionId && (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            loading={busy === source.syncActionId}
                            disabled={Boolean(busy)}
                            onClick={() =>
                              void execute(
                                source.syncActionId!,
                                "The staged source was fully overwritten and receipted for 90 days.",
                              )
                            }
                          >
                            <RefreshCw aria-hidden />
                            Sync staged
                          </Button>
                        )}
                        {source.promoteActionId && (
                          <Button
                            type="button"
                            size="sm"
                            variant="primary"
                            loading={busy === source.promoteActionId}
                            disabled={Boolean(busy)}
                            onClick={() =>
                              void execute(
                                source.promoteActionId!,
                                "The staged source is now part of reporting authority.",
                                `Promote ${source.sourceLabel} into reporting authority?`,
                              )
                            }
                          >
                            <Upload aria-hidden />
                            Promote
                          </Button>
                        )}
                        {source.abandonActionId && (
                          <Button
                            type="button"
                            size="sm"
                            variant="danger"
                            loading={busy === source.abandonActionId}
                            disabled={Boolean(busy)}
                            onClick={() =>
                              void execute(
                                source.abandonActionId!,
                                "The staged source was abandoned without deleting its history.",
                                `Abandon ${source.sourceLabel}? Its normalized history will be retained.`,
                              )
                            }
                          >
                            <Ban aria-hidden />
                            Abandon
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </React.Fragment>
              );
            })}
          </div>

          {queue.candidates.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Database className="size-3.5 text-[var(--accent-gold)]" aria-hidden />
                <h4 className="text-[12.5px] font-medium text-[var(--text-primary)]">
                  Eligible source identities
                </h4>
              </div>
              <ul className="overflow-hidden rounded-[12px] border border-[var(--border-subtle)]">
                {queue.candidates.map((candidate) => (
                  <li
                    key={candidate.id}
                    className="grid gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] p-4 last:border-b-0 lg:grid-cols-[minmax(170px,0.8fr)_minmax(240px,1.35fr)_minmax(190px,1fr)_auto] lg:items-center"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                        {candidate.clientName}
                      </p>
                      <p className="truncate text-[11.5px] text-[var(--text-muted)]">
                        {candidate.clientEmail}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] text-[var(--text-primary)]">
                        {candidate.sourceLabel}
                      </p>
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                        {candidate.message}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <Badge variant={candidate.requiresExplicitReview ? "warning" : "gold"}>
                        {candidate.requiresExplicitReview ? (
                          <ShieldAlert className="size-3" aria-hidden />
                        ) : null}
                        {candidate.kind === "adopt"
                          ? "Explicit adoption"
                          : candidate.kind === "restage"
                            ? "Explicit restage"
                            : candidate.kind}
                      </Badge>
                      {candidate.existingAccountName && (
                        <p className="mt-1.5 truncate text-[11.5px] text-[var(--text-muted)]">
                          Existing: {candidate.existingAccountName}
                        </p>
                      )}
                    </div>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        size="sm"
                        variant={candidate.requiresExplicitReview ? "secondary" : "primary"}
                        loading={busy === candidate.id}
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void execute(
                            candidate.id,
                            "The reporting identity was committed or staged as reviewed. Billing and spend history were not rewritten.",
                            candidate.requiresExplicitReview
                              ? `${candidate.kind === "restage" ? "Restage" : "Adopt"} ${candidate.existingAccountName ?? "this pending shell"} for ${candidate.sourceLabel}? The server will recheck its exact immutable identity and history.`
                              : undefined,
                          )
                        }
                      >
                        <Link2 aria-hidden />
                        {CANDIDATE_LABEL[candidate.kind]}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
