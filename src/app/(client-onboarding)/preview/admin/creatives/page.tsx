import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CreativeInboxView } from "@/components/admin/creative-inbox";
import { Sidebar } from "@/components/admin/sidebar";
import { BrowserChrome } from "@/components/portal/browser-chrome";
import { PageContainer } from "@/components/ui/page-container";
import type { CreativeInbox } from "@/lib/admin/creatives";
import type { CreativeSubmissionStatus } from "@/lib/supabase/types";

export const metadata: Metadata = {
  title: "Admin creatives visual preview",
  description: "Local mock-data preview of the Dropscale creative inbox.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

const STATUSES = new Set<string>(["new", "in_use", "rejected"]);

const PREVIEW_INBOX: CreativeInbox = {
  total: 6,
  newCount: 3,
  submitterNames: {
    "11c9e242-6810-4ee2-9578-4950a11f4430": "Marta Lindau",
    "95834ae1-d4e8-4887-b16b-e3eb396e95ae": "Daniel Azevedo",
    "187ca79f-eb45-4706-87e8-a00586bb544e": "Diogo Barbosa",
  },
  clients: [
    {
      clientId: "3994d10d-cb34-4b84-8eb0-504489fd288d",
      clientName: "Northwind Commerce",
      clientEmail: "performance@northwind.example",
      newCount: 2,
      stores: [
        {
          accountId: "91db5dd0-33b8-4c83-a8b4-f885df8e5d65",
          storeName: "Northwind Home",
          submissions: [
            {
              id: "e38877f5-fd26-4e43-8c6e-a911673e9944",
              ad_account_id: "91db5dd0-33b8-4c83-a8b4-f885df8e5d65",
              submitted_by: "11c9e242-6810-4ee2-9578-4950a11f4430",
              title: "Summer Living · Scale creatives",
              url: "https://drive.google.com/drive/folders/example-summer-living",
              collection_url: "https://northwind-home.example/collections/summer-living",
              notes: "Use the UGC hooks first. The product close-ups are in the second folder.",
              status: "new",
              review_notes: null,
              reviewed_at: null,
              reviewed_by: null,
              created_at: "2026-08-13T19:42:00.000Z",
            },
            {
              id: "8700b050-cd47-49bc-a21b-57cb0f801527",
              ad_account_id: "91db5dd0-33b8-4c83-a8b4-f885df8e5d65",
              submitted_by: "11c9e242-6810-4ee2-9578-4950a11f4430",
              title: "Retargeting · Customer reviews",
              url: "https://dropbox.com/scl/fo/example-retargeting",
              collection_url: "https://northwind-home.example/collections/best-sellers",
              notes: "Customer review videos approved for paid social.",
              status: "in_use",
              review_notes: null,
              reviewed_at: "2026-08-13T18:30:00.000Z",
              reviewed_by: "00000000-0000-4000-8000-000000000001",
              created_at: "2026-08-13T16:18:00.000Z",
            },
          ],
        },
        {
          accountId: "35a0dc70-1dc4-430e-92a0-48c29a13d36f",
          storeName: "Northwind Outdoor",
          submissions: [
            {
              id: "e8bc87c8-e2db-4617-a74c-f4a4fd7bf6ef",
              ad_account_id: "35a0dc70-1dc4-430e-92a0-48c29a13d36f",
              submitted_by: "11c9e242-6810-4ee2-9578-4950a11f4430",
              title: "Outdoor Dining · Product videos",
              url: "https://drive.google.com/drive/folders/example-outdoor",
              collection_url: "https://northwind-outdoor.example/pages/outdoor-dining",
              notes: "The collection page is still being updated.",
              status: "new",
              review_notes: null,
              reviewed_at: null,
              reviewed_by: null,
              created_at: "2026-08-12T15:05:00.000Z",
            },
          ],
        },
      ],
    },
    {
      clientId: "ff92ab3f-b4c5-438e-810c-c13964ff56b7",
      clientName: "Atlas Studio",
      clientEmail: "team@atlas.example",
      newCount: 1,
      stores: [
        {
          accountId: "1e080630-bc4d-492b-9a7f-d3449f82adfd",
          storeName: "Atlas Essentials",
          submissions: [
            {
              id: "f2d6d1f1-105d-4a82-99a0-668a053a7127",
              ad_account_id: "1e080630-bc4d-492b-9a7f-d3449f82adfd",
              submitted_by: "95834ae1-d4e8-4887-b16b-e3eb396e95ae",
              title: "Best Sellers · August batch",
              url: "https://drive.google.com/drive/folders/example-atlas-august",
              collection_url: "https://atlas.example/collections/best-sellers",
              notes: "Three square cuts and two vertical edits.",
              status: "new",
              review_notes: null,
              reviewed_at: null,
              reviewed_by: null,
              created_at: "2026-08-12T11:25:00.000Z",
            },
            {
              id: "bf877dd7-f386-4c46-8d87-f2198d2ab330",
              ad_account_id: "1e080630-bc4d-492b-9a7f-d3449f82adfd",
              submitted_by: "95834ae1-d4e8-4887-b16b-e3eb396e95ae",
              title: "Founders Story · First cut",
              url: "https://dropbox.com/scl/fo/example-atlas-founder",
              collection_url: "https://atlas.example/collections/new-arrivals",
              notes: "Long-form founder interview.",
              status: "rejected",
              review_notes: "The audio is clipping. Please upload the clean export.",
              reviewed_at: "2026-08-12T12:10:00.000Z",
              reviewed_by: "00000000-0000-4000-8000-000000000001",
              created_at: "2026-08-11T14:40:00.000Z",
            },
          ],
        },
      ],
    },
    {
      clientId: "b7a1eb79-79fb-46f4-be1a-da65f2b8409d",
      clientName: "Cedar & Coast",
      clientEmail: "hello@cedar.example",
      newCount: 0,
      stores: [
        {
          accountId: "53d45890-8f13-44ae-8442-208734564794",
          storeName: "Cedar & Coast EU",
          submissions: [
            {
              id: "430d25bc-6d89-40e7-9093-d4e80aeac7d2",
              ad_account_id: "53d45890-8f13-44ae-8442-208734564794",
              submitted_by: "187ca79f-eb45-4706-87e8-a00586bb544e",
              title: "Evergreen · Lifestyle pack",
              url: "https://drive.google.com/drive/folders/example-cedar-evergreen",
              collection_url: "https://cedar.example/collections/evergreen",
              notes: null,
              status: "in_use",
              review_notes: null,
              reviewed_at: "2026-08-10T10:30:00.000Z",
              reviewed_by: "00000000-0000-4000-8000-000000000001",
              created_at: "2026-08-10T09:15:00.000Z",
            },
          ],
        },
      ],
    },
  ],
};

export default async function AdminCreativesVisualPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const params = await searchParams;
  const status: CreativeSubmissionStatus | "all" = STATUSES.has(params.status ?? "")
    ? (params.status as CreativeSubmissionStatus)
    : "all";

  return (
    <div className="flex h-svh flex-col p-0 md:p-5">
      <BrowserChrome
        address="localhost/admin/creatives · visual preview"
        right={
          <span className="rounded-full border border-[var(--accent-gold)]/30 bg-[var(--accent-gold-dim)] px-2.5 py-1 text-[10px] font-semibold tracking-[0.08em] text-[var(--accent-gold-strong)] uppercase">
            Mock data
          </span>
        }
      >
        <div className="flex min-h-0 flex-1">
          <aside
            className="pointer-events-none hidden w-[228px] shrink-0 md:block"
            aria-hidden="true"
            inert
          >
            <Sidebar activePath="/admin/creatives" />
          </aside>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <PageContainer
              title="Creatives"
              description="Client submissions ready to review and move into campaigns."
            >
              <CreativeInboxView
                inbox={PREVIEW_INBOX}
                status={status}
                adminId="00000000-0000-4000-8000-000000000001"
                basePath="/preview/admin/creatives"
                readOnlyPreview
              />
            </PageContainer>
          </main>
        </div>
      </BrowserChrome>
    </div>
  );
}
