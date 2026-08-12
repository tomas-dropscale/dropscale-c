import "server-only";

import {
  LARA_THEME_URGENCY_FILES,
  LARA_THEME_URGENCY_THEME,
  LARA_THEME_VENDOR_POLICY,
  buildLaraThemeUrgencyPlan,
  readLaraThemeUrgencySnapshot,
  verifyLaraThemeUrgencyPlan,
  verifyLaraThemeUrgencySnapshot,
  type LaraThemeUrgencyFilename,
  type LaraThemeUrgencyReadRuntime,
  type LaraThemeUrgencySnapshot,
  type SealedLaraThemeUrgencyPlan,
} from "./lara-theme-urgency-plan";
import {
  canonicalRemediationJson,
  freezeRemediationValue,
  remediationSha256,
  type DeepReadonly,
} from "./shopify-remediation-plan";

export const LARA_THEME_URGENCY_LIVE_SCHEMA_VERSION =
  "lara-theme-urgency-live.v1" as const;
export const LARA_THEME_URGENCY_LIVE_PLAN_ID =
  "lara-theme-urgency-exact-copy-v1" as const;
export const LARA_THEME_URGENCY_LIVE_PLAN_CREATED_AT =
  "2026-08-12T21:30:00.000Z" as const;
export const LARA_THEME_URGENCY_LIVE_PURPOSE =
  "Remove only exact unsupported closing-sale, scarcity, high-demand and since-2015 copy from the pinned Lara main theme." as const;
export const LARA_THEME_URGENCY_KACHING_FILE =
  "config/settings_data.json" as const;
export const LARA_THEME_URGENCY_MAX_DURABLE_ARTIFACT_BYTES = 7_500_000 as const;

export const LARA_THEME_URGENCY_KACHING_HANDLING = Object.freeze({
  filename: LARA_THEME_URGENCY_KACHING_FILE,
  status: "deferred_no_write",
  reason:
    "The urgency-copy batch never writes Kaching. Any exact disabled:false embed must use a separate boolean-only plan with its own backup and native-cart/public verification.",
} as const);

/** All unsupported public phrases this exact copy batch must eliminate. */
export const LARA_THEME_URGENCY_TERMINAL_PUBLIC_MARKERS = Object.freeze([
  "Zbogom...",
  "Veliko rasprodavanje cijele trgovine",
  "Lara Rovinj zatvara svoja vrata",
  "Hvala vam što ste bili dio ove priče",
  "Posljednji dani, posljednje veličine",
  "Zauvijek,",
  "Posljednji komadi",
  "Zbog velike potražnje tijekom rasprodaje",
  "naše zalihe su gotovo rasprodane",
  "ako kliknete na gumb",
  "proizvod je još uvijek dostupan",
  "Hrvatski brend od 2015",
  "hrvatski brend od 2015",
] as const);

export type LaraKachingEmbedEvidence = DeepReadonly<{
  sourceContentSha256: string;
  rawTokenOccurrences: number;
  kachingTypedBlockCount: number;
  exactEmbedTypeCount: number;
  exactActiveEmbedCount: number;
  exactActiveEmbedPath: string | null;
  separateBooleanPlanEligible: boolean;
  urgencyBatchWriteIncluded: false;
}>;

export type LaraThemeUrgencyLiveMaterial = DeepReadonly<{
  payload: {
    schemaVersion: typeof LARA_THEME_URGENCY_LIVE_SCHEMA_VERSION;
    capturedAt: string;
    backupScope: "all_eight_selected_source_files_and_every_operation_inverse";
    sourceSnapshot: LaraThemeUrgencySnapshot;
    plan: SealedLaraThemeUrgencyPlan;
    vendorPolicy: typeof LARA_THEME_VENDOR_POLICY;
    kachingHandling: typeof LARA_THEME_URGENCY_KACHING_HANDLING;
    kachingEvidence: LaraKachingEmbedEvidence;
  };
  digestSha256: string;
}>;

export type LaraThemeUrgencyLiveState =
  | "before_exact"
  | "after_exact"
  | "mixed_transition"
  | "drift";

