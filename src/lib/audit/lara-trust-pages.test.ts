import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  LARA_ABOUT_PAGE_BODY_HTML,
  LARA_CONTACT_PAGE_BODY_HTML,
  LARA_TRUST_NAVIGATION_ASSESSMENT,
  LARA_TRUST_PAGE_TARGETS,
  executeLaraTrustPageBatch,
  prepareLaraTrustPageBatch,
  type LaraTrustPageReader,
  type LaraTrustPageState,
  type LaraTrustPageWriter,
} from "./lara-trust-pages";
import {
  LARA_ROVINJ_REMEDIATION_SHOP,
  buildShopifyRemediationCas,
  remediationSha256,
  type PageBeforeSnapshot,
  type PageRemediationCas,
} from "./shopify-remediation-plan";

const AT = "2026-08-12T18:00:00.000Z";
const RUN_ID = "60000000-0000-4000-8000-000000000006";

function pageState(
  key: "contact" | "about",
  overrides: Partial<LaraTrustPageState> = {},
): LaraTrustPageState {
  const target = LARA_TRUST_PAGE_TARGETS.find((candidate) => candidate.key === key);
  if (!target) throw new TypeError("Missing trust-page fixture target.");
  return {
    id: target.resourceId,
    title: target.title,
    handle: target.handle,
    bodyHtml: `<p>Original ${key} body with merchant-authored formatting.</p>`,
    templateSuffix: key === "contact" ? "contact" : null,
    isPublished: true,
    publishedAt: "2026-08-10T10:00:00.000Z",
    updatedAt:
      key === "contact"
        ? "2026-08-11T10:00:00.000Z"
        : "2026-08-11T11:00:00.000Z",
    ...overrides,
  };
}

function memoryReader(states: Map<string, LaraTrustPageState>): LaraTrustPageReader {
  return {
    readPages: vi.fn(async ({
      shop,
      resourceIds,
    }: Parameters<LaraTrustPageReader["readPages"]>[0]) => {
      expect(shop).toEqual(LARA_ROVINJ_REMEDIATION_SHOP);
      return resourceIds
        .map((resourceId) => states.get(resourceId))
        .filter((state): state is LaraTrustPageState => Boolean(state))
        .map((state) => structuredClone(state));
    }),
  };
}

function beforeSnapshot(state: LaraTrustPageState): PageBeforeSnapshot {
  return {
    kind: "page",
    shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
    capturedAt: AT,
    target: { resourceId: state.id, handle: state.handle },
    state: {
      title: state.title,
      bodyHtml: state.bodyHtml,
      templateSuffix: state.templateSuffix,
      isPublished: state.isPublished,
      publishedAt: state.publishedAt,
      updatedAt: state.updatedAt,
    },
  };
}

async function expectedProtectedHash(state: LaraTrustPageState): Promise<string> {
  const cas = (await buildShopifyRemediationCas(
    beforeSnapshot(state),
  )) as PageRemediationCas;
  return remediationSha256(cas.protectedFields);
}

function casMemoryWriter(
  states: Map<string, LaraTrustPageState>,
  options: { failResourceId?: string; throwAfterResourceId?: string } = {},
): LaraTrustPageWriter & { replaceBodyIfUnchanged: ReturnType<typeof vi.fn> } {
  let revision = 0;
  const replaceBodyIfUnchanged = vi.fn(
    async (command: Parameters<LaraTrustPageWriter["replaceBodyIfUnchanged"]>[0]) => {
      const current = states.get(command.target.resourceId);
      if (!current) return { status: "failed" as const, errorCode: "NOT_FOUND" };
      if (options.failResourceId === command.target.resourceId) {
        return { status: "failed" as const, errorCode: "SIMULATED" };
      }
      if (
        command.expected.updatedAt !== current.updatedAt ||
        command.expected.bodySha256 !== (await remediationSha256(current.bodyHtml)) ||
        command.expected.protectedFieldsSha256 !==
          (await expectedProtectedHash(current))
      ) {
        return { status: "cas_mismatch" as const, current: structuredClone(current) };
      }
      const before = structuredClone(current);
      revision += 1;
      const after = {
        ...structuredClone(current),
        bodyHtml: command.bodyHtml,
        updatedAt: `2026-08-12T18:${String(revision).padStart(2, "0")}:00.000Z`,
      };
      states.set(after.id, after);
      if (options.throwAfterResourceId === command.target.resourceId) {
        throw new Error("Simulated lost response after Shopify accepted the write.");
      }
      return { status: "written" as const, before, after: structuredClone(after) };
    },
  );
  return { replaceBodyIfUnchanged };
}

async function fixtureBatch() {
  const states = new Map<string, LaraTrustPageState>([
    [LARA_TRUST_PAGE_TARGETS[0].resourceId, pageState("contact")],
    [LARA_TRUST_PAGE_TARGETS[1].resourceId, pageState("about")],
  ]);
  const reader = memoryReader(states);
  const prepared = await prepareLaraTrustPageBatch({ reader, runId: RUN_ID, occurredAt: AT });
  return { states, reader, prepared };
}

