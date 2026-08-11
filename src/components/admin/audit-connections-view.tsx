"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  Link2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Store,
  Unplug,
} from "lucide-react";

import { FormAlert } from "@/components/auth/auth-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import type { AuditConnectionDTO } from "@/lib/audit/connections";
import { createClient } from "@/lib/supabase/client";

type Invitation = {
  id: string;
  storeLabel?: string;
  url: string;
  expiresAt: string;
};

type Feedback = { tone: "error" | "success"; message: string } | null;

function dateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function StatusBadge({ status }: { status: AuditConnectionDTO["status"] }) {
  if (status === "connected") return <Badge variant="success">Connected</Badge>;
  if (status === "expired") return <Badge variant="warning">Link expired</Badge>;
  if (status === "revoked") return <Badge variant="neutral">Revoked</Badge>;
  return <Badge variant="gold">Waiting for client</Badge>;
}

function setupIssueMessage(connection: AuditConnectionDTO): string {
  if (connection.failedAttempts >= 10) {
    return "This setup link is locked after 10 unsuccessful attempts. Generate a replacement link.";
  }
  if (connection.lastErrorCode === "missing_scopes") {
    return "A previous attempt was blocked by the retired exact-scope rule. The merchant can retry the same link now.";
  }
  if (connection.lastErrorCode === "extra_scopes_not_allowed") {
    return "A previous attempt was blocked by the retired exact-scope rule. The merchant can retry the same link now.";
  }
  if (connection.lastErrorCode === "invalid_credentials") {
    return "Shopify rejected the Client ID or Client Secret in the latest attempt.";
  }
  if (connection.lastErrorCode === "domain_mismatch") {
    return "The latest credentials belonged to a different Shopify store domain.";
  }
  return "The merchant's latest setup attempt could not be completed.";
}

function CountCard({
  label,
  value,
  help,
  icon: Icon,
  tone = "neutral",
}: {
  label: string;
  value: number;
  help: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  tone?: "neutral" | "success" | "warning";
}) {
  const colour =
    tone === "success"
      ? "text-[var(--success-green)]"
      : tone === "warning"
        ? "text-[var(--warning-orange)]"
        : "text-[var(--accent-gold)]";
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="label-caps">{label}</p>
        <Icon className={`size-4 ${colour}`} aria-hidden />
      </div>
      <p className={`mt-2 text-2xl font-semibold tracking-tight ${colour}`}>{value}</p>
      <p className="mt-1 text-[11.5px] text-[var(--text-secondary)]">{help}</p>
    </div>
  );
}

