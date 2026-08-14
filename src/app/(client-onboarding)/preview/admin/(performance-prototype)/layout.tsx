import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Campaigns & Analytics visual prototype",
  description: "Local mock-data preview for the Dropscale performance workspace.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function PerformancePrototypeLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  if (process.env.NODE_ENV !== "development") notFound();
  return children;
}
