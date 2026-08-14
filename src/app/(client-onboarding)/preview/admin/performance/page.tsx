import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Campaigns & Analytics visual prototype",
  description: "Local mock-data preview for the Dropscale performance workspace.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function PerformanceVisualPreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  redirect("/preview/admin/campaigns");
}