export class LaraThemeUrgencyLiveContractError extends Error {
  constructor(
    public readonly code:
      | "AMBIGUOUS_COPY_REMAINS"
      | "ARTIFACT_TOO_LARGE"
      | "INVALID_LIVE_MATERIAL"
      | "KACHING_WRITE_BLOCKED"
      | "NO_EXACT_OPERATIONS",
    message: string,
  ) {
    super(message);
    this.name = "LaraThemeUrgencyLiveContractError";
  }
}

const SHA256 = /^[a-f0-9]{64}$/;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertTimestamp(value: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new LaraThemeUrgencyLiveContractError(
      "INVALID_LIVE_MATERIAL",
      "The durable Lara theme capture timestamp is invalid.",
    );
  }
}

function sourceFileMap(snapshot: LaraThemeUrgencySnapshot) {
  return new Map(snapshot.files.map((file) => [file.filename, file]));
}

function operationMap(plan: SealedLaraThemeUrgencyPlan) {
  return new Map(
    plan.payload.operations.map((operation) => [operation.target.filename, operation]),
  );
}

function sameSourceFile(
  left: LaraThemeUrgencySnapshot["files"][number],
  right: LaraThemeUrgencySnapshot["files"][number],
) {
  return (
    left.filename === right.filename &&
    left.updatedAt === right.updatedAt &&
    left.checksumMd5 === right.checksumMd5 &&
    left.contentType === right.contentType &&
    left.size === right.size &&
    left.contentSha256 === right.contentSha256 &&
    left.content === right.content
  );
}

function durableArtifactBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalRemediationJson(value)).byteLength;
}

function countExact(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const index = value.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function inspectKachingEmbed(snapshot: LaraThemeUrgencySnapshot): LaraKachingEmbedEvidence {
  const file = snapshot.files.find(
    (candidate) => candidate.filename === LARA_THEME_URGENCY_KACHING_FILE,
  );
  if (!file) {
    throw new LaraThemeUrgencyLiveContractError(
      "INVALID_LIVE_MATERIAL",
      "The complete Lara source backup is missing Kaching settings evidence.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    throw new LaraThemeUrgencyLiveContractError(
      "INVALID_LIVE_MATERIAL",
      "The Lara settings source is not valid JSON.",
    );
  }
  const typed: Array<{
    type: string;
    disabled: unknown;
    disabledPresent: boolean;
    path: string;
  }> = [];
  const walk = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (
        typeof record.type === "string" &&
        record.type.startsWith("shopify://apps/kaching-cart/blocks/")
      ) {
        typed.push({
          type: record.type,
          disabled: record.disabled,
          disabledPresent: Object.hasOwn(record, "disabled"),
          path,
        });
      }
      for (const [key, child] of Object.entries(record)) {
        walk(child, `${path}.${key}`);
      }
      return;
    }
    value.forEach((child, index) => walk(child, `${path}[${index}]`));
  };
  walk(parsed, "$");
  const exact = typed.filter((candidate) =>
    /^shopify:\/\/apps\/kaching-cart\/blocks\/embed\/[A-Za-z0-9_-]{4,128}$/.test(
      candidate.type,
    ),
  );
  const exactActive = exact.filter(
    (candidate) => candidate.disabledPresent && candidate.disabled === false,
  );
  const eligible =
    typed.length === 1 && exact.length === 1 && exactActive.length === 1;
  return freezeRemediationValue({
    sourceContentSha256: file.contentSha256,
    rawTokenOccurrences: countExact(file.content, "kaching-cart"),
    kachingTypedBlockCount: typed.length,
    exactEmbedTypeCount: exact.length,
    exactActiveEmbedCount: exactActive.length,
    exactActiveEmbedPath: eligible ? exactActive[0]!.path : null,
    separateBooleanPlanEligible: eligible,
    urgencyBatchWriteIncluded: false as const,
  });
}

