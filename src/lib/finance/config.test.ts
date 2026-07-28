import { describe, expect, it } from "vitest";
import { commissionClientLabel, noteClientName } from "./config";
import type { CrmClient } from "@/lib/supabase/types";

/**
 * Attribution: which client a commission row belongs to.
 *
 * A synced row usually has no `client_id` — that column points at the CRM
 * `clients` table and nothing links a portal client to one — so the note is
 * where the name lives. Getting this wrong is what made every euro of Google
 * revenue read as "Unattributed" on the finance overview.
 */

const clients: CrmClient[] = [
  {
    id: "crm-1",
    name: "Bruno",
    email: null,
    status: "active",
    notes: null,
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
  },
];

describe("noteClientName", () => {
  it.each([
    ["HST, name alone", "HST · Bruno", "Bruno"],
    ["Google Ads, name then store", "Google Ads · Di Pati — Velas Premium", "Di Pati"],
    ["revenue share", "Revenue share · Di Pati — Velas Premium", "Di Pati"],
    ["a name containing a dot separator", "HST · Silva · Costa", "Silva · Costa"],
  ])("reads the client from %s", (_label, notes, expected) => {
    expect(noteClientName(notes)).toBe(expected);
  });

  it.each([
    ["a hand-written note", "Paid by transfer"],
    ["the old auto-synced format", "Auto-synced from Google Ads · Velas Premium"],
    ["nothing", null],
    ["a prefix with no name after it", "HST · "],
  ])("names nobody for %s", (_label, notes) => {
    expect(noteClientName(notes)).toBeNull();
  });

  it("does not mistake the store for the client when the name is missing", () => {
    // What noteFor() writes when the portal client can't be resolved.
    expect(noteClientName("Google Ads · — Velas Premium")).toBeNull();
  });
});

describe("commissionClientLabel", () => {
  it("prefers the linked CRM record over the note", () => {
    expect(
      commissionClientLabel({ client_id: "crm-1", notes: "HST · Someone Else" }, clients, "—"),
    ).toBe("Bruno");
  });

  it("falls back to the note when nothing is linked", () => {
    expect(
      commissionClientLabel(
        { client_id: null, notes: "Google Ads · Di Pati — Velas Premium" },
        clients,
        "Unattributed",
      ),
    ).toBe("Di Pati");
  });

  it("only says Unattributed when the row truly names nobody", () => {
    expect(
      commissionClientLabel({ client_id: null, notes: "Paid by transfer" }, clients, "Unattributed"),
    ).toBe("Unattributed");
  });
});
