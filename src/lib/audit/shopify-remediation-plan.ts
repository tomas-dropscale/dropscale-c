import "server-only";

import { z } from "zod";

/**
 * Immutable, store-pinned plan primitives for a future Lara Rovinj repair
 * executor.
 *
 * This module deliberately contains no Shopify client, mutation document,
 * database adapter or persistence. A plan can only describe the three
 * low-risk write families listed in the allowlist below. The companion
 * executor can currently prepare a dry run; it cannot perform a live write.
 */

export const LARA_ROVINJ_REMEDIATION_SHOP = Object.freeze({
  domain: "jwmtjg-fm.myshopify.com",
  shopId: "gid://shopify/Shop/95462097276",
} as const);

export const SHOPIFY_REMEDIATION_PLAN_SCHEMA_VERSION =
  "shopify-remediation-plan.v1" as const;

export const SHOPIFY_REMEDIATION_OPERATION_ALLOWLIST = Object.freeze([
  "page.replace_body",
  "policy.replace_body",
  "theme.replace_exact_text",
] as const);

export type ShopifyRemediationOperationKind =
  (typeof SHOPIFY_REMEDIATION_OPERATION_ALLOWLIST)[number];

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

const SHA256 = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^[a-z0-9][a-z0-9._-]{2,79}$/;
const PLAN_ID = /^[a-z0-9][a-z0-9._-]{2,95}$/;
const PAGE_GID = /^gid:\/\/shopify\/Page\/[1-9][0-9]*$/;
const POLICY_GID = /^gid:\/\/shopify\/ShopPolicy\/[1-9][0-9]*$/;
const THEME_GID = /^gid:\/\/shopify\/OnlineStoreTheme\/[1-9][0-9]*$/;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const THEME_FILE =
  /^(?:blocks|config|layout|locales|sections|snippets|templates)\/[A-Za-z0-9_./-]+\.(?:json|json\.liquid|liquid)$/;
const ACTIVE_HTML =
  /<\s*(?:script|iframe|object|embed|form|input|button)\b|\bon[a-z]+\s*=|javascript\s*:|data\s*:\s*text\/html/iu;

const digestSchema = z.string().regex(SHA256);
const timestampSchema = z.string().datetime({ offset: true });

const shopPinSchema = z
  .object({
    domain: z.literal(LARA_ROVINJ_REMEDIATION_SHOP.domain),
    shopId: z.literal(LARA_ROVINJ_REMEDIATION_SHOP.shopId),
  })
  .strict();

const pageTargetSchema = z
  .object({
    resourceId: z.string().regex(PAGE_GID),
    handle: z.string().regex(HANDLE).max(255),
  })
  .strict();

const policyTypeSchema = z.enum([
  "CONTACT_INFORMATION",
  "LEGAL_NOTICE",
  "PRIVACY_POLICY",
  "REFUND_POLICY",
  "SHIPPING_POLICY",
  "SUBSCRIPTION_POLICY",
  "TERMS_OF_SALE",
  "TERMS_OF_SERVICE",
]);

const policyTargetSchema = z
  .object({
    resourceId: z.string().regex(POLICY_GID),
    policyType: policyTypeSchema,
  })
  .strict();

const themeTargetSchema = z
  .object({
    themeId: z.string().regex(THEME_GID),
    assetKey: z
      .string()
      .min(1)
      .max(255)
      .regex(THEME_FILE)
      .refine((value) => !value.includes(".."), "Theme asset paths cannot traverse."),
  })
  .strict();

const pageProtectedFieldsSchema = z
  .object({
    handleSha256: digestSchema,
    titleSha256: digestSchema,
    templateSuffixSha256: digestSchema,
    publicationSha256: digestSchema,
  })
  .strict();

const policyProtectedFieldsSchema = z
  .object({
    policyTypeSha256: digestSchema,
    titleSha256: digestSchema,
    urlSha256: digestSchema,
  })
  .strict();

const themeProtectedFieldsSchema = z
  .object({
    assetKeySha256: digestSchema,
    contentTypeSha256: digestSchema,
    themeNameSha256: digestSchema,
    themeRoleSha256: digestSchema,
  })
  .strict();