async function assertApprovedPlan(
  snapshot: LaraThemeUrgencySnapshot,
  plan: SealedLaraThemeUrgencyPlan,
): Promise<void> {
  if (
    plan.payload.planId !== LARA_THEME_URGENCY_LIVE_PLAN_ID ||
    plan.payload.createdAt !== LARA_THEME_URGENCY_LIVE_PLAN_CREATED_AT ||
    plan.payload.executionMode !== "apply" ||
    plan.payload.purpose !== LARA_THEME_URGENCY_LIVE_PURPOSE ||
    plan.payload.sourceCapturedAt !== snapshot.capturedAt ||
    plan.payload.sourceSnapshotDigestSha256 !== snapshot.digestSha256 ||
    plan.payload.theme.id !== LARA_THEME_URGENCY_THEME.id ||
    plan.payload.theme.name !== LARA_THEME_URGENCY_THEME.name ||
    plan.payload.theme.role !== LARA_THEME_URGENCY_THEME.role ||
    plan.payload.vendorPolicy.decision !== "merchant_accepted_non_issue" ||
    plan.payload.vendorPolicy.mutationsAllowed !== false
  ) {
    throw new LaraThemeUrgencyLiveContractError(
      "INVALID_LIVE_MATERIAL",
      "The durable Lara plan is not the fixed, merchant-approved theme plan.",
    );
  }
  if (plan.payload.operations.length === 0) {
    throw new LaraThemeUrgencyLiveContractError(
      "NO_EXACT_OPERATIONS",
      "No exact unsupported theme copy remains to change.",
    );
  }
  if (
    plan.payload.blockers.some((blocker) => blocker.code === "AMBIGUOUS_ACTIVE_COPY")
  ) {
    throw new LaraThemeUrgencyLiveContractError(
      "AMBIGUOUS_COPY_REMAINS",
      "Unsupported active copy remains without an approved exact replacement.",
    );
  }
  if (
    plan.payload.operations.some(
      (operation) => operation.target.filename === LARA_THEME_URGENCY_KACHING_FILE,
    )
  ) {
    throw new LaraThemeUrgencyLiveContractError(
      "KACHING_WRITE_BLOCKED",
      "The Kaching settings file is explicitly excluded from this write batch.",
    );
  }
  const filenames = plan.payload.operations.map(
    (operation) => operation.target.filename,
  );
  if (
    new Set(filenames).size !== filenames.length ||
    filenames.some((filename) => !LARA_THEME_URGENCY_FILES.includes(filename))
  ) {
    throw new LaraThemeUrgencyLiveContractError(
      "INVALID_LIVE_MATERIAL",
      "The Lara theme plan contains an invalid or duplicate filename.",
    );
  }

  const sources = sourceFileMap(snapshot);
  for (const operation of plan.payload.operations) {
    const source = sources.get(operation.target.filename);
    if (
      !source ||
      operation.target.themeId !== LARA_THEME_URGENCY_THEME.id ||
      operation.protectedTheme.name !== snapshot.theme.name ||
      operation.protectedTheme.nameSha256 !== snapshot.theme.nameSha256 ||
      operation.protectedTheme.role !== snapshot.theme.role ||
      operation.protectedTheme.roleSha256 !== snapshot.theme.roleSha256 ||
      operation.before.updatedAt !== source.updatedAt ||
      operation.before.checksumMd5 !== source.checksumMd5 ||
      operation.before.contentType !== source.contentType ||
      operation.before.size !== source.size ||
      operation.before.contentSha256 !== source.contentSha256 ||
      operation.inverse.content !== source.content ||
      operation.inverse.contentSha256 !== source.contentSha256 ||
      operation.after.contentSha256 !==
        (await remediationSha256(operation.after.content)) ||
      operation.exactChanges.length === 0 ||
      operation.exactChanges.some(
        (change) =>
          change.expectedOccurrences < 1 ||
          !["closing_sale", "scarcity", "high_demand", "longevity_claim"].includes(
            change.category,
          ),
      )
    ) {
      throw new LaraThemeUrgencyLiveContractError(
        "INVALID_LIVE_MATERIAL",
        `The exact durable inverse is invalid for ${operation.target.filename}.`,
      );
    }
    if (
      LARA_THEME_URGENCY_TERMINAL_PUBLIC_MARKERS.some((marker) =>
        operation.after.content.includes(marker),
      )
    ) {
      throw new LaraThemeUrgencyLiveContractError(
        "AMBIGUOUS_COPY_REMAINS",
        `An unsupported public theme phrase remains after ${operation.target.filename}.`,
      );
    }
  }

  const rebuilt = await buildLaraThemeUrgencyPlan({
    snapshot,
    planId: plan.payload.planId,
    createdAt: plan.payload.createdAt,
    executionMode: plan.payload.executionMode,
    purpose: plan.payload.purpose,
  });
  if (
    rebuilt.digestSha256 !== plan.digestSha256 ||
    canonicalRemediationJson(rebuilt) !== canonicalRemediationJson(plan)
  ) {
    throw new LaraThemeUrgencyLiveContractError(
      "INVALID_LIVE_MATERIAL",
      "The exact Lara plan does not rebuild from its complete source backup.",
    );
  }
}

