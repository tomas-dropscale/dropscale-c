import "server-only";

import {
  exchangeReportingClientCredentials,
  normalizeReportingShopDomain,
  reportingShopifyGraphql,
  verifyReportingShop,
} from "../client-onboarding/shopify";
import { decryptToken } from "../google-ads/crypto";
import type { CanonicalReportingSource } from "./sources";
import {
  fetchCollectionProductKeys,
  fetchDailySales,
  type ShopifyGraphqlExecutor,
} from "../shopify/client";

export type ShopifyReportingAdapterErrorCode =
  | "invalid_source"
  | "credential_decrypt_failed"
  | "identity_mismatch"
  | "currency_mismatch";

export class ShopifyReportingAdapterError extends Error {
  constructor(
    readonly code: ShopifyReportingAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ShopifyReportingAdapterError";
  }
}

export type ShopifyReportingAdapter = {
  fetchDailySales: (
    from: string,
    to: string,
  ) => ReturnType<typeof fetchDailySales>;
  fetchCollectionProductKeys: (
    handle: string,
  ) => ReturnType<typeof fetchCollectionProductKeys>;
};

function invalidSource(): never {
  throw new ShopifyReportingAdapterError(
    "invalid_source",
    "The reporting source is not a canonical Shopify anchor.",
  );
}

function validatedShopifyAnchor(source: CanonicalReportingSource) {
  const shopify = source.shopify;
  const credential = shopify?.credential;
  if (
    !shopify ||
    !credential ||
    source.kind === "google_ads" ||
    source.group.id !== source.bindingId ||
    source.group.shopifyAnchorBindingId !== source.bindingId ||
    source.group.shopifyAnchorAdAccountId !== source.adAccountId ||
    ![
      source.bindingId,
      source.clientId,
      source.adAccountId,
      shopify.connectionId,
      shopify.shopId,
      shopify.shopifyName,
      shopify.domain,
      shopify.currency,
      credential.shopifyClientId,
      credential.clientSecretCiphertext,
    ].every((value) => value.length > 0 && value === value.trim()) ||
    !/^gid:\/\/shopify\/Shop\/\d+$/.test(shopify.shopId)
  ) {
    invalidSource();
  }

  try {
    if (normalizeReportingShopDomain(shopify.domain) !== shopify.domain) {
      invalidSource();
    }
  } catch {
    invalidSource();
  }
  return { shopify, credential };
}

function currency(value: string | null): string {
  if (!value || !/^[A-Z]{3}$/.test(value)) {
    throw new ShopifyReportingAdapterError(
      "currency_mismatch",
      "Shopify returned an invalid store currency.",
    );
  }
  return value;
}

/**
 * Opens one purpose-bound V2 Shopify source. The access token remains inside
 * the returned method closures and is never included in their results.
 */
export async function createShopifyReportingAdapter(
  source: CanonicalReportingSource,
): Promise<ShopifyReportingAdapter> {
  const { shopify, credential } = validatedShopifyAnchor(source);
  const sourceCurrency = currency(shopify.currency);

  let clientSecret: string;
  try {
    clientSecret = (await decryptToken(credential.clientSecretCiphertext)).trim();
  } catch {
    throw new ShopifyReportingAdapterError(
      "credential_decrypt_failed",
      "The stored Shopify reporting credential could not be read.",
    );
  }

  const accessToken = await exchangeReportingClientCredentials({
    shopDomain: shopify.domain,
    clientId: credential.shopifyClientId,
    clientSecret,
  });
  const verified = await verifyReportingShop({
    shopDomain: shopify.domain,
    accessToken,
  });
  if (
    verified.shopId !== shopify.shopId ||
    verified.myshopifyDomain !== shopify.domain
  ) {
    throw new ShopifyReportingAdapterError(
      "identity_mismatch",
      "The Shopify credential no longer matches its reporting source.",
    );
  }
  const verifiedCurrency = currency(verified.currencyCode);
  if (verifiedCurrency !== sourceCurrency) {
    throw new ShopifyReportingAdapterError(
      "currency_mismatch",
      "The Shopify credential no longer matches the store currency.",
    );
  }

  const graphql: ShopifyGraphqlExecutor = (shopDomain, token, query, variables) => {
    if (shopDomain !== shopify.domain || token !== accessToken) invalidSource();
    return reportingShopifyGraphql({
      shopDomain,
      accessToken: token,
      query,
      variables,
    });
  };

  return {
    async fetchDailySales(from, to) {
      const result = await fetchDailySales(
        shopify.domain,
        accessToken,
        from,
        to,
        graphql,
      );
      if (currency(result.currency) !== verifiedCurrency) {
        throw new ShopifyReportingAdapterError(
          "currency_mismatch",
          "Shopify changed the reporting currency for this store.",
        );
      }
      return result;
    },
    fetchCollectionProductKeys(handle) {
      return fetchCollectionProductKeys(
        shopify.domain,
        accessToken,
        handle,
        graphql,
      );
    },
  };
}