const pageCasSchema = z
  .object({
    beforeStateSha256: digestSchema,
    expectedUpdatedAt: timestampSchema,
    protectedFields: pageProtectedFieldsSchema,
  })
  .strict();

const policyCasSchema = z
  .object({
    beforeStateSha256: digestSchema,
    expectedUpdatedAt: timestampSchema,
    protectedFields: policyProtectedFieldsSchema,
  })
  .strict();

const themeCasSchema = z
  .object({
    beforeStateSha256: digestSchema,
    expectedUpdatedAt: timestampSchema,
    expectedChecksumMd5: z.string().regex(/^[a-f0-9]{32}$/).nullable(),
    protectedFields: themeProtectedFieldsSchema,
  })
  .strict();

function passiveHtmlSchema(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .refine(
      (value) => !ACTIVE_HTML.test(value),
      "Only passive page and policy HTML is allowed in a remediation plan.",
    );
}

function tokenCount(value: string, token: string): number {
  if (!token) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= value.length - token.length) {
    const index = value.indexOf(token, offset);
    if (index < 0) break;
    count += 1;
    offset = index + token.length;
  }
  return count;
}

const riskyThemeTokens = ["{%", "{{", "<script", "javascript:"] as const;

function eventHandlerCount(value: string): number {
  return [...value.matchAll(/\bon[a-z]+\s*=/giu)].length;
}

const themeExactChangeSchema = z
  .object({
    needle: z.string().min(1).max(20_000),
    replacement: z.string().max(20_000),
    expectedOccurrences: z.number().int().min(1).max(25),
  })
  .strict()
  .superRefine((change, context) => {
    if (change.needle === change.replacement) {
      context.addIssue({
        code: "custom",
        message: "A theme replacement must change the exact text.",
      });
    }
    const needleLower = change.needle.toLocaleLowerCase();
    const replacementLower = change.replacement.toLocaleLowerCase();
    for (const token of riskyThemeTokens) {
      if (tokenCount(replacementLower, token) > tokenCount(needleLower, token)) {
        context.addIssue({
          code: "custom",
          message: `A theme replacement cannot introduce additional ${token} tokens.`,
        });
      }
    }
    if (eventHandlerCount(change.replacement) > eventHandlerCount(change.needle)) {
      context.addIssue({
        code: "custom",
        message: "A theme replacement cannot introduce an event handler.",
      });
    }
  });

const operationReasonSchema = z.string().trim().min(8).max(500);
const evidenceRefsSchema = z.array(z.string().trim().min(1).max(300)).max(30).default([]);

const pageReplaceOperationSchema = z
  .object({
    operationId: z.string().regex(OPERATION_ID),
    kind: z.literal("page.replace_body"),
    reason: operationReasonSchema,
    evidenceRefs: evidenceRefsSchema,
    target: pageTargetSchema,
    cas: pageCasSchema,
    change: z.object({ bodyHtml: passiveHtmlSchema(500_000) }).strict(),
  })
  .strict();

const policyReplaceOperationSchema = z
  .object({
    operationId: z.string().regex(OPERATION_ID),
    kind: z.literal("policy.replace_body"),
    reason: operationReasonSchema,
    evidenceRefs: evidenceRefsSchema,
    target: policyTargetSchema,
    cas: policyCasSchema,
    change: z.object({ body: passiveHtmlSchema(500_000) }).strict(),
  })
  .strict();

const themeReplaceOperationSchema = z
  .object({
    operationId: z.string().regex(OPERATION_ID),
    kind: z.literal("theme.replace_exact_text"),
    reason: operationReasonSchema,
    evidenceRefs: evidenceRefsSchema,
    target: themeTargetSchema,
    cas: themeCasSchema,
    change: themeExactChangeSchema,
  })
  .strict();

export const shopifyRemediationOperationSchema = z.discriminatedUnion("kind", [
  pageReplaceOperationSchema,
  policyReplaceOperationSchema,
  themeReplaceOperationSchema,
]);

