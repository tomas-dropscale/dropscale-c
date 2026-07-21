import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n/provider";
import { getLocale } from "@/lib/i18n/server";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Dropscale IO",
    template: "%s · Dropscale IO",
  },
  description: "Dropscale IO platform.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Reading the locale cookie opts every route into dynamic rendering.
  // Acceptable: everything meaningful here is authenticated per-user content,
  // and it avoids a flash of the wrong language on first paint. The portal
  // pages are English-only and simply ignore the provider.
  const locale = await getLocale();

  return (
    <html lang={locale} className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full">
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
