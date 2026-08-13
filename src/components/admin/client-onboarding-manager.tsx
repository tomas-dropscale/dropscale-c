"use client";

import * as React from "react";
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Clipboard,
  Clock3,
  Link2,
  Megaphone,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
  Unplug,
  UserPlus,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ClientOnboardingSessionDTO } from "@/lib/client-onboarding/sessions";
import type { ClientOnboardingAsset, ClientOnboardingMode } from "@/lib/supabase/types";

export type LegacyClientSnapshot = {
  id: string;
  fullName: string;
  email: string;
  approvalStatus: "pending" | "approved" | "rejected";
  adAccountRows: number;
  shopifyConnected: number;
  googleConnected: number;
};

type AssetChoice = "account" | "shopify" | "google_ads" | "both";
type DialogMode = "new_client" | "reconnect" | "add_assets";
type SessionAction = "rotate" | "approve" | "revoke";
type ActionTarget = { session: ClientOnboardingSessionDTO; action: SessionAction };
type DisconnectTarget =
  | { kind: "shopify"; id: string; name: string; clientName: string }
  | { kind: "google_ads"; id: string; name: string; clientName: string };

type Invitation = {
  id: string;
  url: string;
  expiresAt: string;
};

type Notice = {
  id: number;
  tone: "success" | "info" | "error";
  title: string;
  message: string;
};

type ClientCard = {
  key: string;
  session: ClientOnboardingSessionDTO;
  sessions: ClientOnboardingSessionDTO[];
  shopify: ClientOnboardingSessionDTO["shopify"];
  googleAds: ClientOnboardingSessionDTO["googleAds"];
};

const SUCCESS_VISIBLE_MS = 4_000;
const SUCCESS_FADE_MS = 300;

function assetsForChoice(choice: AssetChoice): ClientOnboardingAsset[] {
  if (choice === "account") return [];
  if (choice === "shopify") return ["shopify"];
  if (choice === "google_ads") return ["google_ads"];
  return ["shopify", "google_ads"];
}

function assetLabel(assets: readonly ClientOnboardingAsset[]) {
  const shopify = assets.includes("shopify");
  const google = assets.includes("google_ads");
  if (shopify && google) return "Shopify + Google Ads";
  if (shopify) return "Shopify";
  if (google) return "Google Ads";
  return "Account only";
}

function modeLabel(mode: ClientOnboardingMode) {
  if (mode === "new_client") return "New client";
  if (mode === "reconnect") return "Reconnect";
  return "Add assets";
}

function canonicalClientKey(session: ClientOnboardingSessionDTO) {
  return session.claimedUserId ?? session.targetClientId ?? session.id;
}

function sessionRank(session: ClientOnboardingSessionDTO) {
  return new Date(session.updatedAt).getTime();
}

function groupSessions(sessions: ClientOnboardingSessionDTO[]): ClientCard[] {
  const groups = new Map<string, ClientOnboardingSessionDTO[]>();
  for (const session of sessions) {
    const key = canonicalClientKey(session);
    const entries = groups.get(key) ?? [];
    entries.push(session);
    groups.set(key, entries);
  }
  return [...groups.entries()]
    .map(([key, entries]) => {
      const sorted = [...entries].sort((left, right) => sessionRank(right) - sessionRank(left));
      const session = sorted[0];
      const shopify = new Map<string, ClientOnboardingSessionDTO["shopify"][number]>();
      const googleAds = new Map<string, ClientOnboardingSessionDTO["googleAds"][number]>();
      for (const entry of entries) {
        for (const store of entry.shopify) shopify.set(store.id, store);
        for (const account of entry.googleAds) googleAds.set(account.id, account);
      }
      return {
        key,
        session,
        sessions: sorted,
        shopify: [...shopify.values()],
        googleAds: [...googleAds.values()],
      };
    })
    .sort((left, right) => sessionRank(right.session) - sessionRank(left.session));
}

function clientName(session: ClientOnboardingSessionDTO) {
  if (session.targetClientName) return session.targetClientName;
  const identity = [session.firstName, session.lastName].filter(Boolean).join(" ").trim();
  return identity || `Client setup ${session.id.slice(0, 8)}`;
}

function cardClientName(card: ClientCard) {
  const named = card.sessions.find((session) => session.targetClientName)?.targetClientName;
  if (named) return named;
  const identity = card.sessions.find((session) => session.firstName || session.lastName);
  return identity ? clientName(identity) : clientName(card.session);
}

function cardEmail(card: ClientCard) {
  return card.session.email ?? card.sessions.find((session) => session.email)?.email ?? null;
}

function cardHasIssue(card: ClientCard) {
  return Boolean(
    card.sessions.some((session) => session.lastErrorCode) ||
      card.shopify.some((store) => store.lastErrorCode) ||
      card.googleAds.some((account) => account.lastErrorCode),
  );
}