function operationTargetKey(
  operation: DeepReadonly<z.output<typeof shopifyRemediationOperationSchema>>,
) {
  switch (operation.kind) {
    case "page.replace_body":
      return `page:${operation.target.resourceId}`;
    case "policy.replace_body":
      return `policy:${operation.target.resourceId}`;
    case "theme.replace_exact_text":
      return `theme:${operation.target.themeId}:${operation.target.assetKey}`;
  }
}

export const shopifyRemediationPlanPayloadSchema = z
  .object({
    schemaVersion: z.literal(SHOPIFY_REMEDIATION_PLAN_SCHEMA_VERSION).default(
      SHOPIFY_REMEDIATION_PLAN_SCHEMA_VERSION,
    ),
    planId: z.string().regex(PLAN_ID),
    shop: shopPinSchema,
    createdAt: timestampSchema,
    purpose: z.string().trim().min(8).max(1_000),
    executionMode: z.enum(["dry-run", "apply"]).default("dry-run"),
    operations: z.array(shopifyRemediationOperationSchema).min(1).max(100),
  })
  .strict()
  .superRefine((plan, context) => {
    const operationIds = new Set<string>();
    const targets = new Set<string>();
    plan.operations.forEach((operation, index) => {
      if (operationIds.has(operation.operationId)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "operationId"],
          message: "Operation ids must be unique within a plan.",
        });
      }
      operationIds.add(operation.operationId);

      const target = operationTargetKey(operation);
      if (targets.has(target)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "target"],
          message: "A target can only be changed once in an immutable plan.",
        });
      }
      targets.add(target);
    });
  });

export type ShopifyRemediationPlanInput = z.input<
  typeof shopifyRemediationPlanPayloadSchema
>;
export type ShopifyRemediationPlanPayload = z.output<
  typeof shopifyRemediationPlanPayloadSchema
>;
export type ShopifyRemediationOperation = z.output<
  typeof shopifyRemediationOperationSchema
>;
export type ReadonlyShopifyRemediationOperation =
  DeepReadonly<ShopifyRemediationOperation>;
export type PageReplaceOperation = z.output<typeof pageReplaceOperationSchema>;
export type PolicyReplaceOperation = z.output<typeof policyReplaceOperationSchema>;
export type ThemeReplaceOperation = z.output<typeof themeReplaceOperationSchema>;

const sealedPlanSchema = z
  .object({
    payload: shopifyRemediationPlanPayloadSchema,
    digestSha256: digestSchema,
  })
  .strict();

export type SealedShopifyRemediationPlan = DeepReadonly<
  z.output<typeof sealedPlanSchema>
>;

const pageBeforeSnapshotSchema = z
  .object({
    kind: z.literal("page"),
    shop: shopPinSchema,
    capturedAt: timestampSchema,
    target: pageTargetSchema,
    state: z
      .object({
        title: z.string().max(255),
        bodyHtml: z.string().max(1_000_000),
        templateSuffix: z.string().max(255).nullable(),
        isPublished: z.boolean(),
        publishedAt: timestampSchema.nullable(),
        updatedAt: timestampSchema,
      })
      .strict(),
  })
  .strict();

const policyBeforeSnapshotSchema = z
  .object({
    kind: z.literal("policy"),
    shop: shopPinSchema,
    capturedAt: timestampSchema,
    target: policyTargetSchema,
    state: z
      .object({
        title: z.string().max(255),
        url: z.string().url().max(2_048),
        body: z.string().max(1_000_000),
        updatedAt: timestampSchema,
      })
      .strict(),
  })
  .strict();

const themeBeforeSnapshotSchema = z
  .object({
    kind: z.literal("theme_asset"),
    shop: shopPinSchema,
    capturedAt: timestampSchema,
    target: themeTargetSchema,
    state: z
      .object({
        themeName: z.string().min(1).max(255),
        themeRole: z.enum(["MAIN", "UNPUBLISHED"]),
        contentType: z.string().min(1).max(255),
        content: z.string().max(2_000_000),
        checksumMd5: z.string().regex(/^[a-f0-9]{32}$/).nullable(),
        updatedAt: timestampSchema,
      })
      .strict(),
  })
  .strict();

