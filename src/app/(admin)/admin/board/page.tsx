import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { BoardView } from "@/components/board/board-view";
import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { fetchBoardSnapshot } from "@/lib/board/queries";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.board.title };
}

export default async function BoardPage() {
  const { profile } = await getSessionProfile();

  // The dashboard layout already gates on role === 'admin'; this is the
  // type-level counterpart of that guard, not a second policy.
  if (!profile) redirect("/login");

  const supabase = await createClient();
  const snapshot = await fetchBoardSnapshot(supabase);

  return <BoardView snapshot={snapshot} currentUser={profile} />;
}
