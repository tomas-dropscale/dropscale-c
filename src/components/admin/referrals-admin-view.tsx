"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BadgePercent,
  CalendarDays,
  CheckCircle2,
  Clock3,
  History,
  Link2,
  ShieldCheck,
  TriangleAlert,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react";

import { FormAlert } from "@/components/auth/auth-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label, Textarea } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type ReferralTermSummary = {
  id: string;
  effectiveFrom: string;
  revision: number;
  action: "grant" | "revoke";
  decisionReferredClientId: string;
  expectedTermId: string | null;
  listRate: number;
  referralStepRate: number;
  referralCount: number;
  referralDiscountRate: number;
  feeRate: number;
  reason: string;
  reviewedBy: string;
  createdAt: string;
  sealedAt: string;
};

export type ReferralEvidenceSummary = {
  billingStartId: string;
  commissionId: string;
  eligibilityCheckedOn: string;
  occurredOn: string;
  grossAmount: number;
  billableAmount: number;
  storeName: string;
};

export type ReferralCandidateSummary = {
  clientId: string;
  name: string;
  email: string;
  approvalStatus: string;
  attributedToReferrer: boolean;
  workspaceConflict: boolean;
  currentGranted: boolean;
  scheduledGranted: boolean;
  grantEligible: boolean;
  actionBlockedReason: string | null;
  recentEvidence: ReferralEvidenceSummary | null;
  approvedEvidence: ReferralEvidenceSummary | null;
};

export type ReferralReferrerSummary = {
  clientId: string;
  name: string;
  email: string;
  approvalStatus: string;
  currentTerm: ReferralTermSummary | null;
  scheduledTerm: ReferralTermSummary | null;
  referrals: ReferralCandidateSummary[];
  history: ReferralTermSummary[];
};

export type ReferralAttributionClientSummary = {
  clientId: string;
  name: string;
  email: string;
  approvalStatus: string;
};

export type ReferralAttributionReferrerSummary = {
  clientId: string;
  name: string;
  email: string;
};

export type ReferralAttributionEventSummary = {
  id: string;
  decisionId: string;
  referredClientId: string;
  referredClientName: string;
  referrerClientId: string;
  referrerName: string;
  reason: string;
  reviewedBy: string;
  createdAt: string;
  sealedAt: string;
};

export type ReferralAdminDashboard = {
  generatedAt: string;
  lisbonToday: string;
  currentWeekStart: string;
  effectiveFrom: string;
  activityCutoff: string;
  loadError: string | null;
  unassignedClients: ReferralAttributionClientSummary[];
  approvedReferrers: ReferralAttributionReferrerSummary[];
  attributionEvents: ReferralAttributionEventSummary[];
  referrers: ReferralReferrerSummary[];
};

type DecisionTarget = {
  referrerId: string;
  referrerName: string;
  referredClientId: string;
  referredClientName: string;
  action: "grant" | "revoke";
  expectedTermId: string | null;
  effectiveFrom: string;
  currentFeeRate: number;
  decisionId: string;
};

type DecisionReceipt = {
  referrerName: string;
  referredClientName: string;
  action: "grant" | "revoke";
  effectiveFrom: string;
  referralCount: number;
  discountRate: number;
  feeRate: number;
};

type AttributionReceipt = {
  id: string;
  decisionId: string;
  referredClientName: string;
  referrerName: string;
  reason: string;
  reviewedBy: string;
  createdAt: string;
  sealedAt: string;
};

function formatDay(day: string) {
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-GB");
}

function formatRate(value: number) {
  return `${new Intl.NumberFormat("en-GB", {
    minimumFractionDigits: value % 1 === 0 ? 0 : 1,
    maximumFractionDigits: 2,
  }).format(value)}%`;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

function shortId(value: string | null) {
  return value ? `${value.slice(0, 8)}…` : "default 10% term";
}

function responseError(body: unknown, fallback: string) {
  if (!body || typeof body !== "object") return fallback;
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" ? error : fallback;
}

function termRate(term: ReferralTermSummary | null) {
  return term?.feeRate ?? 10;
}

function termCount(term: ReferralTermSummary | null) {
  return term?.referralCount ?? 0;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(new Date(value).getTime())
  );
}

