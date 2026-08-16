import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0068_system_reviewed_onboarding_sessions.sql",
  "utf8",
);

async function expectSqlState(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected SQLSTATE ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

it("allows system reviews while preserving the onboarding review shape", async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`
      create table public.client_onboarding_sessions (
        id uuid primary key,
        status text not null,
        reviewed_at timestamptz,
        reviewed_by uuid,
        constraint client_onboarding_review_shape check (
          (status not in ('reviewed', 'active') and reviewed_at is null and reviewed_by is null)
          or (status in ('reviewed', 'active') and reviewed_at is not null and reviewed_by is not null)
        )
      );
    `);
    await db.exec(MIGRATION);

    await db.query(
      `insert into public.client_onboarding_sessions (id, status, reviewed_at, reviewed_by)
       values
         ($1, 'reviewed', now(), null),
         ($2, 'active', now(), $3),
         ($4, 'collecting', null, null)`,
      [
        "68000000-0000-4000-8000-000000000001",
        "68000000-0000-4000-8000-000000000002",
        "68000000-0000-4000-8000-000000000003",
        "68000000-0000-4000-8000-000000000004",
      ],
    );

    await expectSqlState(
      db.query(
        `insert into public.client_onboarding_sessions (id, status, reviewed_at, reviewed_by)
         values ($1, 'reviewed', null, null)`,
        ["68000000-0000-4000-8000-000000000005"],
      ),
      "23514",
    );
    await expectSqlState(
      db.query(
        `insert into public.client_onboarding_sessions (id, status, reviewed_at, reviewed_by)
         values ($1, 'collecting', now(), null)`,
        ["68000000-0000-4000-8000-000000000006"],
      ),
      "23514",
    );
  } finally {
    await db.close();
  }
});
