import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * OpenNext adapter config.
 *
 * Left at defaults on purpose: this app has no ISR or fetch caching to wire up
 * — every dashboard route is `force-dynamic` because it renders per-user,
 * authenticated content. If a cacheable public page is ever added, plug an
 * incremental cache in here.
 */
export default defineCloudflareConfig();