export const shopifyRemediationBeforeSnapshotSchema = z.discriminatedUnion("kind", [
  pageBeforeSnapshotSchema,
  policyBeforeSnapshotSchema,
  themeBeforeSnapshotSchema,
]);

export type ShopifyRemediationBeforeSnapshotInput = z.input<
  typeof shopifyRemediationBeforeSnapshotSchema
>;
export type ShopifyRemediationBeforeSnapshot = z.output<
  typeof shopifyRemediationBeforeSnapshotSchema
>;
export type PageBeforeSnapshot = z.output<typeof pageBeforeSnapshotSchema>;
export type PolicyBeforeSnapshot = z.output<typeof policyBeforeSnapshotSchema>;
export type ThemeBeforeSnapshot = z.output<typeof themeBeforeSnapshotSchema>;

export type PageRemediationCas = z.output<typeof pageCasSchema>;
export type PolicyRemediationCas = z.output<typeof policyCasSchema>;
export type ThemeRemediationCas = z.output<typeof themeCasSchema>;
export type ShopifyRemediationCas =
  | PageRemediationCas
  | PolicyRemediationCas
  | ThemeRemediationCas;

export class ShopifyRemediationPlanError extends Error {
  constructor(
    readonly code:
      | "invalid_plan"
      | "invalid_snapshot"
      | "plan_digest_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ShopifyRemediationPlanError";
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function canonicalise(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical remediation values must be finite JSON numbers.");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalise(child)]),
    );
  }
  throw new TypeError("Canonical remediation values must be JSON serialisable.");
}

export function canonicalRemediationJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

export async function remediationSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalRemediationJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sealShopifyRemediationPlan(
  input: ShopifyRemediationPlanInput,
): Promise<SealedShopifyRemediationPlan> {
  let payload: ShopifyRemediationPlanPayload;
  try {
    payload = shopifyRemediationPlanPayloadSchema.parse(input);
  } catch {
    throw new ShopifyRemediationPlanError(
      "invalid_plan",
      "The remediation plan does not match the immutable Lara schema.",
    );
  }
  const digestSha256 = await remediationSha256(payload);
  return deepFreeze({ payload, digestSha256 });
}

export async function verifyShopifyRemediationPlan(
  input: unknown,
): Promise<SealedShopifyRemediationPlan> {
  let sealed: z.output<typeof sealedPlanSchema>;
  try {
    sealed = sealedPlanSchema.parse(input);
  } catch {
    throw new ShopifyRemediationPlanError(
      "invalid_plan",
      "The sealed remediation plan is invalid.",
    );
  }
  const expected = await remediationSha256(sealed.payload);
  if (expected !== sealed.digestSha256) {
    throw new ShopifyRemediationPlanError(
      "plan_digest_mismatch",
      "The immutable remediation plan digest does not match its payload.",
    );
  }
  return deepFreeze(sealed);
}

export function parseShopifyRemediationBeforeSnapshot(
  input: ShopifyRemediationBeforeSnapshotInput,
): DeepReadonly<ShopifyRemediationBeforeSnapshot> {
  try {
    return deepFreeze(shopifyRemediationBeforeSnapshotSchema.parse(input));
  } catch {
    throw new ShopifyRemediationPlanError(
      "invalid_snapshot",
      "The remediation before snapshot is invalid or is not pinned to Lara Rovinj.",
    );
  }
}

function snapshotStableState(snapshot: ShopifyRemediationBeforeSnapshot) {
  switch (snapshot.kind) {
    case "page":
      return {
        shop: snapshot.shop,
        target: snapshot.target,
        state: {
          title: snapshot.state.title,
          bodyHtml: snapshot.state.bodyHtml,
          templateSuffix: snapshot.state.templateSuffix,
          isPublished: snapshot.state.isPublished,
          publishedAt: snapshot.state.publishedAt,
        },
      };
    case "policy":
      return {
        shop: snapshot.shop,
        target: snapshot.target,
        state: {
          title: snapshot.state.title,
          url: snapshot.state.url,
          body: snapshot.state.body,
        },
      };
    case "theme_asset":
      return {
        shop: snapshot.shop,
        target: snapshot.target,
        state: {
          themeName: snapshot.state.themeName,
          themeRole: snapshot.state.themeRole,
          contentType: snapshot.state.contentType,
          content: snapshot.state.content,
        },
      };
  }
}

