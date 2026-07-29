/**
 * Everything clients have handed in, grouped the way the work actually happens:
 * client → store → batches. That is the order you need it in to sit down and
 * build campaigns, and it is why a submission hangs off an ad_account rather
 * than off a client (migration 0018) — the grouping falls out of the data
 * instead of being a field somebody has to fill in correctly.
 *
 * Reads ride the admin RLS policies (is_admin()); a non-admin gets nothing.
 */

import { createClient } from "@/lib/supabase/server";
import type { CreativeSubmission, CreativeSubmissionStatus } from "@/lib/supabase/types";

export type SubmissionStoreGroup = {
  accountId: string;
  storeName: string;
  submissions: CreativeSubmission[];
};

export type SubmissionClientGroup = {
  clientId: string;
  clientName: string;
  clientEmail: string;
  /** Submissions nobody has looked at yet, across this client's stores. */
  newCount: number;
  stores: SubmissionStoreGroup[];
};

export type CreativeInbox = {
  clients: SubmissionClientGroup[];
  total: number;
  newCount: number;
  /** Names of the people who submitted, by portal_clients id. */
  submitterNames: Record<string, string>;
};

const EMPTY: CreativeInbox = { clients: [], total: 0, newCount: 0, submitterNames: {} };

export async function fetchCreativeInbox(
  status: CreativeSubmissionStatus | "all" = "all",
): Promise<CreativeInbox> {
  const supabase = await createClient();

  let query = supabase
    .from("creative_submissions")
    .select("*")
    .order("created_at", { ascending: false });
  if (status !== "all") query = query.eq("status", status);

  const { data: rows } = await query;
  const submissions = (rows as CreativeSubmission[] | null) ?? [];
  if (submissions.length === 0) return EMPTY;

  // The stores they belong to, and through those the owning client.
  const accountIds = [...new Set(submissions.map((row) => row.ad_account_id))];
  const { data: accounts } = await supabase
    .from("ad_accounts")
    .select("id, store_name, client_id")
    .in("id", accountIds);

  // Owners plus everyone who submitted — one query, because a sócio who handed
  // work in is not necessarily the owner of the workspace it landed in.
  const ownerIds = (accounts ?? []).map((account) => account.client_id);
  const submitterIds = submissions
    .map((row) => row.submitted_by)
    .filter((id): id is string => id !== null);
  const peopleIds = [...new Set([...ownerIds, ...submitterIds])];
  const { data: people } = await supabase
    .from("portal_clients")
    .select("id, full_name, email")
    .in("id", peopleIds);

  const person = new Map((people ?? []).map((row) => [row.id, row]));
  const account = new Map((accounts ?? []).map((row) => [row.id, row]));

  // client → store → submissions, insertion-ordered so the newest submission
  // pulls its client and store to the top without a second sort.
  const byClient = new Map<string, SubmissionClientGroup>();

  for (const submission of submissions) {
    const store = account.get(submission.ad_account_id);
    if (!store) continue; // store deleted mid-read; the cascade will follow

    const owner = person.get(store.client_id);
    const group = byClient.get(store.client_id) ?? {
      clientId: store.client_id,
      clientName: owner?.full_name ?? "Unknown client",
      clientEmail: owner?.email ?? "",
      newCount: 0,
      stores: [],
    };

    let storeGroup = group.stores.find((entry) => entry.accountId === store.id);
    if (!storeGroup) {
      storeGroup = { accountId: store.id, storeName: store.store_name, submissions: [] };
      group.stores.push(storeGroup);
    }
    storeGroup.submissions.push(submission);
    if (submission.status === "new") group.newCount += 1;

    byClient.set(store.client_id, group);
  }

  const submitterNames: Record<string, string> = {};
  for (const id of submitterIds) {
    const name = person.get(id)?.full_name;
    if (name) submitterNames[id] = name;
  }

  return {
    clients: [...byClient.values()],
    total: submissions.length,
    newCount: submissions.filter((row) => row.status === "new").length,
    submitterNames,
  };
}

/** Unreviewed submissions, for the sidebar badge. Cheap: count only. */
export async function countNewSubmissions(): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase
    .from("creative_submissions")
    .select("id", { count: "exact", head: true })
    .eq("status", "new");
  return count ?? 0;
}
