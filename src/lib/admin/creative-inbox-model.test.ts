import { describe, expect, it } from "vitest";

import type { CreativeInbox } from "./creatives";
import {
  filterCreativeInboxRows,
  flattenCreativeInbox,
  groupCreativeInboxRows,
} from "./creative-inbox-model";
import type { CreativeSubmission, CreativeSubmissionStatus } from "../supabase/types";

function submission(
  id: string,
  status: CreativeSubmissionStatus,
  createdAt: string,
  overrides: Partial<CreativeSubmission> = {},
): CreativeSubmission {
  return {
    id,
    ad_account_id: "store-1",
    submitted_by: "submitter-1",
    title: `Creative ${id}`,
    url: `https://drive.example/${id}`,
    collection_url: "https://shop.example/collections/summer",
    notes: null,
    status,
    review_notes: null,
    reviewed_at: null,
    reviewed_by: null,
    created_at: createdAt,
    ...overrides,
  };
}

const inbox: CreativeInbox = {
  total: 3,
  newCount: 1,
  submitterNames: { "submitter-1": "Tomás Alves" },
  clients: [
    {
      clientId: "client-1",
      clientName: "João Studio",
      clientEmail: "hello@joao.example",
      newCount: 1,
      stores: [
        {
          accountId: "store-1",
          storeName: "Aurélia Home",
          submissions: [
            submission("older", "new", "2026-08-11T09:00:00.000Z", {
              notes: "Blue launch batch",
            }),
            submission("newer", "in_use", "2026-08-13T09:00:00.000Z", {
              title: "Autumn hero",
              collection_url: "https://shop.example/collections/autumn",
            }),
          ],
        },
      ],
    },
    {
      clientId: "client-2",
      clientName: "Coastline",
      clientEmail: "team@coastline.example",
      newCount: 0,
      stores: [
        {
          accountId: "store-2",
          storeName: "Coast Store",
          submissions: [
            submission("middle", "rejected", "2026-08-12T09:00:00.000Z", {
              ad_account_id: "store-2",
              submitted_by: null,
              url: "https://dropbox.example/middle",
              review_notes: "Wrong aspect ratio",
            }),
          ],
        },
      ],
    },
  ],
};

describe("creative inbox model", () => {
  const rows = flattenCreativeInbox(inbox);

  it("flattens every hierarchy field and sorts submissions newest first", () => {
    expect(rows.map((row) => row.submission.id)).toEqual(["newer", "middle", "older"]);
    expect(rows[0]).toMatchObject({
      clientId: "client-1",
      clientName: "João Studio",
      clientEmail: "hello@joao.example",
      accountId: "store-1",
      storeName: "Aurélia Home",
      submitterName: "Tomás Alves",
    });
    expect(rows[1].submitterName).toBe("");
  });

  it("searches every displayed and supporting field without case or accents", () => {
    const ids = (query: string) =>
      filterCreativeInboxRows(rows, { status: "all", query }).map(
        (row) => row.submission.id,
      );

    expect(ids("  JOAO  ")).toEqual(["newer", "older"]);
    expect(ids("aurelia")).toEqual(["newer", "older"]);
    expect(ids("tomas")).toEqual(["newer", "older"]);
    expect(ids("hello@joao.example")).toEqual(["newer", "older"]);
    expect(ids("AUTUMN HERO")).toEqual(["newer"]);
    expect(ids("collections/autumn")).toEqual(["newer"]);
    expect(ids("dropbox.example")).toEqual(["middle"]);
    expect(ids("blue launch")).toEqual(["older"]);
    expect(ids("wrong aspect")).toEqual(["middle"]);
  });

  it("intersects status and search filters and returns no false match", () => {
    expect(
      filterCreativeInboxRows(rows, { status: "new", query: "aurelia" }).map(
        (row) => row.submission.id,
      ),
    ).toEqual(["older"]);
    expect(filterCreativeInboxRows(rows, { status: "rejected", query: "aurelia" })).toEqual([]);
    expect(filterCreativeInboxRows(rows, { status: "all", query: "not present" })).toEqual([]);
  });

  it("groups clients and their matching uploads from newest to oldest", () => {
    const groups = groupCreativeInboxRows([...rows].reverse());

    expect(groups.map((group) => group.clientId)).toEqual(["client-1", "client-2"]);
    expect(groups[0]).toMatchObject({
      clientId: "client-1",
      clientName: "João Studio",
      clientEmail: "hello@joao.example",
    });
    expect(groups[0].rows.map((row) => row.submission.id)).toEqual(["newer", "older"]);
    expect(groups[1].rows.map((row) => row.submission.id)).toEqual(["middle"]);
  });

  it("counts each visible status per client", () => {
    expect(groupCreativeInboxRows(rows).map(({ clientId, counts }) => ({ clientId, counts })))
      .toEqual([
        {
          clientId: "client-1",
          counts: { total: 2, new: 1, in_use: 1, rejected: 0 },
        },
        {
          clientId: "client-2",
          counts: { total: 1, new: 0, in_use: 0, rejected: 1 },
        },
      ]);
  });
});