export function ReferralsAdminView({
  dashboard,
}: {
  dashboard: ReferralAdminDashboard;
}) {
  const router = useRouter();
  const [target, setTarget] = React.useState<DecisionTarget | null>(null);
  const [reason, setReason] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [modalError, setModalError] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [receipt, setReceipt] = React.useState<DecisionReceipt | null>(null);
  const [attributionClientId, setAttributionClientId] = React.useState("");
  const [attributionReferrerId, setAttributionReferrerId] =
    React.useState("");
  const [attributionReason, setAttributionReason] = React.useState("");
  const [attributionConfirmed, setAttributionConfirmed] =
    React.useState(false);
  const [attributionDecisionId, setAttributionDecisionId] =
    React.useState("");
  const [attributionAttempted, setAttributionAttempted] =
    React.useState(false);
  const [attributionBusy, setAttributionBusy] = React.useState(false);
  const [attributionError, setAttributionError] = React.useState<string | null>(
    null,
  );
  const [attributionFeedback, setAttributionFeedback] = React.useState<
    string | null
  >(null);
  const [attributionReceipt, setAttributionReceipt] =
    React.useState<AttributionReceipt | null>(null);

  const selectedAttributionClient = dashboard.unassignedClients.find(
    (client) => client.clientId === attributionClientId,
  );
  const availableAttributionReferrers = dashboard.approvedReferrers.filter(
    (referrer) => referrer.clientId !== attributionClientId,
  );
  const selectedAttributionReferrer =
    availableAttributionReferrers.find(
      (referrer) => referrer.clientId === attributionReferrerId,
    ) ?? null;

  const scheduledGrantCount = dashboard.referrers.reduce(
    (sum, referrer) => sum + termCount(referrer.scheduledTerm),
    0,
  );
  const changedForEffectiveMonday = dashboard.referrers.filter(
    (referrer) =>
      referrer.scheduledTerm?.effectiveFrom === dashboard.effectiveFrom,
  ).length;

  function openDecision(
    referrer: ReferralReferrerSummary,
    referral: ReferralCandidateSummary,
  ) {
    const action = referral.scheduledGranted ? "revoke" : "grant";
    setFeedback(null);
    setReceipt(null);
    setModalError(null);
    setReason("");
    setConfirmed(false);
    setTarget({
      referrerId: referrer.clientId,
      referrerName: referrer.name,
      referredClientId: referral.clientId,
      referredClientName: referral.name,
      action,
      expectedTermId: referrer.scheduledTerm?.id ?? null,
      effectiveFrom: dashboard.effectiveFrom,
      currentFeeRate: termRate(referrer.scheduledTerm),
      decisionId: crypto.randomUUID(),
    });
  }

  function closeDecision() {
    if (busy) return;
    setTarget(null);
    setReason("");
    setConfirmed(false);
    setModalError(null);
  }

  function reviseAttributionDecision() {
    setAttributionError(null);
    setAttributionFeedback(null);
    if (attributionAttempted) {
      setAttributionDecisionId("");
      setAttributionAttempted(false);
    }
  }

  async function submitAttribution() {
    if (attributionBusy) return;
    const reviewedReason = attributionReason.trim();
    if (!selectedAttributionClient || !selectedAttributionReferrer) {
      setAttributionError(
        "Select an unassigned client and a different approved referrer.",
      );
      return;
    }
    if (!reviewedReason) {
      setAttributionError("An audit reason is required.");
      return;
    }
    if (reviewedReason.length > 1000) {
      setAttributionError(
        "The attribution reason must be 1,000 characters or fewer.",
      );
      return;
    }
    if (!attributionConfirmed) {
      setAttributionError("Confirm the permanent attribution first.");
      return;
    }

    const decisionId = attributionDecisionId || crypto.randomUUID();
    if (!attributionDecisionId) setAttributionDecisionId(decisionId);
    setAttributionAttempted(true);
    setAttributionBusy(true);
    setAttributionError(null);
    setAttributionFeedback(null);
    try {
      const response = await fetch("/api/admin/referrals/attribution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          referredClientId: selectedAttributionClient.clientId,
          referrerClientId: selectedAttributionReferrer.clientId,
          decisionId,
          reason: reviewedReason,
          confirmed: true,
        }),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const message = responseError(
          body,
          "The referral attribution could not be assigned.",
        );
        if (response.status === 409) {
          setAttributionClientId("");
          setAttributionReferrerId("");
          setAttributionReason("");
          setAttributionConfirmed(false);
          setAttributionDecisionId("");
          setAttributionAttempted(false);
          setAttributionFeedback(
            `${message} The dashboard is refreshing with the latest attribution state.`,
          );
          router.refresh();
          return;
        }
        throw new Error(message);
      }

      const record =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : null;
      const attribution =
        record?.attribution && typeof record.attribution === "object"
          ? (record.attribution as Record<string, unknown>)
          : null;
      if (
        !attribution ||
        typeof attribution.id !== "string" ||
        !UUID.test(attribution.id) ||
        attribution.decisionId !== decisionId ||
        attribution.referredClientId !== selectedAttributionClient.clientId ||
        attribution.referrerClientId !== selectedAttributionReferrer.clientId ||
        attribution.reason !== reviewedReason ||
        typeof attribution.reviewedBy !== "string" ||
        !UUID.test(attribution.reviewedBy) ||
        !isTimestamp(attribution.createdAt) ||
        !isTimestamp(attribution.sealedAt)
      ) {
        throw new Error(
          "The attribution was saved, but its sealed receipt was incomplete. Refresh.",
        );
      }

      setAttributionReceipt({
        id: attribution.id,
        decisionId,
        referredClientName: selectedAttributionClient.name,
        referrerName: selectedAttributionReferrer.name,
        reason: attribution.reason,
        reviewedBy: attribution.reviewedBy,
        createdAt: attribution.createdAt,
        sealedAt: attribution.sealedAt,
      });
      setAttributionClientId("");
      setAttributionReferrerId("");
      setAttributionReason("");
      setAttributionConfirmed(false);
      setAttributionDecisionId("");
      setAttributionAttempted(false);
      router.refresh();
    } catch (error) {
      setAttributionError(
        error instanceof Error
          ? error.message
          : "The referral attribution could not be assigned.",
      );
    } finally {
      setAttributionBusy(false);
    }
  }

  async function submitDecision() {
    if (!target || busy) return;
    const reviewedReason = reason.trim();
    if (!reviewedReason) {
      setModalError("An audit reason is required.");
      return;
    }
    if (reviewedReason.length > 1000) {
      setModalError("The audit reason must be 1,000 characters or fewer.");
      return;
    }
    if (!confirmed) {
      setModalError("Confirm the Monday-effective commercial change first.");
      return;
    }

    setBusy(true);
    setModalError(null);
    try {
      const response = await fetch("/api/admin/referrals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: target.referrerId,
          referredClientId: target.referredClientId,
          action: target.action,
          expectedTermId: target.expectedTermId,
          decisionId: target.decisionId,
          reason: reviewedReason,
        }),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const message = responseError(
          body,
          "The referral decision could not be scheduled.",
        );
        if (response.status === 409) {
          setTarget(null);
          setReason("");
          setConfirmed(false);
          setFeedback(
            `${message} The dashboard is refreshing with the latest evidence.`,
          );
          router.refresh();
          return;
        }
        throw new Error(message);
      }

      const record =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : null;
      const term =
        record?.term && typeof record.term === "object"
          ? (record.term as Record<string, unknown>)
          : null;
      const referralCount = Number(term?.referralCount);
      const discountRate = Number(term?.referralDiscountRate);
      const feeRate = Number(term?.feeRate);
      if (
        typeof record?.effectiveFrom !== "string" ||
        !Number.isInteger(referralCount) ||
        !Number.isFinite(discountRate) ||
        !Number.isFinite(feeRate)
      ) {
        throw new Error(
          "The decision was saved, but its sealed receipt was incomplete. Refresh.",
        );
      }

      setReceipt({
        referrerName: target.referrerName,
        referredClientName: target.referredClientName,
        action: target.action,
        effectiveFrom: record.effectiveFrom,
        referralCount,
        discountRate,
        feeRate,
      });
      setTarget(null);
      setReason("");
      setConfirmed(false);
      router.refresh();
    } catch (error) {
      setModalError(
        error instanceof Error
          ? error.message
          : "The referral decision could not be scheduled.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="panel overflow-hidden">
        <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div>
              <div className="flex items-center gap-2">
                <Badge variant="gold">Step 1</Badge>
                <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
                  Permanent referral attribution
                </h2>
              </div>
              <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-[var(--text-secondary)]">
                Record who introduced an unassigned client. This seals the
                attribution only; it does not grant a discount or change an
                invoice. Commercial approval is a separate Step 2 below.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
              <Link2 className="size-3.5 text-[var(--accent-gold)]" aria-hidden />
              {dashboard.unassignedClients.length} unassigned ·{" "}
              {dashboard.attributionEvents.length} sealed events
            </div>
          </div>
        </div>

        <div className="space-y-5 p-4 sm:p-5">
          {attributionFeedback && <FormAlert>{attributionFeedback}</FormAlert>}
          {attributionError && <FormAlert>{attributionError}</FormAlert>}
          {attributionReceipt && (
            <FormAlert tone="success">
              <span className="font-semibold">Attribution sealed.</span>{" "}
              {attributionReceipt.referredClientName}
              <ArrowRight className="mx-1 inline size-3.5" aria-hidden />
              {attributionReceipt.referrerName} ·{" "}
              {formatTimestamp(attributionReceipt.sealedAt)}. Receipt{" "}
              <span className="font-mono">{shortId(attributionReceipt.id)}</span>{" "}
              · decision{" "}
              <span className="font-mono">
                {shortId(attributionReceipt.decisionId)}
              </span>
              . No commercial discount was granted.
              <span className="mt-1 block text-[11px]">
                Reason: {attributionReceipt.reason} · reviewer{" "}
                <span className="font-mono">
                  {shortId(attributionReceipt.reviewedBy)}
                </span>{" "}
                · created {formatTimestamp(attributionReceipt.createdAt)}
              </span>
            </FormAlert>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="attribution-client">Unassigned client</Label>
              <Select
                value={attributionClientId || undefined}
                onValueChange={(value) => {
                  setAttributionClientId(value);
                  if (value === attributionReferrerId) {
                    setAttributionReferrerId("");
                  }
                  reviseAttributionDecision();
                }}
                disabled={
                  attributionBusy ||
                  Boolean(dashboard.loadError) ||
                  dashboard.unassignedClients.length === 0
                }
              >
                <SelectTrigger id="attribution-client">
                  <SelectValue placeholder="Select a client" />
                </SelectTrigger>
                <SelectContent>
                  {dashboard.unassignedClients.map((client) => (
                    <SelectItem key={client.clientId} value={client.clientId}>
                      {client.name} · {client.email} · {client.approvalStatus}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10.5px] text-[var(--text-muted)]">
                Rejected and already-attributed clients are deliberately
                excluded.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="attribution-referrer">Approved referrer</Label>
              <Select
                value={attributionReferrerId || undefined}
                onValueChange={(value) => {
                  setAttributionReferrerId(value);
                  reviseAttributionDecision();
                }}
                disabled={
                  attributionBusy ||
                  Boolean(dashboard.loadError) ||
                  availableAttributionReferrers.length === 0
                }
              >
                <SelectTrigger id="attribution-referrer">
                  <SelectValue placeholder="Select an approved referrer" />
                </SelectTrigger>
                <SelectContent>
                  {availableAttributionReferrers.map((referrer) => (
                    <SelectItem
                      key={referrer.clientId}
                      value={referrer.clientId}
                    >
                      {referrer.name} · {referrer.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10.5px] text-[var(--text-muted)]">
                Self-referral is excluded here; SQL rechecks approval,
                workspace and cycle rules atomically.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="attribution-reason">Required audit reason</Label>
            <Textarea
              id="attribution-reason"
              rows={3}
              maxLength={1000}
              value={attributionReason}
              onChange={(event) => {
                setAttributionReason(event.target.value);
                reviseAttributionDecision();
              }}
              placeholder="What independent evidence confirms that this referrer introduced this client?"
              disabled={attributionBusy || Boolean(dashboard.loadError)}
            />
            <p className="text-right text-[10.5px] text-[var(--text-muted)]">
              {attributionReason.length}/1000
            </p>
          </div>

          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-[var(--warning-orange)]/25 bg-[var(--warning-orange)]/10 p-3 transition-smooth hover:border-[var(--warning-orange)]/45">
            <Checkbox
              checked={attributionConfirmed}
              onCheckedChange={(checked) => {
                setAttributionConfirmed(checked === true);
                reviseAttributionDecision();
              }}
              className="mt-0.5"
              aria-label="Confirm permanent referral attribution"
              disabled={attributionBusy || Boolean(dashboard.loadError)}
            />
            <span className="text-[12.5px] leading-relaxed text-[var(--text-primary)]">
              I reviewed the evidence and confirm this permanent attribution.
              It cannot be moved to another referrer, and it does not itself
              approve a commercial discount.
            </span>
          </label>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="font-mono text-[10px] text-[var(--text-muted)]">
              {attributionDecisionId
                ? `retry-safe decision ${shortId(attributionDecisionId)}`
                : "A retry-safe decision ID is created on submit"}
            </p>
            <Button
              type="button"
              variant="primary"
              className="min-h-10 w-full sm:w-auto"
              loading={attributionBusy}
              disabled={
                Boolean(dashboard.loadError) ||
                !selectedAttributionClient ||
                !selectedAttributionReferrer ||
                !attributionReason.trim() ||
                !attributionConfirmed
              }
              onClick={submitAttribution}
            >
              <Link2 />
              Seal attribution
            </Button>
          </div>

          <details className="group/attribution rounded-xl border border-[var(--border-subtle)]">
            <summary className="transition-smooth flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] sm:px-4 [&::-webkit-details-marker]:hidden">
              <History className="size-3.5 text-[var(--accent-gold)]" aria-hidden />
              <span>
                {dashboard.attributionEvents.length} immutable attribution
                events
              </span>
              <span className="ml-auto text-[var(--text-muted)] group-open/attribution:hidden">
                Show audit trail
              </span>
              <span className="ml-auto hidden text-[var(--text-muted)] group-open/attribution:inline">
                Hide audit trail
              </span>
            </summary>
            {dashboard.attributionEvents.length === 0 ? (
              <p className="border-t border-[var(--border-subtle)] px-4 py-4 text-[11.5px] text-[var(--text-muted)]">
                No manual attribution has been sealed yet.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                {dashboard.attributionEvents.map((event) => (
                  <li
                    key={event.id}
                    className="grid gap-2 px-4 py-3 text-[11.5px] sm:grid-cols-[170px_1fr_auto]"
                  >
                    <div>
                      <Badge variant="success">sealed</Badge>
                      <p className="mt-1 text-[var(--text-muted)]">
                        {formatTimestamp(event.sealedAt)}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-[var(--text-primary)]">
                        {event.referredClientName}
                        <ArrowRight
                          className="mx-1 inline size-3.5 text-[var(--accent-gold)]"
                          aria-hidden
                        />
                        {event.referrerName}
                      </p>
                      <p className="mt-0.5 break-words text-[var(--text-secondary)]">
                        {event.reason}
                      </p>
                    </div>
                    <div className="font-mono text-[10px] text-[var(--text-muted)] sm:text-right">
                      <p>receipt {shortId(event.id)}</p>
                      <p>decision {shortId(event.decisionId)}</p>
                      <p>reviewer {shortId(event.reviewedBy)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
      </section>

      <div>
        <div className="flex items-center gap-2">
          <Badge variant="gold">Step 2</Badge>
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            Monday-effective commercial discount approval
          </h2>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          Review an attributed client&apos;s independent Google billing evidence,
          then grant or revoke its 0.5 percentage-point fee discount in a
          separately sealed term.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="panel p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="label-caps">Effective Monday</p>
            <CalendarDays
              className="size-4 text-[var(--accent-gold)]"
              aria-hidden
            />
          </div>
          <p className="mt-2 text-[20px] font-semibold text-[var(--text-primary)]">
            {formatDay(dashboard.effectiveFrom)}
          </p>
          <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
            Lisbon billing calendar · never retroactive
          </p>
        </div>
        <div className="panel p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="label-caps">Referrers</p>
            <UserRoundCheck
              className="size-4 text-[var(--accent-gold)]"
              aria-hidden
            />
          </div>
          <p className="mt-2 text-[24px] font-semibold text-[var(--text-primary)] tabular-nums">
            {dashboard.referrers.length}
          </p>
          <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
            {changedForEffectiveMonday} with a snapshot for this Monday
          </p>
        </div>
        <div className="panel p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="label-caps">Scheduled grants</p>
            <BadgePercent
              className="size-4 text-[var(--accent-gold)]"
              aria-hidden
            />
          </div>
          <p className="mt-2 text-[24px] font-semibold text-[var(--accent-gold-strong)] tabular-nums">
            {scheduledGrantCount}
          </p>
          <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
            0.5 percentage points each · 10% list fee
          </p>
        </div>
      </div>

      {dashboard.loadError && (
        <FormAlert>
          Referral evidence could not be audited: {dashboard.loadError} No
          pricing action is available until every query succeeds.
        </FormAlert>
      )}
      {feedback && <FormAlert>{feedback}</FormAlert>}
      {receipt && (
        <FormAlert tone="success">
          <span className="font-semibold">
            {receipt.action === "grant" ? "Grant" : "Revocation"} sealed for{" "}
            {receipt.referrerName}.
          </span>{" "}
          {receipt.referredClientName} · effective{" "}
          {formatDay(receipt.effectiveFrom)} · {receipt.referralCount} approved
          referrals · {formatRate(receipt.discountRate)} discount ·{" "}
          {formatRate(receipt.feeRate)} agency fee.
        </FormAlert>
      )}

      {!dashboard.loadError && dashboard.referrers.length === 0 ? (
        <div className="panel px-5 py-12 text-center">
          <BadgePercent
            className="mx-auto size-6 text-[var(--text-muted)]"
            aria-hidden
          />
          <p className="mt-3 text-[13px] text-[var(--text-secondary)]">
            No client has referral attribution or manual referral history yet.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {dashboard.referrers.map((referrer) => {
            const currentFee = termRate(referrer.currentTerm);
            const scheduledFee = termRate(referrer.scheduledTerm);
            return (
              <article
                key={referrer.clientId}
                className="panel overflow-hidden"
              >
                <div className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-start">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-[15px] font-semibold text-[var(--text-primary)]">
                        {referrer.name}
                      </h2>
                      <Badge
                        variant={
                          referrer.approvalStatus === "approved"
                            ? "success"
                            : "danger"
                        }
                      >
                        {referrer.approvalStatus}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate text-[12px] text-[var(--text-muted)]">
                      {referrer.email}
                    </p>
                  </div>

                  <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3 lg:w-[430px]">
                    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
                      <p className="label-caps">Current fee</p>
                      <p className="mt-1 text-[18px] font-semibold text-[var(--text-primary)] tabular-nums">
                        {formatRate(currentFee)}
                      </p>
                      <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                        {termCount(referrer.currentTerm)} grants
                      </p>
                    </div>
                    <div className="rounded-xl border border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] p-3">
                      <p className="label-caps">
                        From {formatDay(dashboard.effectiveFrom)}
                      </p>
                      <p className="mt-1 text-[18px] font-semibold text-[var(--accent-gold-strong)] tabular-nums">
                        {formatRate(scheduledFee)}
                      </p>
                      <p className="mt-0.5 text-[10.5px] text-[var(--text-secondary)]">
                        {termCount(referrer.scheduledTerm)} grants
                      </p>
                    </div>
                    <div className="col-span-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 sm:col-span-1">
                      <p className="label-caps">CAS term</p>
                      <p className="mt-1 truncate font-mono text-[12px] font-medium text-[var(--text-primary)]">
                        {shortId(referrer.scheduledTerm?.id ?? null)}
                      </p>
                      <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">
                        revision {referrer.scheduledTerm?.revision ?? 0}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="border-t border-[var(--border-subtle)]">
                  <div className="flex flex-col items-start justify-between gap-1.5 bg-[var(--bg-base)] px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3 sm:px-5">
                    <p className="label-caps">
                      Attributed clients ({referrer.referrals.length})
                    </p>
                    <p className="text-[10.5px] text-[var(--text-muted)]">
                      Eligibility is rechecked atomically when you confirm
                    </p>
                  </div>

                  {referrer.referrals.length === 0 ? (
                    <p className="px-5 py-6 text-[12.5px] text-[var(--text-muted)]">
                      No attributed client is available for review.
                    </p>
                  ) : (
                    <ul className="divide-y divide-[var(--border-subtle)]">
                      {referrer.referrals.map((referral) => {
                        const action = referral.scheduledGranted
                          ? "revoke"
                          : "grant";
                        const canAct =
                          referrer.approvalStatus === "approved" &&
                          (action === "revoke" || referral.grantEligible);
                        return (
                          <li
                            key={referral.clientId}
                            className="flex flex-col gap-3 px-4 py-4 sm:px-5 lg:flex-row lg:items-center"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                                  {referral.name}
                                </p>
                                <Badge
                                  variant={
                                    referral.scheduledGranted
                                      ? "success"
                                      : referral.grantEligible
                                        ? "gold"
                                        : "neutral"
                                  }
                                >
                                  {referral.scheduledGranted
                                    ? "approved in scheduled term"
                                    : referral.grantEligible
                                      ? "eligible to grant"
                                      : "not eligible to grant"}
                                </Badge>
                                {referral.currentGranted !==
                                  referral.scheduledGranted && (
                                  <Badge variant="warning">
                                    pending Monday change
                                  </Badge>
                                )}
                              </div>
                              <p className="mt-0.5 truncate text-[11.5px] text-[var(--text-muted)]">
                                {referral.email} · {referral.approvalStatus}
                              </p>

                              {referral.recentEvidence &&
                                !referral.scheduledGranted && (
                                  <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                                    <ShieldCheck
                                      className="mr-1 inline size-3.5 text-[var(--success-green)]"
                                      aria-hidden
                                    />
                                    Recent verified Google spend: raw{" "}
                                    {formatMoney(
                                      referral.recentEvidence.grossAmount,
                                    )}{" "}
                                    · billable{" "}
                                    {formatMoney(
                                      referral.recentEvidence.billableAmount,
                                    )}{" "}
                                    on{" "}
                                    {formatDay(
                                      referral.recentEvidence.occurredOn,
                                    )}{" "}
                                    · {referral.recentEvidence.storeName}
                                  </p>
                                )}
                              {referral.approvedEvidence &&
                                referral.scheduledGranted && (
                                  <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                                    <CheckCircle2
                                      className="mr-1 inline size-3.5 text-[var(--success-green)]"
                                      aria-hidden
                                    />
                                    Frozen evidence: raw{" "}
                                    {formatMoney(
                                      referral.approvedEvidence.grossAmount,
                                    )}{" "}
                                    · billable{" "}
                                    {formatMoney(
                                      referral.approvedEvidence.billableAmount,
                                    )}{" "}
                                    on{" "}
                                    {formatDay(
                                      referral.approvedEvidence.occurredOn,
                                    )}{" "}
                                    · checked{" "}
                                    {formatDay(
                                      referral.approvedEvidence
                                        .eligibilityCheckedOn,
                                    )}
                                  </p>
                                )}
                              {referral.actionBlockedReason &&
                                !referral.scheduledGranted && (
                                  <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--warning-orange)]">
                                    <TriangleAlert
                                      className="mr-1 inline size-3.5"
                                      aria-hidden
                                    />
                                    {referral.actionBlockedReason}
                                  </p>
                                )}
                            </div>

                            <div className="flex w-full shrink-0 items-center justify-end gap-2 lg:w-52">
                              {referral.scheduledGranted ? (
                                <UserRoundCheck
                                  className="size-4 text-[var(--success-green)]"
                                  aria-hidden
                                />
                              ) : (
                                <UserRoundX
                                  className="size-4 text-[var(--text-muted)]"
                                  aria-hidden
                                />
                              )}
                              <Button
                                type="button"
                                variant={
                                  action === "grant" ? "primary" : "danger"
                                }
                                size="sm"
                                className="min-h-10"
                                disabled={
                                  !canAct || Boolean(dashboard.loadError)
                                }
                                title={
                                  canAct
                                    ? `${action === "grant" ? "Grant" : "Revoke"} from ${formatDay(dashboard.effectiveFrom)}`
                                    : (referral.actionBlockedReason ??
                                      "The referrer must remain an approved client.")
                                }
                                onClick={() => openDecision(referrer, referral)}
                              >
                                <BadgePercent />
                                {action === "grant"
                                  ? "Grant 0.5 pp"
                                  : "Revoke grant"}
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {referrer.history.length > 0 && (
                  <details className="group/history border-t border-[var(--border-subtle)]">
                    <summary className="transition-smooth flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] sm:px-5 [&::-webkit-details-marker]:hidden">
                      <History
                        className="size-3.5 text-[var(--accent-gold)]"
                        aria-hidden
                      />
                      <span>{referrer.history.length} immutable decisions</span>
                      <span className="ml-auto text-[var(--text-muted)] group-open/history:hidden">
                        Show audit trail
                      </span>
                      <span className="ml-auto hidden text-[var(--text-muted)] group-open/history:inline">
                        Hide audit trail
                      </span>
                    </summary>
                    <ul className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                      {referrer.history.map((term) => {
                        const targetClient = referrer.referrals.find(
                          (candidate) =>
                            candidate.clientId ===
                            term.decisionReferredClientId,
                        );
                        return (
                          <li
                            key={term.id}
                            className="grid gap-2 px-4 py-3 text-[11.5px] sm:grid-cols-[150px_1fr_auto] sm:px-5"
                          >
                            <div>
                              <Badge
                                variant={
                                  term.action === "grant" ? "success" : "danger"
                                }
                              >
                                {term.action}
                              </Badge>
                              <p className="mt-1 text-[var(--text-muted)]">
                                {formatTimestamp(term.createdAt)}
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium text-[var(--text-primary)]">
                                {targetClient?.name ??
                                  term.decisionReferredClientId}
                              </p>
                              <p className="mt-0.5 break-words text-[var(--text-secondary)]">
                                {term.reason}
                              </p>
                            </div>
                            <div className="text-left sm:text-right">
                              <p className="font-medium text-[var(--accent-gold-strong)]">
                                {formatRate(term.feeRate)} fee
                              </p>
                              <p className="mt-0.5 text-[var(--text-muted)]">
                                {formatDay(term.effectiveFrom)} · rev{" "}
                                {term.revision}
                              </p>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      )}

      <Dialog
        open={Boolean(target)}
        onOpenChange={(open) => {
          if (!open) closeDecision();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target?.action === "grant"
                ? "Grant referral discount?"
                : "Revoke referral grant?"}
            </DialogTitle>
            <DialogDescription>
              {target
                ? `${target.referredClientName} for ${target.referrerName}, effective ${formatDay(target.effectiveFrom)}.`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {modalError && <FormAlert>{modalError}</FormAlert>}

          {target && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
                  <p className="label-caps">Reviewed scheduled fee</p>
                  <p className="mt-1 text-[18px] font-semibold text-[var(--text-primary)]">
                    {formatRate(target.currentFeeRate)}
                  </p>
                </div>
                <div className="rounded-xl border border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] p-3">
                  <p className="label-caps">Expected after decision</p>
                  <p className="mt-1 text-[18px] font-semibold text-[var(--accent-gold-strong)]">
                    {formatRate(
                      target.action === "grant"
                        ? Math.max(0, target.currentFeeRate - 0.5)
                        : Math.min(10, target.currentFeeRate + 0.5),
                    )}
                  </p>
                  <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                    Informational; SQL calculates the sealed rate
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="referral-reason">Required audit reason</Label>
                <Textarea
                  id="referral-reason"
                  rows={4}
                  maxLength={1000}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setModalError(null);
                  }}
                  placeholder={
                    target.action === "grant"
                      ? "What was reviewed, and why is this referral being approved?"
                      : "Why should this approved referral stop affecting future invoices?"
                  }
                  disabled={busy}
                />
                <p className="text-right text-[10.5px] text-[var(--text-muted)]">
                  {reason.length}/1000
                </p>
              </div>

              <div className="flex items-start gap-2.5 rounded-xl border border-[var(--warning-orange)]/25 bg-[var(--warning-orange)]/10 p-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                <Clock3
                  className="mt-0.5 size-4 shrink-0 text-[var(--warning-orange)]"
                  aria-hidden
                />
                <p>
                  This appends a sealed commercial snapshot. It affects
                  Monday-to-Sunday invoices from{" "}
                  {formatDay(target.effectiveFrom)} onward and never reprices a
                  past week. Another admin action is required to change it
                  later.
                </p>
              </div>

              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-[var(--border-subtle)] p-3 transition-smooth hover:border-[var(--border-strong)]">
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={(checked) => setConfirmed(checked === true)}
                  className="mt-0.5"
                  aria-label="Confirm manual referral decision"
                />
                <span className="text-[12.5px] leading-relaxed text-[var(--text-primary)]">
                  I reviewed the attribution and evidence and confirm this{" "}
                  {target.action === "grant" ? "grant" : "revocation"} for the
                  stated Monday.
                </span>
              </label>

              <p className="font-mono text-[10px] text-[var(--text-muted)]">
                CAS {shortId(target.expectedTermId)} · decision{" "}
                {shortId(target.decisionId)}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={closeDecision}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={target?.action === "revoke" ? "danger" : "primary"}
              loading={busy}
              disabled={!target || !reason.trim() || !confirmed}
              onClick={submitDecision}
            >
              <BadgePercent />
              {target?.action === "revoke" ? "Seal revocation" : "Seal grant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
