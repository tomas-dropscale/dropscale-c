"use client";

import * as React from "react";
import {
  Archive,
  Check,
  CheckCircle2,
  CircleAlert,
  Clipboard,
  Clock3,
  Link2,
  Mail,
  Megaphone,
  Pencil,
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
import {
  actionableReviewSession,
  assetConnectionKey,
  availableOnboardingAssetKinds,
  buildClientCards,
  cardUpdatedAt,
  clientCardStatus,
  connectionTestTargets,
  onboardingAssetLabel,
  onboardingSessionPurpose,
  openReconnectForAsset,
  openOnboardingSessions,
  runAssetConnectionTests,
  type AssetConnectionTestTarget,
  type ClientCard,
  type ClientCardStatus,
  type OnboardingAssetKind,
} from "@/components/admin/client-onboarding-card-model";
import type { ExistingClientRosterDTO } from "@/lib/client-onboarding/legacy-roster";
import type { ClientOnboardingSessionDTO } from "@/lib/client-onboarding/sessions";
import type { ClientOnboardingAsset, ClientOnboardingMode } from "@/lib/supabase/types";

type AssetChoice = "account" | "shopify" | "google_ads" | "both";
type DialogMode = "new_client" | "reconnect" | "add_assets";
type SessionAction = "rotate" | "approve" | "revoke";
type ActionTarget = { session: ClientOnboardingSessionDTO; action: SessionAction };
type DisconnectTarget =
  | {
      kind: "shopify";
      source: "legacy" | "onboarding";
      id: string;
      name: string;
      clientName: string;
    }
  | { kind: "google_ads"; id: string; name: string; clientName: string };
type ReconnectTarget = {
  source: "legacy" | "onboarding";
  id: string;
  name: string;
  domain: string;
};
type ClientManagementTarget = {
  clientId: string;
  name: string;
  email: string;
  discordHandle: string;
};
type ClientIdentityDraft = Pick<
  ClientManagementTarget,
  "name" | "email" | "discordHandle"
>;
type AssetConnectionState = {
  status: "testing" | "connected" | "failed";
  message?: string;
};

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

type ConnectionResponse = {
  ok?: unknown;
  health?: { ok?: unknown; code?: unknown };
};

const SUCCESS_VISIBLE_MS = 4_000;
const SUCCESS_FADE_MS = 300;

function assetsForChoice(choice: AssetChoice): ClientOnboardingAsset[] {
  if (choice === "account") return [];
  if (choice === "shopify") return ["shopify"];
  if (choice === "google_ads") return ["google_ads"];
  return ["shopify", "google_ads"];
}

function choiceForAvailableAssets(
  assets: readonly OnboardingAssetKind[],
): AssetChoice {
  return assets.length === 2 ? "both" : assets[0] ?? "both";
}

function approvalLabel(session: ClientOnboardingSessionDTO) {
  return session.requestedAssets.length
    ? `Approve ${onboardingAssetLabel(session.requestedAssets)}`
    : "Approve client";
}

function clientName(session: ClientOnboardingSessionDTO) {
  if (session.targetClientName) return session.targetClientName;
  const identity = [session.firstName, session.lastName].filter(Boolean).join(" ").trim();
  return identity || `Client setup ${session.id.slice(0, 8)}`;
}

function cardClientName(card: ClientCard) {
  if (card.roster?.fullName) return card.roster.fullName;
  const named = card.sessions.find((session) => session.targetClientName)?.targetClientName;
  if (named) return named;
  const identity = card.sessions.find((session) => session.firstName || session.lastName);
  return identity ? clientName(identity) : card.session ? clientName(card.session) : "Client";
}

function cardEmail(card: ClientCard) {
  return (
    card.roster?.email ??
    card.session?.email ??
    card.sessions.find((session) => session.email)?.email ??
    null
  );
}

function cardDiscordHandle(card: ClientCard) {
  const roster = card.roster as
    | (ExistingClientRosterDTO & { discordHandle?: unknown })
    | null;
  if (typeof roster?.discordHandle === "string") return roster.discordHandle;
  return (
    card.session?.discordHandle ??
    card.sessions.find((session) => session.discordHandle)?.discordHandle ??
    ""
  );
}

function clientManagementTarget(card: ClientCard): ClientManagementTarget | null {
  if (!card.clientId || !card.roster) return null;
  return {
    clientId: card.clientId,
    name: cardClientName(card),
    email: cardEmail(card) ?? "",
    discordHandle: cardDiscordHandle(card),
  };
}

function cardHasIssue(card: ClientCard) {
  return Boolean(
    card.sessions.some((session) => session.lastErrorCode) ||
      card.shopify.some(
        (store) => store.source === "onboarding" && Boolean(store.lastErrorCode),
      ) ||
      card.googleAds.some((account) => account.lastErrorCode),
  );
}

function cardIsActive(card: ClientCard) {
  return card.roster?.approvalStatus === "approved" || cardHasStatus(card, ["active"]);
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

function connectionFailureMessage(
  body: unknown,
  target: AssetConnectionTestTarget,
) {
  if (
    target.kind === "google_ads" &&
    body &&
    typeof body === "object" &&
    "health" in body &&
    (body as { health?: { code?: unknown } }).health?.code === "not_connected"
  ) {
    return "This Google Ads account is no longer connected.";
  }
  return errorMessage(
    body,
    target.kind === "shopify"
      ? `${target.name} failed its Shopify reporting test.`
      : `${target.name} failed its Google Ads test.`,
  );
}

function connectionPassed(body: unknown) {
  if (!body || typeof body !== "object") return false;
  const response = body as ConnectionResponse;
  if (response.ok === true) return true;
  return response.health?.ok === true;
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

function linkStatusBadge(session: ClientOnboardingSessionDTO) {
  if (session.status === "expired") return <Badge variant="danger">Link expired</Badge>;
  if (session.status === "collecting") return <Badge variant="gold">In progress</Badge>;
  return <Badge variant="neutral">Waiting for client</Badge>;
}

function clientStatusBadge(status: ClientCardStatus) {
  if (status === "approved") return <Badge variant="success">Approved</Badge>;
  if (status === "waiting_for_approval") {
    return <Badge variant="warning">Waiting for approval</Badge>;
  }
  if (status === "waiting_for_assets") {
    return <Badge variant="gold">Waiting for assets</Badge>;
  }
  return <Badge variant="neutral">No assets</Badge>;
}

function ConnectionStatus({ state }: { state: AssetConnectionState }) {
  const testing = state.status === "testing";
  const connected = state.status === "connected";
  return (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
        testing
          ? "text-[var(--accent-gold-strong)]"
          : connected
            ? "text-[var(--success-green)]"
            : "text-[var(--danger-red)]"
      }`}
    >
      {testing ? (
        <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : connected ? (
        <CheckCircle2 className="size-3.5" aria-hidden />
      ) : (
        <CircleAlert className="size-3.5" aria-hidden />
      )}
      {testing ? "Testing…" : connected ? "Connected" : "Failed"}
    </span>
  );
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
  availableAssets = ["shopify", "google_ads"],
}: {
  value: AssetChoice;
  onChange: (value: AssetChoice) => void;
  newClient: boolean;
  availableAssets?: readonly OnboardingAssetKind[];
}) {
  const shopifyAvailable = availableAssets.includes("shopify");
  const googleAvailable = availableAssets.includes("google_ads");
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
              <SelectItem value="account">Account Only</SelectItem>
              <SelectItem value="shopify">Account &amp; Shopify</SelectItem>
              <SelectItem value="both">
                Complete Setup - Account, Shopify &amp; Google
              </SelectItem>
            </>
          ) : (
            <>
              {shopifyAvailable && (
                <SelectItem value="shopify">Shopify</SelectItem>
              )}
              {googleAvailable && (
                <SelectItem value="google_ads">Google Ads</SelectItem>
              )}
              {shopifyAvailable && googleAvailable && (
                <SelectItem value="both">Shopify & Google Ads</SelectItem>
              )}
            </>
          )}
        </SelectContent>
      </Select>
      <p className="text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
        {newClient
          ? value === "account"
            ? "Creates dashboard access only. Shopify and Google Ads can be added later."
            : value === "shopify"
              ? "The client can connect one or more Shopify stores."
              : "The client can connect one or more Shopify stores and Google Ads accounts."
          : availableAssets.length === 1
            ? `${onboardingAssetLabel(availableAssets)} is the only asset type without an open link.`
            : "The client can connect one or more of each requested asset."}
      </p>
    </div>
  );
}

export function ClientOnboardingManager({
  initialSessions,
  initialRoster,
  backendLoadFailed,
  rosterLoadFailed,
  readOnlyPreview = false,
}: {
  initialSessions: ClientOnboardingSessionDTO[];
  initialRoster: ExistingClientRosterDTO[];
  backendLoadFailed: boolean;
  rosterLoadFailed: boolean;
  readOnlyPreview?: boolean;
}) {
  const [sessions, setSessions] = React.useState(initialSessions);
  const [roster, setRoster] = React.useState(initialRoster);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [connectionStates, setConnectionStates] = React.useState<
    Record<string, AssetConnectionState>
  >({});
  const [copiedUrl, setCopiedUrl] = React.useState<string | null>(null);
  const [dialogError, setDialogError] = React.useState("");

  const [createMode, setCreateMode] = React.useState<DialogMode | null>(null);
  const [assetChoice, setAssetChoice] = React.useState<AssetChoice>("both");
  const [assetTarget, setAssetTarget] = React.useState<ClientCard | null>(null);
  const [reconnectTarget, setReconnectTarget] = React.useState<ReconnectTarget | null>(null);
  const [invitation, setInvitation] = React.useState<Invitation | null>(null);
  const [actionTarget, setActionTarget] = React.useState<ActionTarget | null>(null);
  const [disconnectTarget, setDisconnectTarget] = React.useState<DisconnectTarget | null>(null);
  const [editTarget, setEditTarget] = React.useState<ClientManagementTarget | null>(null);
  const [editDraft, setEditDraft] = React.useState<ClientIdentityDraft>({
    name: "",
    email: "",
    discordHandle: "",
  });
  const [passwordResetSent, setPasswordResetSent] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<ClientManagementTarget | null>(null);
  const editDialogBusy = Boolean(
    editTarget &&
      (busy === `edit-client:${editTarget.clientId}` ||
        busy === `password-reset:${editTarget.clientId}`),
  );

  const cards = React.useMemo(() => buildClientCards(sessions, roster), [sessions, roster]);
  const hasVisibleIssue = React.useCallback(
    (card: ClientCard) =>
      cardHasIssue(card) ||
      connectionTestTargets(card).some(
        (target) => connectionStates[target.key]?.status === "failed",
      ),
    [connectionStates],
  );
  const counts = React.useMemo(
    () => ({
      approved: cards.filter((card) => clientCardStatus(card) === "approved").length,
      review: cards.filter(
        (card) => clientCardStatus(card) === "waiting_for_approval",
      ).length,
      onboarding: cards.filter(
        (card) => clientCardStatus(card) === "waiting_for_assets",
      ).length,
      noAssets: cards.filter((card) => clientCardStatus(card) === "no_assets").length,
      issues: cards.filter(
        (card) => cardHasStatus(card, ["expired"]) || hasVisibleIssue(card),
      ).length,
    }),
    [cards, hasVisibleIssue],
  );
  const filteredCards = React.useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return cards.filter((card) => {
      if (statusFilter !== "all" && clientCardStatus(card) !== statusFilter) {
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

  function showNotice(tone: Notice["tone"], title: string, message: string) {
    setNotice((current) => ({ id: (current?.id ?? 0) + 1, tone, title, message }));
  }

  async function refreshClients() {
    if (readOnlyPreview) return;
    const response = await fetch("/api/admin/client-onboarding", { cache: "no-store" });
    const body = await readJson(response);
    if (
      !response.ok ||
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { sessions?: unknown }).sessions) ||
      !Array.isArray((body as { roster?: unknown }).roster)
    ) {
      throw new Error(errorMessage(body, "The client list could not be refreshed."));
    }
    const refreshed = body as {
      sessions: ClientOnboardingSessionDTO[];
      roster: ExistingClientRosterDTO[];
    };
    setSessions(refreshed.sessions);
    setRoster(refreshed.roster);
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
    setAssetTarget(null);
    setReconnectTarget(null);
    setCreateMode(mode);
    setAssetChoice(mode === "new_client" ? "account" : "both");
    setInvitation(null);
    setDialogError("");
    setCopiedUrl(null);
  }

  function closeCreate() {
    setCreateMode(null);
    setAssetTarget(null);
    setReconnectTarget(null);
    setInvitation(null);
    setDialogError("");
    setCopiedUrl(null);
  }

  async function createInvitation() {
    if (!createMode || readOnlyPreview) return;
    const targetClientId =
      createMode === "new_client"
        ? null
        : assetTarget?.clientId || null;
    if (createMode !== "new_client" && !targetClientId) {
      setDialogError("Select an existing client.");
      return;
    }
    if (createMode === "reconnect" && !reconnectTarget) {
      setDialogError("Choose the Shopify store to reconnect.");
      return;
    }
    const assets =
      createMode === "reconnect" ? (["shopify"] as const) : assetsForChoice(assetChoice);
    if (createMode !== "new_client" && assets.length === 0) {
      setDialogError("Choose Shopify, Google Ads or both.");
      return;
    }
    if (
      createMode === "add_assets" &&
      assetTarget &&
      assets.some(
        (asset) => !availableOnboardingAssetKinds(assetTarget.sessions).includes(asset),
      )
    ) {
      setDialogError("Choose only asset types that do not already have an open link.");
      return;
    }
    setBusy("create");
    setDialogError("");
    try {
      const mode: ClientOnboardingMode = createMode;
      const response = await fetch("/api/admin/client-onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createMode === "reconnect" && reconnectTarget
            ? {
                mode,
                requestedAssets: assets,
                targetShopify: {
                  source: reconnectTarget.source,
                  id: reconnectTarget.id,
                },
              }
            : {
                mode,
                requestedAssets: assets,
                ...(targetClientId ? { targetClientId } : {}),
              },
        ),
      });
      const body = await readJson(response);
      if (!response.ok || !body || typeof body !== "object" || !(body as { invitation?: Invitation }).invitation) {
        throw new Error(errorMessage(body, "The onboarding invitation could not be created."));
      }
      const nextInvitation = (body as { invitation: Invitation }).invitation;
      setInvitation(nextInvitation);
      await refreshClients();
      showNotice("success", "Onboarding link created", "The one-time link is ready to send to the client.");
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "The onboarding invitation could not be created.");
    } finally {
      setBusy(null);
    }
  }

  async function patchSession(session: ClientOnboardingSessionDTO, action: SessionAction) {
    if (readOnlyPreview) return;
    const purpose = onboardingSessionPurpose(session);
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
        await refreshClients();
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
        rotate: [
          "Link replaced",
          `The previous link for ${purpose} no longer works. Send only the new one; other open links are unchanged.`,
        ],
        approve: session.requestedAssets.length
          ? ["Connections approved", "The connected stores and ad accounts are ready for reporting setup."]
          : ["Client activated", "The client can now access their dashboard."],
        revoke: [
          "Link cancelled",
          `The link for ${purpose} and any connections added through it have been removed. Other open links and the client’s dashboard access are unchanged.`,
        ],
      };
      showNotice("success", ...messages[action]);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "The onboarding action failed.");
    } finally {
      setBusy(null);
    }
  }

  async function testConnectionTargets(
    card: ClientCard,
    targets: readonly AssetConnectionTestTarget[],
  ) {
    if (readOnlyPreview || targets.length === 0) return;
    setConnectionStates((current) => {
      const next = { ...current };
      for (const target of targets) next[target.key] = { status: "testing" };
      return next;
    });

    const results = await runAssetConnectionTests(
      targets,
      async (target) => {
        const response = await fetch(target.endpoint, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "test" }),
        });
        const body = await readJson(response);
        if (!response.ok || !connectionPassed(body)) {
          return {
            status: "failed" as const,
            message: connectionFailureMessage(body, target),
          };
        }
        return { status: "connected" as const };
      },
      (result) => {
        setConnectionStates((current) => ({
          ...current,
          [result.key]: {
            status: result.status,
            ...(result.message ? { message: result.message } : {}),
          },
        }));
      },
    );

    await refreshClients().catch(() => undefined);
    const failed = results.filter((result) => result.status === "failed");
    if (failed.length > 0) {
      showNotice(
        "info",
        "Connection test complete",
        `${failed.length} of ${results.length} connection${results.length === 1 ? "" : "s"} failed. See the result beside each asset.`,
      );
      return;
    }
    showNotice(
      "success",
      targets.length === 1 ? "Connection verified" : `${cardClientName(card)} connections verified`,
      targets.length === 1
        ? `${targets[0].name} is connected.`
        : `All ${targets.length} connections passed their live test.`,
    );
  }

  async function testConnections(card: ClientCard) {
    const targets = connectionTestTargets(card);
    if (targets.length === 0) {
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
    await testConnectionTargets(card, targets);
  }

  async function disconnectAsset(target: DisconnectTarget) {
    if (readOnlyPreview) return;
    setBusy(`disconnect:${target.kind}:${target.id}`);
    setDialogError("");
    try {
      const segment =
        target.kind === "google_ads"
          ? "google"
          : target.source === "legacy"
            ? "legacy-shopify"
            : "shopify";
      const response = await fetch(`/api/admin/client-onboarding/${segment}/${target.id}`, {
        method: "DELETE",
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(errorMessage(body, `${target.name} could not be disconnected.`));
      }
      try {
        await refreshClients();
      } catch (refreshError) {
        setDisconnectTarget(null);
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
      const key =
        target.kind === "shopify"
          ? assetConnectionKey("shopify", target.source, target.id)
          : assetConnectionKey("google_ads", "onboarding", target.id);
      setConnectionStates((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      showNotice(
        "success",
        `${target.name} removed`,
        target.kind === "shopify"
          ? "The Shopify connection was removed. The client, other connections, billing and history are unchanged."
          : "The Google Ads connection was removed from Dropscale. The Windsor and Google authorization remains unchanged, as do the client’s dashboard access and other connections.",
      );
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "The asset could not be disconnected.");
    } finally {
      setBusy(null);
    }
  }

  function openEditClient(card: ClientCard) {
    const target = clientManagementTarget(card);
    if (!target) return;
    setEditTarget(target);
    setEditDraft({
      name: target.name,
      email: target.email,
      discordHandle: target.discordHandle,
    });
    setPasswordResetSent(false);
    setDialogError("");
  }

  function closeEditClient() {
    setEditTarget(null);
    setPasswordResetSent(false);
    setDialogError("");
  }

  async function sendClientPasswordReset() {
    if (!editTarget || readOnlyPreview) return;

    const persistedEmail = editTarget.email.trim().toLowerCase();
    const draftEmail = editDraft.email.trim().toLowerCase();
    if (draftEmail !== persistedEmail) {
      setDialogError("Save the new email before sending a reset link.");
      return;
    }

    const busyKey = `password-reset:${editTarget.clientId}`;
    setBusy(busyKey);
    setDialogError("");
    setPasswordResetSent(false);
    try {
      const response = await fetch(
        `/api/admin/client-onboarding/client/${encodeURIComponent(editTarget.clientId)}`,
        { method: "POST" },
      );
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(errorMessage(body, "The password reset email could not be sent."));
      }
      setPasswordResetSent(true);
    } catch (error) {
      setDialogError(
        error instanceof Error
          ? error.message
          : "The password reset email could not be sent.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function updateClientIdentity(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editTarget || readOnlyPreview) return;

    const fullName = editDraft.name.trim();
    const email = editDraft.email.trim();
    const discordHandle = editDraft.discordHandle.trim();
    if (!fullName || !email) {
      setDialogError("Name and email are required.");
      return;
    }

    const busyKey = `edit-client:${editTarget.clientId}`;
    setBusy(busyKey);
    setDialogError("");
    try {
      const response = await fetch(
        `/api/admin/client-onboarding/client/${encodeURIComponent(editTarget.clientId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fullName,
            email,
            discordHandle: discordHandle || null,
          }),
        },
      );
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(errorMessage(body, "The client details could not be updated."));
      }
      try {
        await refreshClients();
      } catch (refreshError) {
        setEditTarget(null);
        showNotice(
          "error",
          "Client updated, but the list is stale",
          refreshError instanceof Error
            ? refreshError.message
            : "Refresh the page before taking another action.",
        );
        return;
      }
      setEditTarget(null);
      showNotice(
        "success",
        "Client details updated",
        `Account details for ${fullName} are up to date.`,
      );
    } catch (error) {
      setDialogError(
        error instanceof Error
          ? error.message
          : "The client details could not be updated.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function removeClient(target: ClientManagementTarget) {
    if (readOnlyPreview) return;
    const busyKey = `remove-client:${target.clientId}`;
    setBusy(busyKey);
    setDialogError("");
    try {
      const response = await fetch(
        `/api/admin/client-onboarding/client/${encodeURIComponent(target.clientId)}`,
        { method: "DELETE" },
      );
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(errorMessage(body, "The client could not be removed."));
      }
      try {
        await refreshClients();
      } catch (refreshError) {
        setRemoveTarget(null);
        showNotice(
          "error",
          "Client removed, but the list is stale",
          refreshError instanceof Error
            ? refreshError.message
            : "Refresh the page before taking another action.",
        );
        return;
      }
      setRemoveTarget(null);
      showNotice(
        "success",
        "Client removed",
        `${target.name} was archived. Connections, billing and history were preserved.`,
      );
    } catch (error) {
      setDialogError(
        error instanceof Error ? error.message : "The client could not be removed.",
      );
    } finally {
      setBusy(null);
    }
  }

  const selectedActionSession = actionTarget?.session;
  const selectedAction = actionTarget?.action;
  const selectedActionPurpose = selectedActionSession
    ? onboardingSessionPurpose(selectedActionSession)
    : "this onboarding";
  const assetTargetAvailableAssets = assetTarget
    ? availableOnboardingAssetKinds(assetTarget.sessions)
    : [];

  return (
    <div className="space-y-6">
      {readOnlyPreview && (
        <section className="rounded-[var(--radius-card)] border border-[var(--warning-orange)]/30 bg-[var(--warning-orange)]/8 px-4 py-3" aria-label="Read-only preview">
          <p className="text-[13px] font-semibold text-[var(--text-primary)]">Read-only development preview</p>
          <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">Buttons are disabled and no API, database, Shopify, Google Ads, Windsor or billing request will be made.</p>
        </section>
      )}
      {(backendLoadFailed || rosterLoadFailed) && (
        <div role="alert" className="rounded-[var(--radius-card)] border border-[var(--danger-red)]/30 bg-[var(--danger-red)]/8 px-4 py-3 text-[12px] text-[var(--text-secondary)]">
          The client list could not be loaded. Actions are temporarily unavailable.
        </div>
      )}
      {notice && <NoticeBanner key={notice.id} notice={notice} dismiss={() => setNotice(null)} />}

      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <CountCard label="Approved" value={counts.approved} help="Client setup approved" icon={CheckCircle2} tone="success" />
          <CountCard label="In review" value={counts.review} help="Waiting for your approval" icon={ShieldCheck} tone="warning" />
          <CountCard label="Onboarding" value={counts.onboarding} help="Waiting for client assets" icon={Clock3} />
          <CountCard label="No assets" value={counts.noAssets} help="No stores or ad accounts connected" icon={Unplug} />
          <CountCard label="Needs attention" value={counts.issues} help="Expired links or reported errors" icon={CircleAlert} tone="danger" />
        </div>
        <div className="flex flex-wrap justify-start gap-2">
          <Button type="button" variant="primary" onClick={() => openCreate("new_client")} disabled={readOnlyPreview || backendLoadFailed}>
            <UserPlus aria-hidden /> New client
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
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="waiting_for_approval">Waiting for approval</SelectItem>
                  <SelectItem value="waiting_for_assets">Waiting for assets</SelectItem>
                  <SelectItem value="no_assets">No assets</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {cards.length === 0 ? (
          <div className="panel flex min-h-64 flex-col items-center justify-center p-6 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"><Users className="size-5" aria-hidden /></span>
            <p className="mt-3 text-[14px] font-medium text-[var(--text-primary)]">No clients yet</p>
            <p className="mt-1 max-w-lg text-[12.5px] leading-relaxed text-[var(--text-secondary)]">Create an onboarding link for a new client.</p>
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
              const status = clientCardStatus(card);
              const openSessions = openOnboardingSessions(card.sessions);
              const availableAssets = availableOnboardingAssetKinds(card.sessions);
              const reviewSession = actionableReviewSession(card.sessions);
              const hasActiveWorkspace = cardIsActive(card);
              const canTargetAssets = Boolean(card.clientId && hasActiveWorkspace);
              const disabled = readOnlyPreview || backendLoadFailed || rosterLoadFailed;
              const testTargets = connectionTestTargets(card);
              const targetsByKey = new Map(testTargets.map((target) => [target.key, target]));
              const testingAll = testTargets.some(
                (target) => connectionStates[target.key]?.status === "testing",
              );
              return (
                <article key={card.key} className="panel p-4 sm:p-5">
                  <div className="flex flex-col items-start gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">{cardClientName(card)}</h3>
                        {clientStatusBadge(status)}
                        {hasVisibleIssue(card) && <Badge variant="danger">Connection needs attention</Badge>}
                      </div>
                      <p className="mt-1 break-all text-[12px] text-[var(--text-secondary)]">{cardEmail(card) ?? "Waiting for client details"}</p>
                      <p className="mt-1 text-[11px] text-[var(--text-muted)]">Updated {formatDate(cardUpdatedAt(card))}</p>
                    </div>
                    <div className="flex flex-wrap justify-start gap-2">
                      <Button type="button" size="sm" loading={testingAll} disabled={disabled} onClick={() => void testConnections(card)}>
                        <CheckCircle2 aria-hidden /> Test all connections
                      </Button>
                      <Button type="button" size="sm" disabled={disabled || availableAssets.length === 0 || !canTargetAssets} onClick={() => { setAssetTarget(card); setReconnectTarget(null); setCreateMode("add_assets"); setAssetChoice(choiceForAvailableAssets(availableAssets)); setInvitation(null); setDialogError(""); }}>
                        <Plus aria-hidden /> Add assets
                      </Button>
                      {reviewSession && <Button type="button" size="sm" variant={reviewSession.requestedAssets.length === 0 ? "primary" : "secondary"} disabled={disabled} onClick={() => setActionTarget({ session: reviewSession, action: "approve" })}><ShieldCheck aria-hidden /> {approvalLabel(reviewSession)}</Button>}
                      {card.clientId && card.roster && (
                        <>
                          <Button type="button" size="sm" disabled={disabled} onClick={() => openEditClient(card)}>
                            <Pencil aria-hidden /> Edit client
                          </Button>
                          <Button type="button" size="sm" variant="danger" disabled={disabled} onClick={() => setRemoveTarget(clientManagementTarget(card))}>
                            <Archive aria-hidden /> Remove client
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {openSessions.length > 0 && (
                    <section className="mt-4 overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)]" aria-label="Open onboarding links">
                      <div className="border-b border-[var(--border-subtle)] px-3 py-2.5">
                        <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]"><Link2 className="size-3.5 text-[var(--accent-gold-strong)]" aria-hidden /> Open links</p>
                      </div>
                      <ul>
                        {openSessions.map((openSession) => {
                          const purpose = onboardingSessionPurpose(openSession);
                          return (
                            <li key={openSession.id} className="flex flex-col gap-3 border-t border-[var(--border-subtle)] px-3 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-[12.5px] font-medium text-[var(--text-primary)]">{purpose}</p>
                                  {linkStatusBadge(openSession)}
                                </div>
                                <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                                  {openSession.reconnectTarget?.domain && <><span className="break-all">{openSession.reconnectTarget.domain}</span><span aria-hidden> · </span></>}
                                  {openSession.inviteExpiresAt ? `Expires ${formatDate(openSession.inviteExpiresAt)}` : "Expiry unavailable"}
                                </p>
                              </div>
                              <div className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:shrink-0">
                                <Button type="button" size="sm" disabled={disabled} aria-label={`Replace ${purpose} link`} onClick={() => setActionTarget({ session: openSession, action: "rotate" })}><RefreshCw aria-hidden /> Replace link</Button>
                                <Button type="button" size="sm" variant="danger" disabled={disabled} aria-label={`Cancel ${purpose} link`} onClick={() => setActionTarget({ session: openSession, action: "revoke" })}><Unplug aria-hidden /> Cancel link</Button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  )}

                  <div className="mt-4 grid gap-3 xl:grid-cols-2">
                    <section className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3" aria-label="Shopify connections">
                      <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]"><Store className="size-3.5 text-[var(--accent-gold-strong)]" aria-hidden /> Shopify · {card.shopify.length}</p>
                      {card.shopify.length ? (
                        <ul className="mt-3">
                          {card.shopify.map((store) => {
                            const key = assetConnectionKey("shopify", store.source, store.id);
                            const target = targetsByKey.get(key);
                            const exactReconnectOpen = Boolean(
                              openReconnectForAsset(card.sessions, store),
                            );
                            const state = connectionStates[key] ?? {
                              status:
                                store.source === "onboarding" && store.lastErrorCode
                                  ? "failed" as const
                                  : "connected" as const,
                              ...(store.source === "onboarding" && store.lastErrorCode
                                ? { message: "The last connection test failed. Test again for details." }
                                : {}),
                            };
                            return (
                              <li key={key} aria-busy={state.status === "testing"} className="flex flex-col gap-3 border-t border-[var(--border-subtle)] py-3 first:border-t-0 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                  <p className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">{store.name}</p>
                                  <p className="mt-0.5 break-all text-[11px] text-[var(--text-secondary)]">{store.domain}</p>
                                  {state.status === "failed" && state.message && <p className="mt-2 text-[11px] leading-relaxed text-[var(--danger-red)]">{state.message}</p>}
                                </div>
                                <div className="shrink-0 space-y-2 sm:text-right">
                                  <ConnectionStatus state={state} />
                                  <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto sm:justify-end">
                                    <Button type="button" size="sm" loading={state.status === "testing"} disabled={disabled || !target} aria-label={`Test ${store.name} Shopify connection`} onClick={() => target && void testConnectionTargets(card, [target])}>Test</Button>
                                    <Button type="button" size="sm" disabled={disabled || exactReconnectOpen || !canTargetAssets} aria-label={`Reconnect ${store.name} Shopify connection`} onClick={() => { setAssetTarget(card); setReconnectTarget({ source: store.source, id: store.id, name: store.name, domain: store.domain }); setCreateMode("reconnect"); setAssetChoice("shopify"); setInvitation(null); setDialogError(""); }}>Reconnect</Button>
                                    <Button type="button" size="sm" variant="danger" disabled={disabled || exactReconnectOpen} title={exactReconnectOpen ? "Cancel the open reconnect link before removing this store." : undefined} aria-label={exactReconnectOpen ? `Remove ${store.name} Shopify connection unavailable while reconnecting` : `Remove ${store.name} Shopify connection`} onClick={() => { setDisconnectTarget({ kind: "shopify", source: store.source, id: store.id, name: store.name, clientName: cardClientName(card) }); setDialogError(""); }}>Remove</Button>
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <p className="mt-2 text-[11px] text-[var(--text-secondary)]">No reporting stores connected</p>
                      )}
                    </section>
                    <section className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3" aria-label="Google Ads connections">
                      <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]"><Megaphone className="size-3.5 text-[var(--accent-gold-strong)]" aria-hidden /> Google Ads · {card.googleAds.length}</p>
                      {card.googleAds.length ? (
                        <ul className="mt-3">
                          {card.googleAds.map((account) => {
                            const key = assetConnectionKey("google_ads", "onboarding", account.id);
                            const target = targetsByKey.get(key);
                            const state = connectionStates[key] ?? {
                              status: account.lastErrorCode ? "failed" as const : "connected" as const,
                              ...(account.lastErrorCode
                                ? { message: "The last connection test failed. Test again for details." }
                                : {}),
                            };
                            return (
                              <li key={key} aria-busy={state.status === "testing"} className="flex flex-col gap-3 border-t border-[var(--border-subtle)] py-3 first:border-t-0 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                  <p className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">{account.accountName}</p>
                                  <p className="mt-0.5 break-all text-[11px] text-[var(--text-secondary)]">{account.customerId}</p>
                                  {state.status === "failed" && state.message && <p className="mt-2 text-[11px] leading-relaxed text-[var(--danger-red)]">{state.message}</p>}
                                </div>
                                <div className="shrink-0 space-y-2 sm:text-right">
                                  <ConnectionStatus state={state} />
                                  <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:justify-end">
                                    <Button type="button" size="sm" loading={state.status === "testing"} disabled={disabled || !target} aria-label={`Test ${account.accountName} Google Ads connection`} onClick={() => target && void testConnectionTargets(card, [target])}>Test</Button>
                                    <Button type="button" size="sm" variant="danger" disabled={disabled} aria-label={`Remove ${account.accountName} Google Ads connection`} onClick={() => { setDisconnectTarget({ kind: "google_ads", id: account.id, name: account.accountName, clientName: cardClientName(card) }); setDialogError(""); }}>Remove</Button>
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <p className="mt-2 text-[11px] text-[var(--text-secondary)]">No ad accounts connected</p>
                      )}
                    </section>
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
            <DialogTitle>{invitation ? "Copy one-time link" : createMode === "new_client" ? "Onboard a new client" : createMode === "reconnect" ? "Reconnect Shopify" : "Add client assets"}</DialogTitle>
            <DialogDescription>
              {invitation ? "This private link is shown once. Copy it now and send it only to the intended client." : createMode === "new_client" ? "Create the client account on its own, with one or more Shopify stores, or with Shopify & Google Ads." : createMode === "reconnect" ? `Create a secure link for ${assetTarget ? cardClientName(assetTarget) : "this client"} to replace one specific Shopify connection.` : `Create a separate asset invitation for ${assetTarget ? cardClientName(assetTarget) : "this client"}.`}
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
              {createMode === "reconnect" && reconnectTarget ? (
                <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
                  <p className="text-[12.5px] font-medium text-[var(--text-primary)]">{reconnectTarget.name}</p>
                  <p className="mt-1 break-all text-[11px] text-[var(--text-secondary)]">{reconnectTarget.domain}</p>
                  <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">The link can reconnect only this store. It cannot be used to add a different Shopify store.</p>
                </div>
              ) : (
                <AssetChoiceField
                  value={assetChoice}
                  onChange={setAssetChoice}
                  newClient={createMode === "new_client"}
                  availableAssets={
                    createMode === "add_assets"
                      ? assetTargetAvailableAssets
                      : undefined
                  }
                />
              )}
              {dialogError && <p role="alert" className="text-[12px] text-[var(--danger-red)]">{dialogError}</p>}
              <DialogFooter><Button type="button" variant="primary" loading={busy === "create"} disabled={readOnlyPreview || backendLoadFailed || rosterLoadFailed || createMode === "reconnect" && !reconnectTarget || createMode === "add_assets" && assetTargetAvailableAssets.length === 0} onClick={() => void createInvitation()}><Link2 aria-hidden /> Generate one-time link</Button></DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(actionTarget)} onOpenChange={(open) => { if (!open) { setActionTarget(null); setDialogError(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selectedAction === "rotate" ? "Replace this open link?" : selectedAction === "approve" ? selectedActionSession ? `${approvalLabel(selectedActionSession)}?` : "Approve this setup?" : "Cancel this open link?"}</DialogTitle>
            <DialogDescription>
              {selectedAction === "rotate" ? `Only this link (${selectedActionPurpose}) will stop working immediately. The replacement will be shown once; other open links and client access are unchanged.` : selectedAction === "approve" ? selectedActionSession?.requestedAssets.length === 0 ? "This confirms the review and gives the client access to their dashboard." : "This approves the connected stores and ad accounts. Billing remains unchanged." : `Only this link (${selectedActionPurpose}) and connections added through it will be removed. Other open links and the client’s dashboard access are unchanged.`}
            </DialogDescription>
          </DialogHeader>
          {selectedActionSession && <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-[12px] text-[var(--text-secondary)]"><strong className="font-medium text-[var(--text-primary)]">{clientName(selectedActionSession)}</strong>{selectedAction !== "approve" && <><br />{selectedActionPurpose}{selectedActionSession.reconnectTarget?.domain && <><br /><span className="break-all">{selectedActionSession.reconnectTarget.domain}</span></>}</>}</div>}
          {dialogError && <p role="alert" className="text-[12px] text-[var(--danger-red)]">{dialogError}</p>}
          <DialogFooter>
            <Button type="button" onClick={() => { setActionTarget(null); setDialogError(""); }}>Cancel</Button>
            {selectedActionSession && selectedAction && <Button type="button" variant={selectedAction === "revoke" ? "danger" : selectedAction === "approve" && selectedActionSession.requestedAssets.length === 0 ? "primary" : "secondary"} loading={busy === `${selectedAction}:${selectedActionSession.id}`} onClick={() => void patchSession(selectedActionSession, selectedAction)}>{selectedAction === "revoke" ? <Unplug aria-hidden /> : selectedAction === "rotate" ? <RefreshCw aria-hidden /> : <Check aria-hidden />}{selectedAction === "rotate" ? "Replace link" : selectedAction === "approve" ? approvalLabel(selectedActionSession) : "Cancel link"}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(disconnectTarget)} onOpenChange={(open) => { if (!open) { setDisconnectTarget(null); setDialogError(""); } }}>
        <DialogContent>
          {disconnectTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Remove {disconnectTarget.name}?</DialogTitle>
                <DialogDescription>
                  {disconnectTarget.kind === "google_ads"
                    ? "This removes only Dropscale's stored Google Ads connection. It does not unlink the account in Windsor or Google."
                    : disconnectTarget.source === "legacy"
                      ? "This disconnects Shopify from this existing asset and removes its stored credential."
                      : "This removes this Shopify reporting connection and destroys its stored credential."} The client, other connections, billing and history remain unchanged.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-[10px] border border-[var(--danger-red)]/25 bg-[var(--danger-red)]/8 p-3 text-[12px] text-[var(--text-secondary)]">
                <strong className="font-medium text-[var(--text-primary)]">{disconnectTarget.clientName}</strong><br />
                {disconnectTarget.kind === "shopify" ? "Shopify" : "Google Ads"} · {disconnectTarget.name}
              </div>
              {dialogError && <p role="alert" className="text-[12px] text-[var(--danger-red)]">{dialogError}</p>}
              <DialogFooter>
                <Button type="button" onClick={() => { setDisconnectTarget(null); setDialogError(""); }}>Cancel</Button>
                <Button type="button" variant="danger" loading={busy === `disconnect:${disconnectTarget.kind}:${disconnectTarget.id}`} onClick={() => void disconnectAsset(disconnectTarget)}><Unplug aria-hidden /> Remove asset</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editTarget)}
        onOpenChange={(open) => {
          if (!open && !editDialogBusy) closeEditClient();
        }}
      >
        <DialogContent showClose={!editDialogBusy}>
          <DialogHeader>
            <DialogTitle>Edit client</DialogTitle>
            <DialogDescription>
              Update the client&apos;s account details. Connections, billing and history are unchanged.
            </DialogDescription>
          </DialogHeader>
          {editTarget && (
            <form className="space-y-4" onSubmit={updateClientIdentity}>
              <div className="space-y-2">
                <Label htmlFor="edit-client-name">Name</Label>
                <Input
                  id="edit-client-name"
                  autoFocus
                  required
                  value={editDraft.name}
                  onChange={(event) =>
                    setEditDraft((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-client-email">Email</Label>
                <Input
                  id="edit-client-email"
                  type="email"
                  required
                  value={editDraft.email}
                  onChange={(event) => {
                    setEditDraft((current) => ({ ...current, email: event.target.value }));
                    setPasswordResetSent(false);
                  }}
                />
                <div className="space-y-1.5 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    aria-describedby="password-reset-help"
                    loading={busy === `password-reset:${editTarget.clientId}`}
                    disabled={
                      Boolean(busy) ||
                      readOnlyPreview ||
                      editDraft.email.trim().toLowerCase() !==
                        editTarget.email.trim().toLowerCase()
                    }
                    onClick={() => void sendClientPasswordReset()}
                  >
                    <Mail aria-hidden /> Send password reset email
                  </Button>
                  <p
                    id="password-reset-help"
                    className="text-[11px] leading-relaxed text-[var(--text-muted)]"
                  >
                    {editDraft.email.trim().toLowerCase() !==
                    editTarget.email.trim().toLowerCase()
                      ? "Save the new email before sending a reset link."
                      : "Sends a secure reset link to the client’s current login email. The password is not changed until the client uses it."}
                  </p>
                  {passwordResetSent && (
                    <p
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                      className="text-[12px] text-[var(--success-green)]"
                    >
                      Password reset email sent.
                    </p>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-client-discord">Discord handle (optional)</Label>
                <Input
                  id="edit-client-discord"
                  placeholder="@username"
                  value={editDraft.discordHandle}
                  onChange={(event) =>
                    setEditDraft((current) => ({
                      ...current,
                      discordHandle: event.target.value,
                    }))
                  }
                />
              </div>
              {dialogError && <p role="alert" className="text-[12px] text-[var(--danger-red)]">{dialogError}</p>}
              <DialogFooter>
                <Button type="button" disabled={Boolean(busy)} onClick={closeEditClient}>Cancel</Button>
                <Button
                  type="submit"
                  variant="primary"
                  loading={busy === `edit-client:${editTarget.clientId}`}
                  disabled={Boolean(busy)}
                >
                  <Check aria-hidden /> Save changes
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => { if (!open) { setRemoveTarget(null); setDialogError(""); } }}>
        <DialogContent>
          {removeTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Remove {removeTarget.name} from Clients?</DialogTitle>
                <DialogDescription>
                  This archives the client, removes them from this list and revokes their portal and onboarding access.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                Shopify and Google Ads connections, billing and account history are preserved.
              </div>
              {dialogError && <p role="alert" className="text-[12px] text-[var(--danger-red)]">{dialogError}</p>}
              <DialogFooter>
                <Button type="button" onClick={() => { setRemoveTarget(null); setDialogError(""); }}>Cancel</Button>
                <Button
                  type="button"
                  variant="danger"
                  loading={busy === `remove-client:${removeTarget.clientId}`}
                  onClick={() => void removeClient(removeTarget)}
                >
                  <Archive aria-hidden /> Remove client
                </Button>
              </DialogFooter>
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