export async function prepareLaraThemeUrgencyLiveMaterial({
  runtime,
  capturedAt,
}: {
  runtime: LaraThemeUrgencyReadRuntime;
  capturedAt: string;
}): Promise<LaraThemeUrgencyLiveMaterial> {
  assertTimestamp(capturedAt);
  const sourceSnapshot = await readLaraThemeUrgencySnapshot({ runtime, capturedAt });
  const plan = await buildLaraThemeUrgencyPlan({
    snapshot: sourceSnapshot,
    planId: LARA_THEME_URGENCY_LIVE_PLAN_ID,
    createdAt: LARA_THEME_URGENCY_LIVE_PLAN_CREATED_AT,
    executionMode: "apply",
    purpose: LARA_THEME_URGENCY_LIVE_PURPOSE,
  });
  await assertApprovedPlan(sourceSnapshot, plan);
  const payload: LaraThemeUrgencyLiveMaterial["payload"] = {
    schemaVersion: LARA_THEME_URGENCY_LIVE_SCHEMA_VERSION,
    capturedAt,
    backupScope: "all_eight_selected_source_files_and_every_operation_inverse",
    sourceSnapshot,
    plan,
    vendorPolicy: LARA_THEME_VENDOR_POLICY,
    kachingHandling: LARA_THEME_URGENCY_KACHING_HANDLING,
    kachingEvidence: inspectKachingEmbed(sourceSnapshot),
  };
  const material = freezeRemediationValue({
    payload,
    digestSha256: await remediationSha256(payload),
  });
  if (durableArtifactBytes(material) > LARA_THEME_URGENCY_MAX_DURABLE_ARTIFACT_BYTES) {
    throw new LaraThemeUrgencyLiveContractError(
      "ARTIFACT_TOO_LARGE",
      "The full Lara theme backup cannot fit in the durable service artifact.",
    );
  }
  return material;
}

