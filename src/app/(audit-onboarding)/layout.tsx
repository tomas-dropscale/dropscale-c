import type { Metadata } from "next";

import { Logo } from "@/components/brand/logo";

export const metadata: Metadata = {
  title: "Connect Shopify for audit",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function AuditOnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-svh bg-[var(--bg-base)] px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-6 flex items-center justify-between gap-4 px-1">
          <Logo />
          <span className="label-caps">Secure store connection</span>
        </div>
        {children}
      </div>
    </main>
  );
}