export async function remediationSnapshotStateSha256(
  snapshotInput: ShopifyRemediationBeforeSnapshotInput,
): Promise<string> {
  const snapshot = shopifyRemediationBeforeSnapshotSchema.parse(snapshotInput);
  return remediationSha256(snapshotStableState(snapshot));
}

async function pageProtectedFields(snapshot: PageBeforeSnapshot) {
  return {
    handleSha256: await remediationSha256(snapshot.target.handle),
    titleSha256: await remediationSha256(snapshot.state.title),
    templateSuffixSha256: await remediationSha256(snapshot.state.templateSuffix),
    publicationSha256: await remediationSha256({
      isPublished: snapshot.state.isPublished,
      publishedAt: snapshot.state.publishedAt,
    }),
  };
}

async function policyProtectedFields(snapshot: PolicyBeforeSnapshot) {
  return {
    policyTypeSha256: await remediationSha256(snapshot.target.policyType),
    titleSha256: await remediationSha256(snapshot.state.title),
    urlSha256: await remediationSha256(snapshot.state.url),
  };
}

async function themeProtectedFields(snapshot: ThemeBeforeSnapshot) {
  return {
    assetKeySha256: await remediationSha256(snapshot.target.assetKey),
    contentTypeSha256: await remediationSha256(snapshot.state.contentType),
    themeNameSha256: await remediationSha256(snapshot.state.themeName),
    themeRoleSha256: await remediationSha256(snapshot.state.themeRole),
  };
}

export async function buildShopifyRemediationCas(
  snapshotInput: ShopifyRemediationBeforeSnapshotInput,
): Promise<ShopifyRemediationCas> {
  const snapshot = shopifyRemediationBeforeSnapshotSchema.parse(snapshotInput);
  const beforeStateSha256 = await remediationSha256(snapshotStableState(snapshot));
  switch (snapshot.kind) {
    case "page":
      return {
        beforeStateSha256,
        expectedUpdatedAt: snapshot.state.updatedAt,
        protectedFields: await pageProtectedFields(snapshot),
      };
    case "policy":
      return {
        beforeStateSha256,
        expectedUpdatedAt: snapshot.state.updatedAt,
        protectedFields: await policyProtectedFields(snapshot),
      };
    case "theme_asset":
      return {
        beforeStateSha256,
        expectedUpdatedAt: snapshot.state.updatedAt,
        expectedChecksumMd5: snapshot.state.checksumMd5,
        protectedFields: await themeProtectedFields(snapshot),
      };
  }
}

export async function remediationProtectedFields(
  snapshotInput: ShopifyRemediationBeforeSnapshotInput,
): Promise<
  | PageRemediationCas["protectedFields"]
  | PolicyRemediationCas["protectedFields"]
  | ThemeRemediationCas["protectedFields"]
> {
  const snapshot = shopifyRemediationBeforeSnapshotSchema.parse(snapshotInput);
  switch (snapshot.kind) {
    case "page":
      return pageProtectedFields(snapshot);
    case "policy":
      return policyProtectedFields(snapshot);
    case "theme_asset":
      return themeProtectedFields(snapshot);
  }
}

export function remediationOperationTargetKey(
  operation: ReadonlyShopifyRemediationOperation,
): string {
  return operationTargetKey(operation);
}

export function remediationSnapshotTargetKey(
  snapshot: ShopifyRemediationBeforeSnapshot,
): string {
  switch (snapshot.kind) {
    case "page":
      return `page:${snapshot.target.resourceId}`;
    case "policy":
      return `policy:${snapshot.target.resourceId}`;
    case "theme_asset":
      return `theme:${snapshot.target.themeId}:${snapshot.target.assetKey}`;
  }
}

export function countExactRemediationOccurrences(value: string, needle: string): number {
  return tokenCount(value, needle);
}

export function freezeRemediationValue<T>(value: T): DeepReadonly<T> {
  return deepFreeze(value);
}