describe("Lara Contact and About trust-page batch", () => {
  it("has no connected runtime, route, cron or network trigger", () => {
    const source = readFileSync(new URL("./lara-trust-pages.ts", import.meta.url), "utf8");
    expect(source).not.toContain('from "./shopify-runtime"');
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH)\b/u);
    expect(source).not.toMatch(/\bscheduled\s*\(/u);
  });

  it("uses only the approved identity and avoids unsupported business details", () => {
    const copy = `${LARA_CONTACT_PAGE_BODY_HTML}\n${LARA_ABOUT_PAGE_BODY_HTML}`;
    expect(copy).toContain("Lara Rovinj");
    expect(copy).toContain("Marta Neto");
    expect(copy).toContain("Rua Capitão Manuel Tavares");
    expect(copy).toContain("3885-232 Cortegaça");
    expect(copy).toContain("Portugal");
    expect(copy).toContain("info@lararovinj.com");
    expect(copy).not.toMatch(/\b262\b|\bOIB\b|\bVAT\b|\bPDV\b|telefon|2015|zatvara/iu);
    expect(copy).not.toMatch(/adresa za povrat/iu);
    expect(copy).not.toMatch(/<\s*(?:script|iframe|form|input|button)\b/iu);
  });

  it("builds a deep-frozen two-page plan, exact CAS and restorable inverse", async () => {
    const { prepared } = await fixtureBatch();

    expect(prepared.dryRun.status).toBe("dry_run_complete");
    expect(prepared.plan.payload.operations).toHaveLength(2);
    expect(
      prepared.plan.payload.operations.every(
        (operation) => operation.kind === "page.replace_body",
      ),
    ).toBe(true);
    expect(prepared.plan.payload.operations.map((operation) => operation.target)).toEqual([
      {
        resourceId: LARA_TRUST_PAGE_TARGETS[0].resourceId,
        handle: LARA_TRUST_PAGE_TARGETS[0].handle,
      },
      {
        resourceId: LARA_TRUST_PAGE_TARGETS[1].resourceId,
        handle: LARA_TRUST_PAGE_TARGETS[1].handle,
      },
    ]);
    expect(prepared.plan.payload.operations[0]?.cas.expectedUpdatedAt).toBe(
      "2026-08-11T10:00:00.000Z",
    );
    expect(prepared.plan.payload.operations[1]?.cas.expectedUpdatedAt).toBe(
      "2026-08-11T11:00:00.000Z",
    );
    expect(prepared.dryRun.inverseManifest?.payload.operations).toEqual([
      expect.objectContaining({
        kind: "page.restore_body",
        restore: { bodyHtml: pageState("contact").bodyHtml },
      }),
      expect.objectContaining({
        kind: "page.restore_body",
        restore: { bodyHtml: pageState("about").bodyHtml },
      }),
    ]);
    expect(prepared.navigationAssessment.status).toBe(
      "blocked_missing_exact_snapshot",
    );
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.plan.payload.operations)).toBe(true);
    expect(Object.isFrozen(prepared.dryRun.inverseManifest?.payload)).toBe(true);
  });

  it("fails closed when an approved id is missing or its identity changed", async () => {
    const missingStates = new Map<string, LaraTrustPageState>([
      [LARA_TRUST_PAGE_TARGETS[0].resourceId, pageState("contact")],
    ]);
    await expect(
      prepareLaraTrustPageBatch({
        reader: memoryReader(missingStates),
        runId: RUN_ID,
        occurredAt: AT,
      }),
    ).rejects.toMatchObject({ code: "missing_page" });

    const changed = new Map<string, LaraTrustPageState>([
      [LARA_TRUST_PAGE_TARGETS[0].resourceId, pageState("contact")],
      [
        LARA_TRUST_PAGE_TARGETS[1].resourceId,
        pageState("about", { title: "Unexpected title" }),
      ],
    ]);
    await expect(
      prepareLaraTrustPageBatch({
        reader: memoryReader(changed),
        runId: RUN_ID,
        occurredAt: AT,
      }),
    ).rejects.toMatchObject({
      code: "page_identity_mismatch",
    });
  });

  it("revalidates CAS in dry-run mode and never requires a writer", async () => {
    const { states, reader, prepared } = await fixtureBatch();
    const valid = await executeLaraTrustPageBatch({ prepared, reader });
    expect(valid).toMatchObject({
      status: "dry_run_complete",
      writesAttempted: 0,
      writesCompleted: 0,
    });

    const contact = states.get(LARA_TRUST_PAGE_TARGETS[0].resourceId);
    if (!contact) throw new TypeError("Missing contact fixture.");
    states.set(contact.id, { ...contact, bodyHtml: "<p>Concurrent edit.</p>" });
    const blocked = await executeLaraTrustPageBatch({ prepared, reader });
    expect(blocked).toMatchObject({
      status: "blocked_precondition",
      writesAttempted: 0,
      blockCode: "PAGE_CAS_MISMATCH",
    });
  });

  it("requires the reviewed digest, writes only exact bodies, and preserves protected fields", async () => {
    const { states, reader, prepared } = await fixtureBatch();
    const writer = casMemoryWriter(states);

    await expect(
      executeLaraTrustPageBatch({
        prepared,
        reader,
        mode: "apply",
        writer,
        approvedPlanDigestSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "approval_digest_mismatch",
    });

    const beforeContact = pageState("contact");
    const beforeAbout = pageState("about");
    const result = await executeLaraTrustPageBatch({
      prepared,
      reader,
      mode: "apply",
      writer,
      approvedPlanDigestSha256: prepared.plan.digestSha256,
    });

    expect(result).toMatchObject({
      status: "apply_complete",
      writesAttempted: 2,
      writesCompleted: 2,
      rollbacksAttempted: 0,
    });
    expect(writer.replaceBodyIfUnchanged).toHaveBeenCalledTimes(2);
    expect(writer.replaceBodyIfUnchanged.mock.calls.map(([command]) => command.bodyHtml)).toEqual([
      LARA_CONTACT_PAGE_BODY_HTML,
      LARA_ABOUT_PAGE_BODY_HTML,
    ]);
    const afterContact = states.get(beforeContact.id);
    const afterAbout = states.get(beforeAbout.id);
    expect(afterContact).toMatchObject({
      title: beforeContact.title,
      handle: beforeContact.handle,
      templateSuffix: beforeContact.templateSuffix,
      isPublished: beforeContact.isPublished,
      publishedAt: beforeContact.publishedAt,
      bodyHtml: LARA_CONTACT_PAGE_BODY_HTML,
    });
    expect(afterAbout).toMatchObject({
      title: beforeAbout.title,
      handle: beforeAbout.handle,
      templateSuffix: beforeAbout.templateSuffix,
      isPublished: beforeAbout.isPublished,
      publishedAt: beforeAbout.publishedAt,
      bodyHtml: LARA_ABOUT_PAGE_BODY_HTML,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("restores the first exact body when the second write fails", async () => {
    const { states, reader, prepared } = await fixtureBatch();
    const originalContact = pageState("contact").bodyHtml;
    const writer = casMemoryWriter(states, {
      failResourceId: LARA_TRUST_PAGE_TARGETS[1].resourceId,
    });

    const result = await executeLaraTrustPageBatch({
      prepared,
      reader,
      mode: "apply",
      writer,
      approvedPlanDigestSha256: prepared.plan.digestSha256,
    });

    expect(result).toMatchObject({
      status: "apply_failed_rolled_back",
      writesAttempted: 2,
      writesCompleted: 1,
      rollbacksAttempted: 1,
      rollbacksCompleted: 1,
      blockedOperationId: "lara-about-trust-copy",
      blockCode: "WRITER_SIMULATED",
    });
    expect(states.get(LARA_TRUST_PAGE_TARGETS[0].resourceId)?.bodyHtml).toBe(
      originalContact,
    );
    expect(writer.replaceBodyIfUnchanged).toHaveBeenCalledTimes(3);
  });

  it("reads back and restores a write when the adapter loses its response", async () => {
    const { states, reader, prepared } = await fixtureBatch();
    const originalContact = pageState("contact").bodyHtml;
    const writer = casMemoryWriter(states, {
      throwAfterResourceId: LARA_TRUST_PAGE_TARGETS[0].resourceId,
    });

    const result = await executeLaraTrustPageBatch({
      prepared,
      reader,
      mode: "apply",
      writer,
      approvedPlanDigestSha256: prepared.plan.digestSha256,
    });

    expect(result).toMatchObject({
      status: "apply_failed_rolled_back",
      writesAttempted: 1,
      writesCompleted: 0,
      rollbacksAttempted: 1,
      rollbacksCompleted: 1,
      blockCode: "WRITER_ADAPTER_THROW",
    });
    expect(states.get(LARA_TRUST_PAGE_TARGETS[0].resourceId)?.bodyHtml).toBe(
      originalContact,
    );
  });

  it("keeps navigation out of the mutation plan until exact menus are captured", () => {
    expect(LARA_TRUST_NAVIGATION_ASSESSMENT).toMatchObject({
      status: "blocked_missing_exact_snapshot",
      candidateMenus: ["footer", "main"],
      desiredLinks: [
        { resourceId: LARA_TRUST_PAGE_TARGETS[0].resourceId },
        { resourceId: LARA_TRUST_PAGE_TARGETS[1].resourceId },
      ],
    });
    expect(LARA_TRUST_NAVIGATION_ASSESSMENT.requiredBeforePlanning).toHaveLength(4);
  });
});