function cardHasStatus(card: ClientCard, statuses: readonly string[]) {
  return card.sessions.some((session) => statuses.includes(session.status));
}

function errorMessage(body: unknown, fallback: string) {
  if (body && typeof body === "object" && "error" in body) {
    const message = (body as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function formatDate(value: string | null) {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusBadge(session: ClientOnboardingSessionDTO) {
  if (session.status === "active") return <Badge variant="success">Active</Badge>;
  if (session.status === "reviewed") return <Badge variant="success">Approved</Badge>;
  if (session.status === "submitted") return <Badge variant="warning">Ready for review</Badge>;
  if (session.status === "expired") return <Badge variant="danger">Link expired</Badge>;
  if (session.status === "collecting") return <Badge variant="gold">In progress</Badge>;
  return <Badge variant="neutral">Waiting for client</Badge>;
}

function CountCard({
  label,
  value,
  help,
  icon: Icon,
  tone = "gold",
}: {
  label: string;
  value: number;
  help: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  tone?: "gold" | "success" | "warning" | "danger";
}) {
  const colour =
    tone === "success"
      ? "text-[var(--success-green)]"
      : tone === "warning"
        ? "text-[var(--warning-orange)]"
        : tone === "danger"
          ? "text-[var(--danger-red)]"
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

function NoticeBanner({ notice, dismiss }: { notice: Notice; dismiss: () => void }) {
  const [visible, setVisible] = React.useState(false);
  const dismissRef = React.useRef(dismiss);
  React.useEffect(() => {
    dismissRef.current = dismiss;
  }, [dismiss]);
  React.useEffect(() => {
    const enter = window.requestAnimationFrame(() => setVisible(true));
    if (notice.tone === "error") return () => window.cancelAnimationFrame(enter);
    const leave = window.setTimeout(() => setVisible(false), SUCCESS_VISIBLE_MS);
    const remove = window.setTimeout(() => dismissRef.current(), SUCCESS_VISIBLE_MS + SUCCESS_FADE_MS);
    return () => {
      window.cancelAnimationFrame(enter);
      window.clearTimeout(leave);
      window.clearTimeout(remove);
    };
  }, [notice.id, notice.tone]);

  const transient = notice.tone !== "error";
  const success = notice.tone === "success";
  return (
    <div className={`transition-opacity duration-300 motion-reduce:transition-none ${visible ? "opacity-100" : "opacity-0"}`}>
      <div
        role={transient ? "status" : "alert"}
        aria-live={transient ? "polite" : "assertive"}
        className={`rounded-[var(--radius-card)] border px-4 py-3 ${
          success
            ? "border-[var(--success-green)]/25 bg-[var(--success-green)]/8"
            : notice.tone === "info"
              ? "border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)]"
              : "border-[var(--danger-red)]/30 bg-[var(--danger-red)]/8"
        }`}
      >
        <div className="flex items-start gap-3">
          {success ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--success-green)]" aria-hidden />
          ) : notice.tone === "info" ? (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-[var(--accent-gold)]" aria-hidden />
          ) : (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-[var(--danger-red)]" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-[var(--text-primary)]">{notice.title}</p>
            <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{notice.message}</p>
          </div>
          {!transient && (
            <button type="button" onClick={dismiss} className="text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function LinkPanel({ url, copied, copy }: { url: string; copied: boolean; copy: () => void }) {
  return (
    <div className="space-y-3">
      <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
        <code className="block break-all text-[11.5px] leading-relaxed text-[var(--text-secondary)]">{url}</code>
      </div>
      <Button type="button" variant="primary" className="w-full" onClick={copy}>
        {copied ? <Check aria-hidden /> : <Clipboard aria-hidden />}
        {copied ? "Copied" : "Copy one-time link"}
      </Button>
    </div>
  );
}

function AssetChoiceField({
  value,
  onChange,
  newClient,
}: {
  value: AssetChoice;
  onChange: (value: AssetChoice) => void;
  newClient: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label id="client-onboarding-asset-choice">
        {newClient ? "Onboarding type" : "Assets requested"}
      </Label>
      <Select value={value} onValueChange={(choice) => onChange(choice as AssetChoice)}>
        <SelectTrigger aria-labelledby="client-onboarding-asset-choice">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {newClient ? (
            <>
              <SelectItem value="account">Dashboard account only — no assets yet</SelectItem>
              <SelectItem value="both">Complete setup — Shopify + Google Ads</SelectItem>
            </>
          ) : (
            <>
              <SelectItem value="shopify">Shopify store</SelectItem>
              <SelectItem value="google_ads">Google Ads account</SelectItem>
              <SelectItem value="both">Shopify + Google Ads</SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      <p className="text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
        {newClient
          ? value === "account"
            ? "Creates dashboard access only. Assets can be requested later from the client card."
            : "The client must connect all Shopify stores and Google Ads accounts they use before submitting."
          : "The client can connect one or more of each requested asset."}
      </p>
    </div>
  );
}

export function ClientOnboardingManager({
  initialSessions,
  backendLoadFailed,
  legacyClients,
  legacyLoadFailed,
  readOnlyPreview = false,
}: {
  initialSessions: ClientOnboardingSessionDTO[];
  backendLoadFailed: boolean;
  legacyClients: LegacyClientSnapshot[];
  legacyLoadFailed: boolean;
  readOnlyPreview?: boolean;
}) {
  const [sessions, setSessions] = React.useState(initialSessions);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = React.useState<string | null>(null);
  const [dialogError, setDialogError] = React.useState("");

  const [createMode, setCreateMode] = React.useState<DialogMode | null>(null);
  const [assetChoice, setAssetChoice] = React.useState<AssetChoice>("both");
  const [selectedLegacyId, setSelectedLegacyId] = React.useState("");
  const [legacySearch, setLegacySearch] = React.useState("");
  const [assetTarget, setAssetTarget] = React.useState<ClientCard | null>(null);
  const [invitation, setInvitation] = React.useState<Invitation | null>(null);
  const [actionTarget, setActionTarget] = React.useState<ActionTarget | null>(null);
  const [revokeCard, setRevokeCard] = React.useState<ClientCard | null>(null);
  const [disconnectTarget, setDisconnectTarget] = React.useState<DisconnectTarget | null>(null);

  const cards = React.useMemo(() => groupSessions(sessions), [sessions]);
  const stagedClientIds = React.useMemo(
    () =>
      new Set(
        sessions.flatMap((session) =>
          [session.claimedUserId, session.targetClientId].filter(
            (id): id is string => Boolean(id),
          ),
        ),
      ),
    [sessions],
  );
  const counts = React.useMemo(
    () => ({
      active: cards.filter((card) => cardHasStatus(card, ["active"])).length,
      onboarding: cards.filter((card) => cardHasStatus(card, ["waiting", "collecting"])).length,
      review: cards.filter((card) => cardHasStatus(card, ["submitted", "reviewed"])).length,
      issues: cards.filter((card) => cardHasStatus(card, ["expired"]) || cardHasIssue(card)).length,
    }),
    [cards],
  );
  const filteredCards = React.useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return cards.filter((card) => {
      if (
        statusFilter === "issues"
          ? !cardHasStatus(card, ["expired"]) && !cardHasIssue(card)
          : statusFilter !== "all" && !cardHasStatus(card, [statusFilter])
      ) {
        return false;
      }
      const haystack = [
        cardClientName(card),
        cardEmail(card) ?? "",
        card.shopify.map((store) => `${store.name} ${store.domain}`).join(" "),
        card.googleAds.map((account) => `${account.accountName} ${account.customerId}`).join(" "),
      ].join(" ").toLocaleLowerCase();
      return !query || haystack.includes(query);
    });
  }, [cards, search, statusFilter]);
  const legacyMatches = React.useMemo(() => {
    const query = legacySearch.trim().toLocaleLowerCase();
    return legacyClients.filter((client) => !query || `${client.fullName} ${client.email}`.toLocaleLowerCase().includes(query));
  }, [legacyClients, legacySearch]);

  function showNotice(tone: Notice["tone"], title: string, message: string) {
    setNotice((current) => ({ id: (current?.id ?? 0) + 1, tone, title, message }));
  }

  async function refreshSessions() {
    if (readOnlyPreview) return;
    const response = await fetch("/api/admin/client-onboarding", { cache: "no-store" });
    const body = await readJson(response);
    if (!response.ok || !body || typeof body !== "object" || !Array.isArray((body as { sessions?: unknown }).sessions)) {
      throw new Error(errorMessage(body, "The client list could not be refreshed."));
    }
    setSessions((body as { sessions: ClientOnboardingSessionDTO[] }).sessions);
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
    } catch {
      setCopiedUrl(null);
      setDialogError("Clipboard access was unavailable. Select and copy the link manually.");
    }
  }

  function openCreate(mode: DialogMode) {
    setCreateMode(mode);
    setAssetChoice(mode === "new_client" ? "account" : "both");
    setSelectedLegacyId("");
    setLegacySearch("");
    setInvitation(null);
    setDialogError("");
    setCopiedUrl(null);
  }

  function closeCreate() {
    setCreateMode(null);
    setAssetTarget(null);
    setInvitation(null);
    setDialogError("");
    setCopiedUrl(null);
  }

  async function createInvitation() {
    if (!createMode || readOnlyPreview) return;
    const targetClientId =
      createMode === "new_client" ? null : createMode === "add_assets" ? assetTarget?.key ?? null : selectedLegacyId || null;
    if (createMode !== "new_client" && !targetClientId) {
      setDialogError("Select an existing client.");
      return;
    }
    const assets = assetsForChoice(assetChoice);
    if (createMode !== "new_client" && assets.length === 0) {
      setDialogError("Choose Shopify, Google Ads or both.");
      return;
    }
    setBusy("create");
    setDialogError("");
    try {
      const mode: ClientOnboardingMode = createMode;
      const response = await fetch("/api/admin/client-onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, requestedAssets: assets, ...(targetClientId ? { targetClientId } : {}) }),
      });
      const body = await readJson(response);
      if (!response.ok || !body || typeof body !== "object" || !(body as { invitation?: Invitation }).invitation) {
        throw new Error(errorMessage(body, "The onboarding invitation could not be created."));
      }
      const nextInvitation = (body as { invitation: Invitation }).invitation;
      setInvitation(nextInvitation);
      await refreshSessions();
      showNotice("success", "Onboarding link created", "The one-time link is ready to send to the client.");
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "The onboarding invitation could not be created.");
    } finally {
      setBusy(null);
    }
  }

  async function patchSession(session: ClientOnboardingSessionDTO, action: SessionAction) {
    if (readOnlyPreview) return;
    setBusy(`${action}:${session.id}`);
    setDialogError("");
    try {
      const requestAction =
        action === "approve"
          ? session.requestedAssets.length === 0
            ? "activate"
            : "review"
          : action;
      const response = await fetch(`/api/admin/client-onboarding/${session.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: requestAction }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(errorMessage(body, `The ${action} action could not be completed.`));
      let nextInvitation: Invitation | null = null;
      if (action === "rotate") {
        nextInvitation =
          body && typeof body === "object"
            ? ((body as { invitation?: Invitation }).invitation ?? null)
            : null;
        if (!nextInvitation) throw new Error("The replacement link was not returned.");
      }
      try {
        await refreshSessions();
      } catch (refreshError) {
        setActionTarget(null);
        if (nextInvitation) setInvitation(nextInvitation);
        showNotice(
          "error",
          "Action saved, but the list is stale",
          refreshError instanceof Error
            ? refreshError.message
            : "Refresh the page before taking another action.",
        );
        return;
      }
      setActionTarget(null);
      if (nextInvitation) setInvitation(nextInvitation);
      const messages: Record<SessionAction, [string, string]> = {
        rotate: ["Link replaced", "The previous onboarding link no longer works. Send only the new one."],
        approve: session.requestedAssets.length
          ? ["Connections approved", "The connected stores and ad accounts are ready for reporting setup."]
          : ["Client activated", "The client can now access their dashboard."],
        revoke: ["Onboarding cancelled", "The onboarding link and any connections added through it have been removed. The client’s dashboard access is unchanged."],
      };
      showNotice("success", ...messages[action]);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "The onboarding action failed.");
    } finally {
      setBusy(null);
    }
  }

  async function testConnections(card: ClientCard) {
    if (readOnlyPreview) return;
    if (card.shopify.length === 0 && card.googleAds.length === 0) {
      const accountOnly = card.sessions.every((session) => session.requestedAssets.length === 0);
      showNotice(
        "info",
        `${cardClientName(card)} has no connected assets`,
        accountOnly
          ? "There are no Shopify or Google Ads connections to test."
          : "The requested Shopify or Google Ads connections have not been added yet.",
      );
      return;
    }
    setBusy(`test:${card.key}`);
    try {
      const requests = [
        ...card.shopify.map(async (store) => {
          const response = await fetch(`/api/admin/client-onboarding/shopify/${store.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "test" }),
          });
          const body = await readJson(response);
          if (!response.ok || !(body as { ok?: boolean } | null)?.ok) throw new Error(errorMessage(body, `${store.name} failed its Shopify reporting test.`));
        }),
        ...card.googleAds.map(async (account) => {
          const response = await fetch(`/api/admin/client-onboarding/google/${account.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "test" }),
          });
          const body = await readJson(response);
          if (!response.ok || !(body as { ok?: boolean } | null)?.ok) throw new Error(errorMessage(body, `${account.accountName} failed its Google Ads test.`));
        }),
      ];
      await Promise.all(requests);
      try {
        await refreshSessions();
      } catch (refreshError) {
        showNotice(
          "error",
          "Connections passed, but the list is stale",
          refreshError instanceof Error
            ? refreshError.message
            : "Refresh the page before taking another action.",
        );
        return;
      }
      showNotice(
        "success",
        `${cardClientName(card)} connections passed`,
        `${card.shopify.length} Shopify store${card.shopify.length === 1 ? "" : "s"} and ${card.googleAds.length} Google Ads account${card.googleAds.length === 1 ? "" : "s"} were checked live.`,
      );
    } catch (error) {
      await refreshSessions().catch(() => undefined);
      showNotice("error", "Connection test failed", error instanceof Error ? error.message : "At least one live connection could not be verified.");
    } finally {
      setBusy(null);
    }
  }

  async function disconnectAsset(target: DisconnectTarget) {
    if (readOnlyPreview) return;
    setBusy(`disconnect:${target.kind}:${target.id}`);
    setDialogError("");
    try {
      const segment = target.kind === "shopify" ? "shopify" : "google";
      const response = await fetch(`/api/admin/client-onboarding/${segment}/${target.id}`, {
        method: "DELETE",
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(errorMessage(body, `${target.name} could not be disconnected.`));
      }
      try {
        await refreshSessions();
      } catch (refreshError) {
        setDisconnectTarget(null);
        setRevokeCard(null);
        showNotice(
          "error",
          `${target.name} was disconnected, but the list is stale`,
          refreshError instanceof Error
            ? refreshError.message
            : "Refresh the page before taking another action.",
        );
        return;
      }
      setDisconnectTarget(null);
      setRevokeCard(null);
      showNotice(
        "success",
        `${target.name} disconnected`,
        target.kind === "shopify"
          ? "The Shopify connection was removed. The client’s dashboard access and other connections are unchanged."
          : "The Google Ads connection was removed from Dropscale. The Windsor and Google authorization remains unchanged, as do the client’s dashboard access and other connections.",
      );
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "The asset could not be disconnected.");
    } finally {
      setBusy(null);
    }
  }

  const selectedActionSession = actionTarget?.session;
  const selectedAction = actionTarget?.action;

  return (
    <div className="space-y-6">
      {readOnlyPreview && (
        <section className="rounded-[var(--radius-card)] border border-[var(--warning-orange)]/30 bg-[var(--warning-orange)]/8 px-4 py-3" aria-label="Read-only preview">
          <p className="text-[13px] font-semibold text-[var(--text-primary)]">Read-only development preview</p>
          <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">Buttons are disabled and no API, database, Shopify, Google Ads, Windsor or billing request will be made.</p>
        </section>
      )}
      {backendLoadFailed && (
        <div role="alert" className="rounded-[var(--radius-card)] border border-[var(--danger-red)]/30 bg-[var(--danger-red)]/8 px-4 py-3 text-[12px] text-[var(--text-secondary)]">
          The client list could not be loaded. Actions are temporarily unavailable.
        </div>
      )}
      {notice && <NoticeBanner key={notice.id} notice={notice} dismiss={() => setNotice(null)} />}

      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <CountCard label="Active clients" value={counts.active} help="Clients with dashboard access" icon={Users} tone="success" />
          <CountCard label="Onboarding" value={counts.onboarding} help="Waiting or in progress" icon={Clock3} />
          <CountCard label="Setup approval" value={counts.review} help="Submitted or approved setups" icon={ShieldCheck} tone="warning" />
          <CountCard label="Needs attention" value={counts.issues} help="Expired links or reported errors" icon={CircleAlert} tone="danger" />
        </div>
        <div className="flex flex-wrap justify-start gap-2">
          <Button type="button" variant="primary" onClick={() => openCreate("new_client")} disabled={readOnlyPreview || backendLoadFailed}>
            <UserPlus aria-hidden /> New client
          </Button>
          <Button type="button" onClick={() => openCreate("reconnect")} disabled={readOnlyPreview || backendLoadFailed || legacyLoadFailed}>
            <RefreshCw aria-hidden /> Reconnect existing
          </Button>
        </div>
      </div>

      <section aria-labelledby="client-onboarding-list" className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="label-caps">Clients</p>
            <h2 id="client-onboarding-list" className="mt-1 text-[15px] font-semibold text-[var(--text-primary)]">Client onboarding</h2>
          </div>
          {cards.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative sm:w-64">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search clients and assets" aria-label="Search clients and assets" className="pl-9" />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="sm:w-48" aria-label="Filter by onboarding status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="waiting">Waiting for client</SelectItem>
                  <SelectItem value="collecting">In progress</SelectItem>
                  <SelectItem value="submitted">Ready for review</SelectItem>
                  <SelectItem value="reviewed">Approved</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="expired">Expired</SelectItem>
                  <SelectItem value="issues">Needs attention</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {cards.length === 0 ? (
          <div className="panel flex min-h-64 flex-col items-center justify-center p-6 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"><Users className="size-5" aria-hidden /></span>
            <p className="mt-3 text-[14px] font-medium text-[var(--text-primary)]">No clients yet</p>
            <p className="mt-1 max-w-lg text-[12.5px] leading-relaxed text-[var(--text-secondary)]">Create an onboarding link for a new client, or reconnect an existing client.</p>
          </div>
        ) : filteredCards.length === 0 ? (
          <div className="panel flex min-h-40 flex-col items-center justify-center p-6 text-center">
            <Search className="size-5 text-[var(--text-muted)]" aria-hidden />
            <p className="mt-2 text-[13px] font-medium text-[var(--text-primary)]">No clients match these filters</p>
            <button type="button" className="mt-2 text-[12px] font-medium text-[var(--accent-gold-strong)] hover:underline" onClick={() => { setSearch(""); setStatusFilter("all"); }}>Clear filters</button>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredCards.map((card) => {
              const session = card.session;
              const noAssets = card.shopify.length === 0 && card.googleAds.length === 0;
              const accountOnly = card.sessions.every(
                (entry) => entry.requestedAssets.length === 0,
              );
              const openSession = card.sessions.find(
                (entry) => entry.rawStatus === "pending" || entry.rawStatus === "collecting",
              );
              const reviewSession = card.sessions.find((entry) =>
                entry.status === "submitted" || entry.status === "reviewed",
              );
              const canCancel = Boolean(openSession);
              const canRotate = Boolean(openSession);
              const canDisconnectAssets = !noAssets;
              const hasOpenSession = card.sessions.some((entry) =>
                entry.rawStatus === "pending" || entry.rawStatus === "collecting",
              );
              const hasActiveWorkspace = cardHasStatus(card, ["active"]);
              const canTargetAssets = Boolean(session.targetClientId || hasActiveWorkspace);
              const disabled = readOnlyPreview || backendLoadFailed;
              return (
                <article key={card.key} className="panel p-4 sm:p-5">
                  <div className="flex flex-col items-start gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">{cardClientName(card)}</h3>
                        {session.mode !== "new_client" && <Badge variant="neutral">{modeLabel(session.mode)}</Badge>}
                        {statusBadge(session)}
                        {hasActiveWorkspace && session.status !== "active" && (
                          <Badge variant="success">Active client</Badge>
                        )}
                        {noAssets && !accountOnly && <Badge variant="neutral">Assets not connected</Badge>}
                        {cardHasIssue(card) && <Badge variant="danger">Connection needs attention</Badge>}
                      </div>
                      <p className="mt-1 break-all text-[12px] text-[var(--text-secondary)]">{cardEmail(card) ?? "Waiting for client details"}</p>
                      <p className="mt-1 text-[11px] text-[var(--text-muted)]">Updated {formatDate(session.updatedAt)}</p>
                    </div>
                    <div className="flex flex-wrap justify-start gap-2">
                      <Button type="button" size="sm" loading={busy === `test:${card.key}`} disabled={disabled} onClick={() => void testConnections(card)}>
                        <CheckCircle2 aria-hidden /> Test connection
                      </Button>
                      <Button type="button" size="sm" disabled={disabled || hasOpenSession || !canTargetAssets} onClick={() => { setAssetTarget(card); setCreateMode("add_assets"); setAssetChoice("both"); setInvitation(null); setDialogError(""); }}>
                        <Plus aria-hidden /> Add assets
                      </Button>
                      {canRotate && openSession && <Button type="button" size="sm" disabled={disabled} onClick={() => setActionTarget({ session: openSession, action: "rotate" })}><RefreshCw aria-hidden /> Rotate link</Button>}
                      {reviewSession && (reviewSession.status === "submitted" || reviewSession.requestedAssets.length === 0) && <Button type="button" size="sm" variant={reviewSession.requestedAssets.length === 0 ? "primary" : "secondary"} disabled={disabled} onClick={() => setActionTarget({ session: reviewSession, action: "approve" })}><ShieldCheck aria-hidden /> {reviewSession.requestedAssets.length === 0 ? "Approve client" : "Approve connections"}</Button>}
                      {canCancel && openSession && <Button type="button" size="sm" variant="danger" disabled={disabled} onClick={() => setActionTarget({ session: openSession, action: "revoke" })}><Unplug aria-hidden /> Cancel onboarding</Button>}
                      {canDisconnectAssets && <Button type="button" size="sm" variant="danger" disabled={disabled} onClick={() => { setRevokeCard(card); setDisconnectTarget(null); setDialogError(""); }}><Unplug aria-hidden /> Revoke asset…</Button>}
                    </div>
                  </div>

                  <div className="mt-4 grid gap-2 md:grid-cols-2">
                    <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
                      <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]"><Store className="size-3.5 text-[var(--accent-gold-strong)]" aria-hidden /> Shopify · {card.shopify.length}</p>
                      <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{card.shopify.length ? card.shopify.map((store) => store.name).join(", ") : "No reporting stores connected"}</p>
                    </div>
                    <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
                      <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]"><Megaphone className="size-3.5 text-[var(--accent-gold-strong)]" aria-hidden /> Google Ads · {card.googleAds.length}</p>
                      <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{card.googleAds.length ? card.googleAds.map((account) => account.accountName).join(", ") : "No ad accounts connected"}</p>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                    {session.requestedAssets.length > 0 && <Badge variant="neutral">{assetLabel(session.requestedAssets)}</Badge>}
                    {session.inviteExpiresAt && <span>Link expires {formatDate(session.inviteExpiresAt)}</span>}
                    {session.lastErrorCode && <Badge variant="danger">{session.lastErrorCode}</Badge>}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <Dialog open={Boolean(createMode)} onOpenChange={(open) => !open && closeCreate()}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{invitation ? "Copy one-time link" : createMode === "new_client" ? "Onboard a new client" : createMode === "reconnect" ? "Reconnect an existing client" : "Add client assets"}</DialogTitle>
            <DialogDescription>
              {invitation ? "This private link is shown once. Copy it now and send it only to the intended client." : createMode === "new_client" ? "The client creates their dashboard account and either finishes without assets or completes Shopify and Google Ads setup." : createMode === "reconnect" ? "Choose the existing client and the connections they need to renew." : `Create a separate asset invitation for ${assetTarget ? cardClientName(assetTarget) : "this client"}.`}
            </DialogDescription>
          </DialogHeader>
          {invitation ? (
            <div className="space-y-3">
              <div className="rounded-[10px] border border-[var(--warning-orange)]/25 bg-[var(--warning-orange)]/8 p-3 text-[12px] text-[var(--text-secondary)]">Expires {formatDate(invitation.expiresAt)}. Generating a replacement invalidates the previous link.</div>
              <LinkPanel url={invitation.url} copied={copiedUrl === invitation.url} copy={() => void copyLink(invitation.url)} />
              {dialogError && <p role="alert" className="text-[12px] text-[var(--danger-red)]">{dialogError}</p>}
            </div>
          ) : (
            <div className="space-y-4">
              {createMode === "reconnect" && (
                legacyLoadFailed ? (
                  <p role="alert" className="rounded-[10px] border border-[var(--danger-red)]/30 bg-[var(--danger-red)]/8 p-3 text-[12px] text-[var(--text-secondary)]">Existing clients could not be loaded. Close and refresh before creating a reconnect link.</p>
                ) : (
                  <>
                    <div className="space-y-1.5"><Label htmlFor="legacy-client-search">Existing client</Label><div className="relative"><Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden /><Input id="legacy-client-search" value={legacySearch} onChange={(event) => setLegacySearch(event.target.value)} placeholder="Search name or email" className="pl-9" /></div></div>
                    <fieldset><legend className="sr-only">Select an existing client</legend><div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                      {legacyMatches.map((client) => {
                        const staged = stagedClientIds.has(client.id);
                        return <label key={client.id} className="block cursor-pointer"><input type="radio" name="legacy-client" className="peer sr-only" value={client.id} checked={selectedLegacyId === client.id} disabled={staged} onChange={() => setSelectedLegacyId(client.id)} /><span className="block rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 peer-checked:border-[var(--accent-gold)]/60 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--accent-gold)]/40 peer-disabled:cursor-not-allowed peer-disabled:opacity-50"><span className="flex justify-between gap-2"><span><span className="block text-[12.5px] font-medium text-[var(--text-primary)]">{client.fullName}</span><span className="block break-all text-[11.5px] text-[var(--text-secondary)]">{client.email}</span></span>{staged && <Badge variant="neutral">Already onboarded</Badge>}</span></span></label>;
                      })}
                    </div></fieldset>
                  </>
                )
              )}
              <AssetChoiceField value={assetChoice} onChange={setAssetChoice} newClient={createMode === "new_client"} />
              {dialogError && <p role="alert" className="text-[12px] text-[var(--danger-red)]">{dialogError}</p>}
              <DialogFooter><Button type="button" variant="primary" loading={busy === "create"} disabled={readOnlyPreview || backendLoadFailed || createMode === "reconnect" && !selectedLegacyId} onClick={() => void createInvitation()}><Link2 aria-hidden /> Generate one-time link</Button></DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(actionTarget)} onOpenChange={(open) => { if (!open) { setActionTarget(null); setDialogError(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selectedAction === "rotate" ? "Replace this onboarding link?" : selectedAction === "approve" ? selectedActionSession?.requestedAssets.length === 0 ? "Approve this client?" : "Approve these connections?" : "Cancel this open onboarding?"}</DialogTitle>
            <DialogDescription>
              {selectedAction === "rotate" ? "The current one-time link will stop working immediately. The replacement link will be shown once." : selectedAction === "approve" ? selectedActionSession?.requestedAssets.length === 0 ? "This confirms the review and gives the client access to their dashboard." : "This approves the connected stores and ad accounts. Billing remains unchanged." : "This removes the open onboarding link and any connections added through it. The client’s dashboard access remains unchanged."}
            </DialogDescription>
          </DialogHeader>
          {selectedActionSession && <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-[12px] text-[var(--text-secondary)]"><strong className="font-medium text-[var(--text-primary)]">{clientName(selectedActionSession)}</strong></div>}
          {dialogError && <p role="alert" className="text-[12px] text-[var(--danger-red)]">{dialogError}</p>}
          <DialogFooter>
            <Button type="button" onClick={() => { setActionTarget(null); setDialogError(""); }}>Cancel</Button>
            {selectedActionSession && selectedAction && <Button type="button" variant={selectedAction === "revoke" ? "danger" : selectedAction === "approve" && selectedActionSession.requestedAssets.length === 0 ? "primary" : "secondary"} loading={busy === `${selectedAction}:${selectedActionSession.id}`} onClick={() => void patchSession(selectedActionSession, selectedAction)}>{selectedAction === "revoke" ? <Unplug aria-hidden /> : selectedAction === "rotate" ? <RefreshCw aria-hidden /> : <Check aria-hidden />}{selectedAction === "rotate" ? "Replace link" : selectedAction === "approve" ? selectedActionSession.requestedAssets.length === 0 ? "Approve client" : "Approve connections" : "Cancel onboarding"}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(revokeCard)} onOpenChange={(open) => { if (!open) { setRevokeCard(null); setDisconnectTarget(null); setDialogError(""); } }}>
        <DialogContent>
          {disconnectTarget ? (
            <>
              <DialogHeader>
                <DialogTitle>Disconnect {disconnectTarget.name}?</DialogTitle>
                <DialogDescription>
                  {disconnectTarget.kind === "shopify"
                    ? "This revokes only this Shopify reporting connection and destroys its stored credential."
                    : "This removes only Dropscale's stored Google Ads connection. It does not unlink the account in Windsor or Google."} The client&apos;s dashboard access, other connections and billing remain unchanged.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-[10px] border border-[var(--danger-red)]/25 bg-[var(--danger-red)]/8 p-3 text-[12px] text-[var(--text-secondary)]">
                <strong className="font-medium text-[var(--text-primary)]">{disconnectTarget.clientName}</strong><br />
                {disconnectTarget.kind === "shopify" ? "Shopify" : "Google Ads"} · {disconnectTarget.name}
              </div>
              {dialogError && <p role="alert" className="text-[12px] text-[var(--danger-red)]">{dialogError}</p>}
              <DialogFooter>
                <Button type="button" onClick={() => { setDisconnectTarget(null); setDialogError(""); }}>Back</Button>
                <Button type="button" variant="danger" loading={busy === `disconnect:${disconnectTarget.kind}:${disconnectTarget.id}`} onClick={() => void disconnectAsset(disconnectTarget)}><Unplug aria-hidden /> Disconnect this asset</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Choose one asset to disconnect</DialogTitle>
                <DialogDescription>Each connection is revoked separately. Choosing an asset below opens a precise confirmation before anything changes.</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                {revokeCard?.shopify.map((store) => (
                  <button key={store.id} type="button" className="flex w-full items-center justify-between gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-left transition-smooth hover:border-[var(--danger-red)]/40" onClick={() => setDisconnectTarget({ kind: "shopify", id: store.id, name: store.name, clientName: cardClientName(revokeCard) })}>
                    <span><span className="block text-[12.5px] font-medium text-[var(--text-primary)]">{store.name}</span><span className="block text-[11px] text-[var(--text-secondary)]">Shopify · {store.domain}</span></span><Unplug className="size-4 shrink-0 text-[var(--danger-red)]" aria-hidden />
                  </button>
                ))}
                {revokeCard?.googleAds.map((account) => (
                  <button key={account.id} type="button" className="flex w-full items-center justify-between gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-left transition-smooth hover:border-[var(--danger-red)]/40" onClick={() => setDisconnectTarget({ kind: "google_ads", id: account.id, name: account.accountName, clientName: cardClientName(revokeCard) })}>
                    <span><span className="block text-[12.5px] font-medium text-[var(--text-primary)]">{account.accountName}</span><span className="block text-[11px] text-[var(--text-secondary)]">Google Ads · {account.customerId}</span></span><Unplug className="size-4 shrink-0 text-[var(--danger-red)]" aria-hidden />
                  </button>
                ))}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(invitation && !createMode)} onOpenChange={(open) => { if (!open) { setInvitation(null); setDialogError(""); setCopiedUrl(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Copy replacement link</DialogTitle><DialogDescription>The previous link is invalid. This private replacement link is shown once.</DialogDescription></DialogHeader>
          {invitation && <LinkPanel url={invitation.url} copied={copiedUrl === invitation.url} copy={() => void copyLink(invitation.url)} />}
          {dialogError && <p role="alert" className="text-[12px] text-[var(--danger-red)]">{dialogError}</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
