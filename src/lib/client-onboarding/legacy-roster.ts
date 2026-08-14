import "server-only";

import {
  ClientOnboardingError,
  requireClientOnboardingAdmin,
} from "@/lib/client-onboarding/sessions";
import { normalizeShopDomain } from "@/lib/shopify/client";
import { createServiceClient } from "@/lib/supabase/service";
import type {
  AdAccount,
  Client,
  ClientApprovalStatus,
  ClientMember,
  Profile,
} from "@/lib/supabase/types";

const SAFE_CLIENT_COLUMNS =
  "id, full_name, email, discord_handle, approval_status, created_at" as const;
const SAFE_PROFILE_COLUMNS = "id, role" as const;
const SAFE_MEMBER_COLUMNS = "client_id, member_id" as const;
const SAFE_ACCOUNT_COLUMNS =
  "id, client_id, store_name, status, currency, shopify_url, shopify_connected, shopify_scopes, shopify_connected_at, created_at" as const;

type LegacyClientRow = Pick<
  Client,
  | "id"
  | "full_name"
  | "email"
  | "discord_handle"
  | "approval_status"
  | "created_at"
>;
type LegacyProfileRow = Pick<Profile, "id" | "role">;
type LegacyMemberRow = Pick<ClientMember, "client_id" | "member_id">;
type LegacyAccountRow = Pick<
  AdAccount,
  | "id"
  | "client_id"
  | "store_name"
  | "status"
  | "currency"
  | "shopify_url"
  | "shopify_connected"
  | "shopify_scopes"
  | "shopify_connected_at"
  | "created_at"
>;

export type LegacyShopifyAssetDTO = {
  id: string;
  source: "legacy";
  name: string;
  domain: string;
  currency: string;
  grantedScopes: string[];
  connectedAt: string;
};

export type ExistingClientRosterDTO = {
  clientId: string;
  fullName: string;
  email: string;
  discordHandle: string | null;
  approvalStatus: ClientApprovalStatus;
  createdAt: string;
  partnerOf?: string[];
  shopify: LegacyShopifyAssetDTO[];
};

function compareText(left: string, right: string) {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseLegacyScopes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map((scope) => scope.trim()).filter(Boolean))].sort();
}

function connectedAt(account: LegacyAccountRow) {
  return account.shopify_connected_at || account.created_at;
}

function isNewer(candidate: LegacyShopifyAssetDTO, current: LegacyShopifyAssetDTO) {
  const candidateTime = Date.parse(candidate.connectedAt);
  const currentTime = Date.parse(current.connectedAt);
  if (Number.isFinite(candidateTime) && candidateTime !== currentTime) {
    return candidateTime > currentTime;
  }
  if (candidate.connectedAt !== current.connectedAt) {
    return candidate.connectedAt > current.connectedAt;
  }
  return candidate.id > current.id;
}

function projectShopifyAssets(accounts: readonly LegacyAccountRow[]) {
  const byDomain = new Map<string, LegacyShopifyAssetDTO>();

  for (const account of accounts) {
    if (
      account.status !== "active" ||
      account.shopify_connected !== true ||
      typeof account.shopify_url !== "string"
    ) {
      continue;
    }
    const domain = normalizeShopDomain(account.shopify_url);
    if (!domain) continue;

    const asset: LegacyShopifyAssetDTO = {
      id: account.id,
      source: "legacy",
      name: account.store_name.trim() || domain,
      domain,
      currency: account.currency,
      grantedScopes: parseLegacyScopes(account.shopify_scopes),
      connectedAt: connectedAt(account),
    };
    const current = byDomain.get(domain);
    if (!current || isNewer(asset, current)) byDomain.set(domain, asset);
  }

  return [...byDomain.values()].sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.domain, right.domain) ||
      compareText(left.id, right.id),
  );
}

/**
 * Safe, read-only projection of existing portal identities for the new client list.
 * Every call revalidates the viewer before the service role can be constructed.
 */
export async function listExistingClientRoster(): Promise<ExistingClientRosterDTO[]> {
  await requireClientOnboardingAdmin();
  const service = createServiceClient();
  if (!service) {
    throw new ClientOnboardingError(
      "server_not_configured",
      "Client onboarding is not configured on the server.",
      503,
    );
  }

  const [clientsResult, profilesResult, membersResult, accountsResult] =
    await Promise.all([
      service.from("portal_clients").select(SAFE_CLIENT_COLUMNS),
      service.from("profiles").select(SAFE_PROFILE_COLUMNS),
      service.from("client_members").select(SAFE_MEMBER_COLUMNS),
      service.from("ad_accounts").select(SAFE_ACCOUNT_COLUMNS),
    ]);

  if (
    clientsResult.error ||
    profilesResult.error ||
    membersResult.error ||
    accountsResult.error
  ) {
    throw new ClientOnboardingError(
      "database_error",
      "Could not load existing clients.",
      500,
    );
  }

  const clients = (clientsResult.data ?? []) as LegacyClientRow[];
  const profiles = (profilesResult.data ?? []) as LegacyProfileRow[];
  const members = (membersResult.data ?? []) as LegacyMemberRow[];
  const accounts = (accountsResult.data ?? []) as LegacyAccountRow[];
  const adminIds = new Set(
    profiles.filter((profile) => profile.role === "admin").map((profile) => profile.id),
  );
  const memberIds = new Set(members.map((member) => member.member_id));
  const nameById = new Map(clients.map((client) => [client.id, client.full_name]));
  const partnerOf = new Map<string, string[]>();
  for (const member of members) {
    const ownerName = nameById.get(member.client_id);
    if (!ownerName) continue;
    const owners = partnerOf.get(member.member_id) ?? [];
    owners.push(ownerName);
    partnerOf.set(member.member_id, owners);
  }
  const accountsByClient = new Map<string, LegacyAccountRow[]>();
  for (const account of accounts) {
    const owned = accountsByClient.get(account.client_id) ?? [];
    owned.push(account);
    accountsByClient.set(account.client_id, owned);
  }

  return clients
    .filter(
      (client) =>
        client.approval_status !== "rejected" &&
        !adminIds.has(client.id) &&
        (client.approval_status === "pending" ||
          !memberIds.has(client.id) ||
          accountsByClient.has(client.id)),
    )
    .map((client) => ({
      clientId: client.id,
      fullName: client.full_name,
      email: client.email,
      discordHandle: client.discord_handle,
      approvalStatus: client.approval_status,
      createdAt: client.created_at,
      partnerOf: (partnerOf.get(client.id) ?? []).sort(compareText),
      shopify:
        client.approval_status === "approved"
          ? projectShopifyAssets(accountsByClient.get(client.id) ?? [])
          : [],
    }))
    .sort(
      (left, right) =>
        compareText(left.fullName, right.fullName) ||
        compareText(left.email, right.email) ||
        compareText(left.clientId, right.clientId),
    );
}
