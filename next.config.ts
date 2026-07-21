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
};

export default nextConfig;
