/**
 * Campaign↔store attribution by destination domain.
 *
 * One Google Ads account may host campaigns for more than one store (a reused
 * account keeps its previous store's campaigns). Spend therefore only counts
 * for a store when the campaign's ad final URLs point at that store's domain.
 *
 * Exclusion requires positive evidence: a campaign whose final URLs all point
 * at a different domain is excluded, but a campaign with no usable final URL
 * stays attributed — never silently drop spend we cannot disprove.
 */

export function normalizeStoreDomain(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  let host = value.trim().toLowerCase();
  if (!host) return null;
  if (host.includes("/") || host.includes("://")) {
    try {
      host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  return host.includes(".") ? host : null;
}

/** Every usable domain alias of a source's Shopify store, normalized. */
export function storeDomainsForSource(source: {
  shopify: { domain: string; primaryDomain: string | null } | null;
}): string[] {
  if (!source.shopify) return [];
  const domains = new Set<string>();
  for (const candidate of [source.shopify.primaryDomain, source.shopify.domain]) {
    const normalized = normalizeStoreDomain(candidate);
    if (normalized) domains.add(normalized);
  }
  return [...domains];
}

function finalUrlHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

/**
 * True when the campaign may be attributed to the store: the store has no
 * verifiable domain, the campaign carries no usable URL evidence, or at least
 * one final URL points at the store's domain (subdomains included).
 */
export function campaignBelongsToStore(
  finalUrls: readonly string[] | undefined,
  storeDomains: readonly string[],
): boolean {
  if (storeDomains.length === 0) return true;
  const hosts: string[] = [];
  for (const url of finalUrls ?? []) {
    const host = finalUrlHost(url);
    if (host) hosts.push(host);
  }
  if (hosts.length === 0) return true;
  return hosts.some((host) =>
    storeDomains.some((domain) => host === domain || host.endsWith(`.${domain}`)),
  );
}
