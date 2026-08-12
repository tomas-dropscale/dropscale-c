import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(() => null),
}));

import {
  createLaraPricingArtifactStore,
  LARA_PRICING_ARTIFACT_LIMITS,
  LaraPricingArtifactStoreError,
  preflightLaraPricingArtifactStore,
  type LaraPricingArtifactRpcClient,
} from "./lara-pricing-artifact-store";
import { LARA_PRICING_SALE_SCHEMA_VERSION } from "./lara-pricing-sale-plan";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import {
  canonicalRemediationJson,
  remediationSha256,
} from "./shopify-remediation-plan";

const RUN_ID = "71000000-0000-4000-8000-000000000001";
const LEASE_TOKEN = "71000000-0000-4000-8000-000000000002";
const PRODUCT_KEY =
  `lara-pricing/${LARA_PRICING_SALE_SCHEMA_VERSION}/${RUN_ID}/products/0000.json`;
const ROOT_KEY =
  `lara-pricing/${LARA_PRICING_SALE_SCHEMA_VERSION}/${RUN_ID}/root.json`;

type Stored = {
  artifact_key: string;
  digest_sha256: string;
  byte_length: number;
  canonical_json: string;
};

function productArtifact(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: LARA_PRICING_SALE_SCHEMA_VERSION,
    kind: "catalogue_product_partition",
    ordinal: 0,
    sourceCatalogueDigestSha256: "a".repeat(64),
    productDigestSha256: "b".repeat(64),
    product: { id: "gid://shopify/Product/1" },
    operation: null,
    ...extra,
  };
}

function rootArtifact() {
  return {
    schemaVersion: LARA_PRICING_SALE_SCHEMA_VERSION,
    kind: "persisted_plan_root",
    shop: {
      domain: LARA_AUDIT_CONNECTION.shopDomain,
      shopId: LARA_AUDIT_CONNECTION.shopId,
    },
    vendorPolicy: {
      decision: "merchant_accepted_non_issue",
      mutationsAllowed: false,
    },
    productPartitions: [],
    operations: [],
  };
}

async function inputFor(key: string, value: unknown) {
  const canonical = canonicalRemediationJson(value);
  return {
    key,
    value,
    digestSha256: await remediationSha256(value),
    byteLength: new TextEncoder().encode(canonical).byteLength,
  };
}

function memoryRpcClient(options?: {
  transformPutRow?: (row: Stored) => Stored;
  transformGetRow?: (row: Stored) => Stored;
  putError?: unknown;
  getError?: unknown;
  putThrows?: boolean;
  getThrows?: boolean;
}): LaraPricingArtifactRpcClient & {
  calls: Array<{ name: string; args: Readonly<Record<string, unknown>> }>;
  values: Map<string, Stored>;
} {
  const calls: Array<{
    name: string;
    args: Readonly<Record<string, unknown>>;
  }> = [];
  const values = new Map<string, Stored>();
  return {
    calls,
    values,
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === "put_audit_shopify_pricing_artifact") {
        if (options?.putThrows) throw new Error("private thrown write detail");
        if (options?.putError) return { data: null, error: options.putError };
        const row: Stored = {
          artifact_key: args.p_artifact_key as string,
          digest_sha256: args.p_digest_sha256 as string,
          byte_length: args.p_byte_length as number,
          canonical_json: args.p_canonical_json as string,
        };
        const existing = values.get(row.artifact_key);
        if (existing && canonicalRemediationJson(existing) !== canonicalRemediationJson(row)) {
          return { data: null, error: { code: "23505" } };
        }
        values.set(row.artifact_key, structuredClone(row));
        return {
          data: [options?.transformPutRow?.(structuredClone(row)) ?? row],
          error: null,
        };
      }
      if (name === "get_audit_shopify_pricing_artifact") {
        if (options?.getThrows) throw new Error("private thrown read detail");
        if (options?.getError) return { data: null, error: options.getError };
        const row = values.get(args.p_artifact_key as string);
        if (!row) return { data: [], error: null };
        return {
          data: [options?.transformGetRow?.(structuredClone(row)) ?? row],
          error: null,
        };
      }
      return { data: null, error: { code: "unexpected_rpc" } };
    },
  };
}

