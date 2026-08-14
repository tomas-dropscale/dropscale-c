import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATIONS = "supabase/migrations";

const LIVE_BILLING_MIGRATIONS = {
  "0034_reviewed_full_day_billing_starts.sql":
    "ce8c8f022243f87d3fce76559a536898b86d998c5fc09ebcd19cf478c723e7fe",
  "0035_historical_full_day_rollover.sql":
    "65c8a027d86ed93384beddb376f106e1e52af4779888a445c820a98f244a5284",
  "0036_billing_automation_receipts.sql":
    "6f829a7ec69510538bc49ac1b97f68c915b0709fd7b36becab89e802afefb26f",
  "0037_collection_revenue_share_billing.sql":
    "c32585c762fbf7d3ff8e95f50fe65c2ce78febdaf18597a73d9ab3f9bcd0a2d9",
  "0038_billing_cycle_skips.sql":
    "03ccc8d4321bfdbcbcc90d0e951eab80f118fae3a98038343a0eaecde562345f",
  "0039_app_secrets.sql":
    "fa7dcf1c4cb16d360ecf863e7d2f27dbc6abfa82595cd29de445b86cf2516e3d",
  "0045_audit_shopify_pricing_artifacts.sql":
    "45ca51face7ef46e0e59717471c40658e5617fa5f69aab78569435865a10be6b",
} as const;

describe("production migration lineage", () => {
  it("keeps the historical SQL matched to the objects already installed live", () => {
    for (const [file, expected] of Object.entries(LIVE_BILLING_MIGRATIONS)) {
      const sql = readFileSync(`${MIGRATIONS}/${file}`);
      expect(createHash("sha256").update(sql).digest("hex"), file).toBe(
        expected,
      );
    }
  });

  it("has one local file per migration version", () => {
    const byVersion = new Map<string, string[]>();
    for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql"))) {
      const version = file.match(/^(\d+)_/)?.[1];
      expect(version, file).toBeDefined();
      byVersion.set(version!, [...(byVersion.get(version!) ?? []), file]);
    }

    expect(
      [...byVersion.entries()].filter(([, files]) => files.length !== 1),
    ).toEqual([]);
  });

  it("keeps secret-bearing Telegram SQL outside the migration chain", () => {
    expect(readdirSync(MIGRATIONS).filter((file) => /telegram/i.test(file))).toEqual(
      [],
    );

    const templates = readdirSync("supabase/manual/telegram")
      .filter((file) => file.endsWith(".sql"))
      .sort();
    expect(templates).toEqual([
      "01_admin_webhooks.sql",
      "02_partner_and_billing_events.sql",
      "03_queue_closing_events.sql",
    ]);
    for (const file of templates) {
      expect(readFileSync(`supabase/manual/telegram/${file}`, "utf8")).toContain(
        "__NOTIFY_SECRET__",
      );
    }
  });
});
