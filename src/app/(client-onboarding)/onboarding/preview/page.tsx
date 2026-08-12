import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  ClientOnboardingPreview,
  type ClientOnboardingPreviewConfig,
} from "@/components/onboarding/client-onboarding-preview";

export const metadata: Metadata = {
  title: "Client onboarding preview",
  description: "Local-only product preview of the Dropscale client onboarding flow.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

type PreviewPageProps = {
  searchParams: Promise<{
    mode?: string | string[];
    assets?: string | string[];
  }>;
};

export default async function ClientOnboardingPreviewPage({ searchParams }: PreviewPageProps) {
  if (process.env.NODE_ENV !== "development") notFound();

  const params = await searchParams;
  const rawMode = Array.isArray(params.mode) ? params.mode[0] : params.mode;
  const rawAssets = Array.isArray(params.assets) ? params.assets[0] : params.assets;
  const mode =
    rawMode === "reconnect" || rawMode === "assets" ? rawMode : "new";
  const requestedAssets =
    rawAssets === "shopify" || rawAssets === "google" ? rawAssets : "both";
  const config = {
    mode,
    assets: mode === "new" ? "both" : requestedAssets,
  } satisfies ClientOnboardingPreviewConfig;

  return <ClientOnboardingPreview config={config} />;
}
