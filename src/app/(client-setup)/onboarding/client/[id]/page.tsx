import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ClientOnboardingFlow } from "@/components/onboarding/client-onboarding-flow";
import { isClientOnboardingId } from "@/lib/client-onboarding/invitations";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Complete your client setup",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function ClientOnboardingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isClientOnboardingId(id)) notFound();
  return <ClientOnboardingFlow sessionId={id} />;
}
