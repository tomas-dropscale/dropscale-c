import type { CreativeInbox } from "@/lib/admin/creatives";
import type { CreativeSubmission } from "@/lib/supabase/types";

export type CreativeInboxFilter = "all" | "new" | "in_use" | "rejected";

export type CreativeInboxRow = {
  submission: CreativeSubmission;
  clientId: string;
  clientName: string;
  clientEmail: string;
  accountId: string;
  storeName: string;
  submitterName: string;
};

export type CreativeInboxClientGroup = {
  clientId: string;
  clientName: string;
  clientEmail: string;
  rows: CreativeInboxRow[];
  counts: {
    total: number;
    new: number;
    in_use: number;
    rejected: number;
  };
};

export function flattenCreativeInbox(inbox: CreativeInbox): CreativeInboxRow[] {
  return inbox.clients
    .flatMap((client) =>
      client.stores.flatMap((store) =>
        store.submissions.map((submission) => ({
          submission,
          clientId: client.clientId,
          clientName: client.clientName,
          clientEmail: client.clientEmail,
          accountId: store.accountId,
          storeName: store.storeName,
          submitterName: submission.submitted_by
            ? (inbox.submitterNames[submission.submitted_by] ?? "")
            : "",
        })),
      ),
    )
    .sort(
      (left, right) =>
        Date.parse(right.submission.created_at) - Date.parse(left.submission.created_at),
    );
}

function searchableText(row: CreativeInboxRow): string {
  const { submission } = row;
  return [
    submission.title,
    submission.url,
    submission.collection_url,
    submission.notes,
    submission.review_notes,
    row.clientName,
    row.clientEmail,
    row.storeName,
    row.submitterName,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .trim();
}

export function filterCreativeInboxRows(
  rows: CreativeInboxRow[],
  { status, query }: { status: CreativeInboxFilter; query: string },
): CreativeInboxRow[] {
  const normalizedQuery = normalizeSearch(query);
  return rows.filter(
    (row) =>
      (status === "all" || row.submission.status === status) &&
      (!normalizedQuery || normalizeSearch(searchableText(row)).includes(normalizedQuery)),
  );
}

export function groupCreativeInboxRows(
  rows: CreativeInboxRow[],
): CreativeInboxClientGroup[] {
  const groups = new Map<string, CreativeInboxClientGroup>();

  for (const row of [...rows].sort(
    (left, right) =>
      Date.parse(right.submission.created_at) - Date.parse(left.submission.created_at),
  )) {
    let group = groups.get(row.clientId);
    if (!group) {
      group = {
        clientId: row.clientId,
        clientName: row.clientName,
        clientEmail: row.clientEmail,
        rows: [],
        counts: { total: 0, new: 0, in_use: 0, rejected: 0 },
      };
      groups.set(row.clientId, group);
    }

    group.rows.push(row);
    group.counts.total += 1;
    group.counts[row.submission.status] += 1;
  }

  return [...groups.values()];
}