export function AuditConnectionsView({
  connections,
}: {
  connections: AuditConnectionDTO[];
}) {
  const router = useRouter();
  const [addOpen, setAddOpen] = React.useState(false);
  const [storeName, setStoreName] = React.useState("");
  const [invitation, setInvitation] = React.useState<Invitation | null>(null);
  const [feedback, setFeedback] = React.useState<Feedback>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => router.refresh(), 350);
    };

    const supabase = createClient();
    const channel = supabase
      .channel("audit-shopify-connections")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "audit_shopify_connection_events" },
        refresh,
      )
      .subscribe();
    const interval = setInterval(() => router.refresh(), 60_000);

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      clearInterval(interval);
      void supabase.removeChannel(channel);
    };
  }, [router]);

  const counts = React.useMemo(
    () => ({
      connected: connections.filter((item) => item.status === "connected").length,
      waiting: connections.filter((item) => item.status === "waiting").length,
      attention: connections.filter(
        (item) =>
          item.needsReview ||
          item.status === "expired" ||
          (item.status === "waiting" && Boolean(item.lastErrorCode)),
      ).length,
    }),
    [connections],
  );
  const newConnections = connections.filter((item) => item.needsReview);

  function readBody(body: unknown): string {
    return body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? String((body as { error: string }).error)
      : "The action could not be completed.";
  }

  async function createInvitation() {
    setBusy("create");
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/audit/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storeName }),
      });
      const body = (await response.json().catch(() => null)) as {
        invitation?: Invitation;
        error?: string;
      } | null;
      if (!response.ok || !body?.invitation) {
        setFeedback({ tone: "error", message: readBody(body) });
        return;
      }
      setInvitation(body.invitation);
      setCopied(false);
      setStoreName("");
      setFeedback({
        tone: "success",
        message: "Invitation created. Copy it now; the secret part cannot be recovered after closing this dialog.",
      });
      router.refresh();
    } catch {
      setFeedback({ tone: "error", message: "The audit invitation could not be created." });
    } finally {
      setBusy(null);
    }
  }

  async function copyInvitation() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setFeedback({ tone: "error", message: "Could not copy the link. Select it manually." });
    }
  }

  async function replaceInvitation(connection: AuditConnectionDTO) {
    if (
      connection.status === "waiting" &&
      !window.confirm(
        `Replace the active setup link for ${connection.storeLabel}? The previously sent link will stop working immediately.`,
      )
    ) {
      return;
    }
    setBusy(`invite:${connection.id}`);
    setFeedback(null);
    try {
      const response = await fetch(
        `/api/admin/audit/connections/${connection.id}/invite`,
        { method: "POST" },
      );
      const body = (await response.json().catch(() => null)) as {
        invitation?: Invitation;
        error?: string;
      } | null;
      if (!response.ok || !body?.invitation) {
        setFeedback({ tone: "error", message: readBody(body) });
        return;
      }
      setInvitation({ ...body.invitation, storeLabel: connection.storeLabel });
      setCopied(false);
      setAddOpen(true);
      setFeedback({
        tone: "success",
        message: "A new link was generated and the previous link is now invalid.",
      });
      router.refresh();
    } catch {
      setFeedback({ tone: "error", message: "The replacement link could not be generated." });
    } finally {
      setBusy(null);
    }
  }

  async function review(connection: AuditConnectionDTO) {
    setBusy(`review:${connection.id}`);
    setFeedback(null);
    try {
      const response = await fetch(`/api/admin/audit/connections/${connection.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "review" }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setFeedback({ tone: "error", message: readBody(body) });
        return;
      }
      setFeedback({ tone: "success", message: `${connection.storeLabel} marked as reviewed.` });
      router.refresh();
    } catch {
      setFeedback({ tone: "error", message: "The connection could not be reviewed." });
    } finally {
      setBusy(null);
    }
  }

  async function revoke(connection: AuditConnectionDTO) {
    const message =
      connection.status === "connected"
        ? `Disconnect ${connection.storeLabel}? Its stored Shopify Client Secret will be permanently removed.`
        : `Revoke the setup link for ${connection.storeLabel}?`;
    if (!window.confirm(message)) return;

    setBusy(`revoke:${connection.id}`);
    setFeedback(null);
    try {
      const response = await fetch(`/api/admin/audit/connections/${connection.id}`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setFeedback({ tone: "error", message: readBody(body) });
        return;
      }
      setFeedback({ tone: "success", message: `${connection.storeLabel} was revoked.` });
      router.refresh();
    } catch {
      setFeedback({ tone: "error", message: "The connection could not be revoked." });
    } finally {
      setBusy(null);
    }
  }

  function onDialogChange(open: boolean) {
    if (
      !open &&
      invitation &&
      !copied &&
      !window.confirm(
        "This is the only copy of the new setup link. Close it without copying? You will need to generate another link.",
      )
    ) {
      return;
    }
    setAddOpen(open);
    if (!open) {
      setInvitation(null);
      setFeedback(null);
      setCopied(false);
      setStoreName("");
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <CountCard
            label="Connected"
            value={counts.connected}
            help="Verified audit connections"
            icon={ShieldCheck}
            tone="success"
          />
          <CountCard
            label="Waiting"
            value={counts.waiting}
            help="Links awaiting the merchant"
            icon={Clock3}
          />
          <CountCard
            label="Needs attention"
            value={counts.attention}
            help="New connections, failed setup or expired links"
            icon={AlertTriangle}
            tone={counts.attention > 0 ? "warning" : "neutral"}
          />
        </div>
        <div className="flex justify-end">
          <Dialog open={addOpen} onOpenChange={onDialogChange}>
          <DialogTrigger asChild>
            <Button variant="primary">
              <Plus aria-hidden />
              Add store
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{invitation ? "Copy setup link" : "Add store for audit"}</DialogTitle>
              <DialogDescription>
                {invitation
                  ? "Send this one-time link to the merchant. It expires in seven days."
                  : "Use an internal label. The merchant will identify and verify the actual Shopify store."}
              </DialogDescription>
            </DialogHeader>

            {feedback && <FormAlert tone={feedback.tone}>{feedback.message}</FormAlert>}

            {invitation ? (
              <div className="space-y-3">
                {invitation.storeLabel && (
                  <p className="text-[13px] font-medium text-[var(--text-primary)]">
                    {invitation.storeLabel}
                  </p>
                )}
                <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
                  <code className="block break-all text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                    {invitation.url}
                  </code>
                </div>
                <p className="text-[11.5px] text-[var(--text-secondary)]">
                  Expires {dateTime(invitation.expiresAt)}. The secret is not stored in plaintext, so
                  generate a replacement if this link is lost.
                </p>
                <Button type="button" variant="primary" className="w-full" onClick={copyInvitation}>
                  {copied ? <Check aria-hidden /> : <Clipboard aria-hidden />}
                  {copied ? "Copied" : "Copy setup link"}
                </Button>
              </div>
            ) : (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createInvitation();
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="audit-store-name">Store name</Label>
                  <Input
                    id="audit-store-name"
                    value={storeName}
                    onChange={(event) => setStoreName(event.target.value)}
                    placeholder="e.g. Willow & Wren"
                    maxLength={120}
                    autoFocus
                    required
                  />
                </div>
                <DialogFooter>
                  <Button
                    type="submit"
                    variant="primary"
                    loading={busy === "create"}
                    disabled={!storeName.trim()}
                  >
                    Generate link
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
          </Dialog>
        </div>
      </div>

      {newConnections.length > 0 && (
        <div className="rounded-[var(--radius-card)] border border-[var(--success-green)]/25 bg-[var(--success-green)]/8 px-4 py-3">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--success-green)]" aria-hidden />
            <div>
              <p className="text-[13px] font-medium text-[var(--text-primary)]">
                {newConnections.length === 1
                  ? "A Shopify store has just connected"
                  : `${newConnections.length} Shopify stores have connected`}
              </p>
              <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
                Review the verified domain and scopes below, then acknowledge the connection.
              </p>
            </div>
          </div>
        </div>
      )}

      {feedback && !addOpen && <FormAlert tone={feedback.tone}>{feedback.message}</FormAlert>}

      <section aria-labelledby="audit-connections-list">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="label-caps">Stores</p>
            <h2 id="audit-connections-list" className="mt-1 text-[15px] font-semibold text-[var(--text-primary)]">
              Audit connection list
            </h2>
          </div>
          <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
            <RefreshCw className="size-3.5" aria-hidden />
            Live updates
          </span>
        </div>

        {connections.length === 0 ? (
          <div className="panel flex min-h-48 flex-col items-center justify-center p-6 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]">
              <Store className="size-5" aria-hidden />
            </span>
            <p className="mt-3 text-[14px] font-medium text-[var(--text-primary)]">No audit stores yet</p>
            <p className="mt-1 max-w-sm text-[12.5px] text-[var(--text-secondary)]">
              Add a store to create the secure onboarding link you can send to the merchant.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {connections.map((connection) => (
              <article
                key={connection.id}
                className={`panel p-4 sm:p-5 ${
                  connection.needsReview ? "border-[var(--success-green)]/30" : ""
                }`}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                        {connection.storeLabel}
                      </h3>
                      <StatusBadge status={connection.status} />
                      {connection.needsReview && <Badge variant="success">New connection</Badge>}
                      {connection.status === "waiting" && connection.lastErrorCode && (
                        <Badge variant="warning">Setup issue</Badge>
                      )}
                    </div>
                    {connection.shopifyDomain ? (
                      <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
                        <Link2 className="size-3.5 shrink-0" aria-hidden />
                        <span className="truncate">{connection.shopifyDomain}</span>
                        {connection.primaryDomain && (
                          <span className="truncate text-[var(--text-secondary)]">· {connection.primaryDomain}</span>
                        )}
                      </p>
                    ) : (
                      <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
                        Created {dateTime(connection.createdAt)}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {(connection.status === "waiting" || connection.status === "expired") && (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => replaceInvitation(connection)}
                        loading={busy === `invite:${connection.id}`}
                      >
                        <RefreshCw aria-hidden />
                        {connection.status === "waiting" ? "Replace setup link" : "Generate new link"}
                      </Button>
                    )}
                    {connection.needsReview && (
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={() => review(connection)}
                        loading={busy === `review:${connection.id}`}
                      >
                        <Check aria-hidden />
                        Mark reviewed
                      </Button>
                    )}
                    {connection.status !== "revoked" && (
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={() => revoke(connection)}
                        loading={busy === `revoke:${connection.id}`}
                      >
                        <Unplug aria-hidden />
                        Revoke
                      </Button>
                    )}
                  </div>
                </div>

                {connection.status === "connected" && (
                  <div className="mt-4 grid gap-3 border-t border-[var(--border-subtle)] pt-4 sm:grid-cols-3">
                    <div>
                      <p className="label-caps">Verified store</p>
                      <p className="mt-1 text-[12.5px] text-[var(--text-primary)]">
                        {connection.shopifyName ?? connection.storeLabel}
                        {connection.currency ? ` · ${connection.currency}` : ""}
                      </p>
                    </div>
                    <div>
                      <p className="label-caps">Connected</p>
                      <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
                        {dateTime(connection.connectedAt)}
                      </p>
                    </div>
                    <div>
                      <p className="label-caps">Credential</p>
                      <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
                        Encrypted · ends in {connection.credentialHint ?? "—"}
                      </p>
                    </div>
                    <details className="sm:col-span-3">
                      <summary className="cursor-pointer text-[12px] font-medium text-[var(--accent-gold-strong)]">
                        {connection.grantedScopes.length} verified audit scopes
                      </summary>
                      <p className="mt-2 break-words text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                        {connection.grantedScopes.join(", ")}
                      </p>
                    </details>
                  </div>
                )}

                {connection.status === "waiting" && (
                  <div className="mt-4 space-y-1.5 border-t border-[var(--border-subtle)] pt-3 text-[11.5px]">
                    {connection.lastErrorCode && (
                      <p className="text-[var(--warning-orange)]">
                        {setupIssueMessage(connection)}
                      </p>
                    )}
                    <p className="text-[var(--text-secondary)]">
                      Link expires {dateTime(connection.inviteExpiresAt)}. For security, its secret cannot be shown again.
                    </p>
                  </div>
                )}
                {connection.status === "expired" && (
                  <p className="mt-4 border-t border-[var(--border-subtle)] pt-3 text-[11.5px] text-[var(--warning-orange)]">
                    The merchant can no longer use the old link. Generate a new one to continue.
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