function storeWith(client: LaraPricingArtifactRpcClient) {
  return createLaraPricingArtifactStore({
    runId: RUN_ID,
    leaseToken: LEASE_TOKEN,
    leaseGeneration: 3,
    client,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Lara private pricing artifact store", () => {
  it("requires the exact claimed lease to prove migration readiness before Shopify work", async () => {
    const calls: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];
    const client: LaraPricingArtifactRpcClient = {
      async rpc(name, args) {
        calls.push({ name, args });
        return { data: true, error: null };
      },
    };
    await expect(
      preflightLaraPricingArtifactStore({
        runId: RUN_ID,
        leaseToken: LEASE_TOKEN,
        leaseGeneration: 3,
        client,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        name: "assert_audit_shopify_pricing_artifact_store_ready",
        args: {
          p_run_id: RUN_ID,
          p_connection_id: LARA_AUDIT_CONNECTION.connectionId,
          p_shopify_domain: LARA_AUDIT_CONNECTION.shopDomain,
          p_shopify_shop_id: LARA_AUDIT_CONNECTION.shopId,
          p_lease_token: LEASE_TOKEN,
          p_lease_generation: 3,
        },
      },
    ]);

    await expect(
      preflightLaraPricingArtifactStore({
        runId: RUN_ID,
        leaseToken: LEASE_TOKEN,
        leaseGeneration: 3,
        client: { rpc: vi.fn(async () => ({ data: null, error: { code: "42883" } })) },
      }),
    ).rejects.toMatchObject({ code: "server_not_configured" });
  });

  it("persists only canonical bytes under every exact Lara/run/lease pin", async () => {
    const client = memoryRpcClient();
    const store = storeWith(client);
    const value = productArtifact();
    const input = await inputFor(PRODUCT_KEY, value);

    await store.putImmutableJson(input);
    await expect(store.getImmutableJson(PRODUCT_KEY)).resolves.toEqual(value);

    expect(client.calls.map((call) => call.name)).toEqual([
      "put_audit_shopify_pricing_artifact",
      "get_audit_shopify_pricing_artifact",
      "get_audit_shopify_pricing_artifact",
    ]);
    expect(client.calls[0]?.args).toMatchObject({
      p_run_id: RUN_ID,
      p_connection_id: LARA_AUDIT_CONNECTION.connectionId,
      p_shopify_domain: LARA_AUDIT_CONNECTION.shopDomain,
      p_shopify_shop_id: LARA_AUDIT_CONNECTION.shopId,
      p_lease_token: LEASE_TOKEN,
      p_lease_generation: 3,
      p_artifact_key: PRODUCT_KEY,
      p_digest_sha256: input.digestSha256,
      p_byte_length: input.byteLength,
      p_canonical_json: canonicalRemediationJson(value),
    });
    expect(client.values.get(PRODUCT_KEY)?.canonical_json).toBe(
      canonicalRemediationJson(value),
    );
  });

  it("accepts the pinned root and preserves the vendor/brand non-mutation policy", async () => {
    const client = memoryRpcClient();
    const store = storeWith(client);
    const root = rootArtifact();

    await expect(store.putImmutableJson(await inputFor(ROOT_KEY, root))).resolves.toBe(
      undefined,
    );
    await expect(store.getImmutableJson(ROOT_KEY)).resolves.toMatchObject({
      vendorPolicy: { mutationsAllowed: false },
      shop: {
        domain: LARA_AUDIT_CONNECTION.shopDomain,
        shopId: LARA_AUDIT_CONNECTION.shopId,
      },
    });
    expect(LARA_PRICING_ARTIFACT_LIMITS).toEqual({
      maxProductBytes: 2_097_152,
      maxRootBytes: 4_194_304,
      maxObjectsPerRun: 2_001,
      maxBytesPerRun: 134_217_728,
    });
  });

  it("fails before persistence for a foreign namespace, wrong hash, wrong length or secret-shaped key", async () => {
    const client = memoryRpcClient();
    const store = storeWith(client);
    const value = productArtifact();
    const valid = await inputFor(PRODUCT_KEY, value);

    await expect(
      store.putImmutableJson({
        ...valid,
        key: PRODUCT_KEY.replace(RUN_ID, "72000000-0000-4000-8000-000000000001"),
      }),
    ).rejects.toMatchObject({ code: "invalid_artifact" });
    await expect(
      store.putImmutableJson({ ...valid, digestSha256: "f".repeat(64) }),
    ).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
    await expect(
      store.putImmutableJson({ ...valid, byteLength: valid.byteLength + 1 }),
    ).rejects.toMatchObject({ code: "artifact_byte_length_mismatch" });

    const unsafe = productArtifact({ nested: { accessToken: "must-not-persist" } });
    await expect(
      store.putImmutableJson(await inputFor(PRODUCT_KEY, unsafe)),
    ).rejects.toMatchObject({ code: "invalid_artifact" });
    expect(client.calls).toHaveLength(0);
  });

  it("independently hashes the durable read-after-write bytes and rejects tampering", async () => {
    const client = memoryRpcClient({
      transformGetRow: (row) => ({
        ...row,
        canonical_json: row.canonical_json.replace(
          "catalogue_product_partition",
          "persisted_plan_root",
        ),
      }),
    });
    const store = storeWith(client);

    await expect(
      store.putImmutableJson(await inputFor(PRODUCT_KEY, productArtifact())),
    ).rejects.toMatchObject({ code: "artifact_stored_mismatch" });
  });

  it("does not expose backend errors and fails closed without a service client", async () => {
    const client = memoryRpcClient({
      putError: { message: "private database detail must not escape" },
    });
    const store = storeWith(client);
    const failure = store.putImmutableJson(
      await inputFor(PRODUCT_KEY, productArtifact()),
    );
    await expect(failure).rejects.toMatchObject({ code: "artifact_write_failed" });
    await expect(failure).rejects.not.toThrow(/private database detail/i);

    const thrown = storeWith(memoryRpcClient({ putThrows: true })).putImmutableJson(
      await inputFor(PRODUCT_KEY, productArtifact()),
    );
    await expect(thrown).rejects.toMatchObject({ code: "artifact_write_failed" });
    await expect(thrown).rejects.not.toThrow(/private thrown write detail/i);

    const readClient = memoryRpcClient();
    const readStore = storeWith(readClient);
    await readStore.putImmutableJson(
      await inputFor(PRODUCT_KEY, productArtifact()),
    );
    const readFailureStore = storeWith(memoryRpcClient({ getThrows: true }));
    const readFailure = readFailureStore.getImmutableJson(PRODUCT_KEY);
    await expect(readFailure).rejects.toMatchObject({ code: "artifact_read_failed" });
    await expect(readFailure).rejects.not.toThrow(/private thrown read detail/i);

    expect(() =>
      createLaraPricingArtifactStore({
        runId: RUN_ID,
        leaseToken: LEASE_TOKEN,
        leaseGeneration: 1,
      }),
    ).toThrowError(LaraPricingArtifactStoreError);
    expect(() =>
      createLaraPricingArtifactStore({
        runId: RUN_ID,
        leaseToken: LEASE_TOKEN,
        leaseGeneration: 0,
        client,
      }),
    ).toThrow(/exact run lease pin/i);
  });
});