export async function verifyLaraThemeUrgencyLiveMaterial(
  input: unknown,
): Promise<LaraThemeUrgencyLiveMaterial> {
  const material = objectRecord(input);
  const payload = objectRecord(material?.payload);
  if (
    !material ||
    !payload ||
    payload.schemaVersion !== LARA_THEME_URGENCY_LIVE_SCHEMA_VERSION ||
    typeof payload.capturedAt !== "string" ||
    payload.backupScope !==
      "all_eight_selected_source_files_and_every_operation_inverse" ||
    payload.vendorPolicy === null ||
    payload.kachingHandling === null ||
    payload.kachingEvidence === null ||
    typeof material.digestSha256 !== "string" ||
    !SHA256.test(material.digestSha256)
  ) {
    throw new LaraThemeUrgencyLiveContractError(
      "INVALID_LIVE_MATERIAL",
      "The durable Lara theme material is malformed.",
    );
  }
  assertTimestamp(payload.capturedAt);
  let sourceSnapshot: LaraThemeUrgencySnapshot;
  let plan: SealedLaraThemeUrgencyPlan;
  try {
    sourceSnapshot = await verifyLaraThemeUrgencySnapshot(
      payload.sourceSnapshot as LaraThemeUrgencySnapshot,
    );
    plan = await verifyLaraThemeUrgencyPlan(
      payload.plan as SealedLaraThemeUrgencyPlan,
    );
  } catch {
    throw new LaraThemeUrgencyLiveContractError(
      "INVALID_LIVE_MATERIAL",
      "The durable Lara theme source or plan failed verification.",
    );
  }
  if (
    sourceSnapshot.capturedAt !== payload.capturedAt ||
    canonicalRemediationJson(payload.vendorPolicy) !==
      canonicalRemediationJson(LARA_THEME_VENDOR_POLICY) ||
    canonicalRemediationJson(payload.kachingHandling) !==
      canonicalRemediationJson(LARA_THEME_URGENCY_KACHING_HANDLING) ||
    canonicalRemediationJson(payload.kachingEvidence) !==
      canonicalRemediationJson(inspectKachingEmbed(sourceSnapshot))
  ) {
    throw new LaraThemeUrgencyLiveContractError(
      "INVALID_LIVE_MATERIAL",
      "The durable Lara theme safety policy changed.",
    );
  }
  await assertApprovedPlan(sourceSnapshot, plan);
  const typedPayload: LaraThemeUrgencyLiveMaterial["payload"] = {
    schemaVersion: LARA_THEME_URGENCY_LIVE_SCHEMA_VERSION,
    capturedAt: payload.capturedAt,
    backupScope: "all_eight_selected_source_files_and_every_operation_inverse",
    sourceSnapshot,
    plan,
    vendorPolicy: LARA_THEME_VENDOR_POLICY,
    kachingHandling: LARA_THEME_URGENCY_KACHING_HANDLING,
    kachingEvidence: inspectKachingEmbed(sourceSnapshot),
  };
  if (
    material.digestSha256 !== (await remediationSha256(typedPayload)) ||
    durableArtifactBytes({ payload: typedPayload, digestSha256: material.digestSha256 }) >
      LARA_THEME_URGENCY_MAX_DURABLE_ARTIFACT_BYTES
  ) {
    throw new LaraThemeUrgencyLiveContractError(
      "INVALID_LIVE_MATERIAL",
      "The durable Lara theme material digest or size is invalid.",
    );
  }
  return freezeRemediationValue({
    payload: typedPayload,
    digestSha256: material.digestSha256,
  });
}

export async function classifyLaraThemeUrgencyLiveState({
  material: input,
  current,
}: {
  material: LaraThemeUrgencyLiveMaterial;
  current: LaraThemeUrgencySnapshot;
}): Promise<LaraThemeUrgencyLiveState> {
  const material = await verifyLaraThemeUrgencyLiveMaterial(input);
  try {
    await verifyLaraThemeUrgencySnapshot(current);
  } catch {
    return "drift";
  }
  const source = material.payload.sourceSnapshot;
  if (
    current.theme.id !== source.theme.id ||
    current.theme.name !== source.theme.name ||
    current.theme.nameSha256 !== source.theme.nameSha256 ||
    current.theme.role !== source.theme.role ||
    current.theme.roleSha256 !== source.theme.roleSha256
  ) {
    return "drift";
  }

  const beforeByName = sourceFileMap(source);
  const currentByName = sourceFileMap(current);
  const operations = operationMap(material.payload.plan);
  const operationStates: Array<"before" | "after"> = [];

  for (const filename of LARA_THEME_URGENCY_FILES) {
    const before = beforeByName.get(filename);
    const observed = currentByName.get(filename);
    if (!before || !observed) return "drift";
    const operation = operations.get(filename);
    if (!operation) {
      if (!sameSourceFile(before, observed)) return "drift";
      continue;
    }
    if (sameSourceFile(before, observed)) {
      operationStates.push("before");
      continue;
    }
    if (
      observed.contentType === before.contentType &&
      observed.content === operation.after.content &&
      observed.contentSha256 === operation.after.contentSha256
    ) {
      operationStates.push("after");
      continue;
    }
    return "drift";
  }

  if (operationStates.every((state) => state === "before")) return "before_exact";
  if (operationStates.every((state) => state === "after")) return "after_exact";
  return "mixed_transition";
}

export function laraThemeUrgencyOperationFilenames(
  material: LaraThemeUrgencyLiveMaterial,
): LaraThemeUrgencyFilename[] {
  return material.payload.plan.payload.operations.map(
    (operation) => operation.target.filename,
  );
}
