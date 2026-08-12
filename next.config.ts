import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Required by the Cloudflare/OpenNext build.
   *
   * OpenNext normally flips this on itself, but we run `next build` ourselves
   * (with `--webpack`) and hand it the output via `--skipNextBuild`, so it
   * never gets the chance. Without it there is no `.next/standalone` and the
   * bundler fails looking for `pages-manifest.json`.
   *
   * Harmless for `next dev` and for a plain Node deployment.
   */
  output: "standalone",
  async headers() {
    return [
      {
        source: "/onboarding/client/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
