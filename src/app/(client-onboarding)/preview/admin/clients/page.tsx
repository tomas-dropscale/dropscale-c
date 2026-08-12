import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  ClientOnboardingManager,
  type LegacyClientSnapshot,
} from "@/components/admin/client-onboarding-manager";
import { Sidebar } from "@/components/admin/sidebar";
import { BrowserChrome } from "@/components/portal/browser-chrome";
import { PageContainer } from "@/components/ui/page-container";
import type { ClientOnboardingSessionDTO } from "@/lib/client-onboarding/sessions";

export const metadata: Metadata = {
  title: "Admin clients visual preview",
  description: "Public local-only visual preview of the Dropscale client onboarding workspace.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

const PREVIEW_LEGACY_CLIENTS: LegacyClientSnapshot[] = [
  {
    id: "preview-client-northwind",
    fullName: "Northwind Home",
    email: "owner@northwind.example",
    approvalStatus: "approved",
    adAccountRows: 2,
    shopifyConnected: 2,
    googleConnected: 1,
  },
  {
    id: "preview-client-atlas",
    fullName: "Atlas Studio",
    email: "team@atlas.example",
    approvalStatus: "approved",
    adAccountRows: 1,
    shopifyConnected: 1,
    googleConnected: 1,
  },
  {
    id: "preview-client-cedar",
    fullName: "Cedar & Coast",
    email: "hello@cedar.example",
    approvalStatus: "pending",
    adAccountRows: 1,
    shopifyConnected: 1,
    googleConnected: 0,
  },
];

const PREVIEW_SESSIONS: ClientOnboardingSessionDTO[] = [
  {
    id: "6b3ae8d0-7475-4c33-868d-2fa59e96c7d2",
    mode: "new_client",
    requestedAssets: [],
    status: "active",
    rawStatus: "active",
    inviteExpiresAt: null,
    targetClientId: null,
    targetClientName: null,
    claimedUserId: "48f87d57-85d7-4010-a093-a1c06486038d",
    firstName: "Northwind",
    lastName: "Home",
    email: "owner@northwind.example",
    createdAt: "2026-08-10T09:15:00.000Z",
    updatedAt: "2026-08-12T10:30:00.000Z",
    submittedAt: "2026-08-10T09:25:00.000Z",
    reviewedAt: "2026-08-10T10:00:00.000Z",
    activatedAt: "2026-08-10T10:05:00.000Z",
    lastErrorCode: null,
    shopify: [],
    googleAds: [],
    mappings: [],
    needsReview: false,
  },
  {
    id: "af1814df-e3a8-44d6-bdb9-aa7f2ff01a43",
    mode: "reconnect",
    requestedAssets: ["shopify", "google_ads"],
    status: "submitted",
    rawStatus: "submitted",
    inviteExpiresAt: null,
    targetClientId: "1a1a08e0-d87a-45f7-beb7-e1b6c112495a",
    targetClientName: "Atlas Studio",
    claimedUserId: "1a1a08e0-d87a-45f7-beb7-e1b6c112495a",
    firstName: "Atlas",
    lastName: "Studio",
    email: "team@atlas.example",
    createdAt: "2026-08-11T14:00:00.000Z",
    updatedAt: "2026-08-12T09:00:00.000Z",
    submittedAt: "2026-08-12T09:00:00.000Z",
    reviewedAt: null,
    activatedAt: null,
    lastErrorCode: null,
    shopify: [
      {
        id: "a878af94-bd25-429f-a263-df346dba1ac0",
        sessionId: "af1814df-e3a8-44d6-bdb9-aa7f2ff01a43",
        name: "Atlas Studio",
        domain: "atlas-preview.myshopify.com",
        primaryDomain: "atlas.example",
        currency: "EUR",
        grantedScopes: ["read_orders", "read_products"],
        connectedAt: "2026-08-12T08:30:00.000Z",
        lastVerifiedAt: "2026-08-12T08:45:00.000Z",
        lastErrorCode: null,
      },
    ],
    googleAds: [
      {
        id: "7451b6ea-903b-4028-a2d1-a59a5e4dd482",
        sessionId: "af1814df-e3a8-44d6-bdb9-aa7f2ff01a43",
        customerId: "123-456-7890",
        accountName: "Atlas Studio Ads",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        connectedAt: "2026-08-12T08:40:00.000Z",
        lastVerifiedAt: "2026-08-12T08:45:00.000Z",
        lastErrorCode: null,
      },
    ],
    mappings: [
      {
        shopifyConnectionId: "a878af94-bd25-429f-a263-df346dba1ac0",
        googleAdsConnectionId: "7451b6ea-903b-4028-a2d1-a59a5e4dd482",
      },
    ],
    needsReview: true,
  },
];

export default function AdminClientsVisualPreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return (
    <div className="flex h-svh flex-col p-2.5 md:p-5">
      <BrowserChrome
        address="localhost/admin/client-onboarding · visual preview"
        right={
          <span className="rounded-full border border-[var(--warning-orange)]/30 bg-[var(--warning-orange)]/8 px-2.5 py-1 text-[10px] font-semibold tracking-[0.08em] text-[var(--warning-orange)] uppercase">
            Preview
          </span>
        }
      >
        <div className="flex min-h-0 flex-1">
          <aside
            className="pointer-events-none hidden w-[228px] shrink-0 md:block"
            aria-hidden="true"
            inert
          >
            <Sidebar activePath="/admin/client-onboarding" />
          </aside>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <PageContainer
              title="Clients"
              description="Create client-led onboarding links for portal access, Shopify stores and Google Ads accounts."
            >
              <ClientOnboardingManager
                initialSessions={PREVIEW_SESSIONS}
                backendLoadFailed={false}
                legacyClients={PREVIEW_LEGACY_CLIENTS}
                legacyLoadFailed={false}
                readOnlyPreview
              />
            </PageContainer>
          </main>
        </div>
      </BrowserChrome>
    </div>
  );
}
