import type { Metadata } from "next";

import { SiteHeader } from "@/components/marketing/site-header";
import { SiteFooter } from "@/components/marketing/site-footer";

/**
 * Public marketing site: landing page + legal pages. Shares the app's design
 * tokens but none of its chrome — no auth, no portal shell.
 */
export const metadata: Metadata = {
  metadataBase: new URL("https://dropscale.app"),
  title: {
    default: "Dropscale IO — Google Ads management agency",
    template: "%s · Dropscale IO",
  },
  description:
    "Specialist Google Ads agency for B2B and e-commerce brands. Campaign management, conversion optimisation and real-time reporting in your own client portal.",
  openGraph: {
    type: "website",
    siteName: "Dropscale IO",
    url: "https://dropscale.app",
    title: "Dropscale IO — Google Ads management agency",
    description:
      "We plan, run and optimise Google Ads for brands that want profitable growth — with live reporting in your own client portal.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Dropscale IO — Google Ads management agency",
    description:
      "Specialist Google Ads agency. Campaign management, conversion optimisation and real-time reporting.",
  },
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-[var(--bg-base)]">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
