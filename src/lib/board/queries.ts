import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Board,
  CardWithAssignees,
  ColumnWithCards,
  Database,
  Profile,
} from "@/lib/supabase/types";

export type BoardSnapshot = {
  board: Board | null;
  columns: ColumnWithCards[];
  members: Profile[];
  /** Comment count per card — shown in each card's footer. */
  commentCounts: Record<string, number>;
};

type Client = SupabaseClient<Database>;

/**
 * Reads the whole board in one pass. Used on the server (first render) and on
 * the client (refresh after mutations and realtime events), so it takes the
 * Supabase client rather than creating one.
 */
export async function fetchBoardSnapshot(supabase: Client): Promise<BoardSnapshot> {
  const [{ data: board }, { data: members }] = await Promise.all([
    supabase.from("boards").select("*").order("created_at").limit(1).maybeSingle(),
    supabase.from("profiles").select("*").order("full_name"),
  ]);

  if (!board) {
    return { board: null, columns: [], members: members ?? [], commentCounts: {} };
  }

  const { data: columns } = await supabase
    .from("board_columns")
    .select("*")
    .eq("board_id", board.id)
    .order("position");

  const columnIds = (columns ?? []).map((column) => column.id);

  const { data: cards } = columnIds.length
    ? await supabase
        .from("cards")
        .select("*, card_assignees(user_id), card_comments(id)")
        .in("column_id", columnIds)
        .order("position")
    : { data: [] };

  const membersById = new Map((members ?? []).map((member) => [member.id, member]));

  const commentCounts: Record<string, number> = {};

  const hydrated: CardWithAssignees[] = (cards ?? []).map((row) => {
    const { card_assignees, card_comments, ...card } = row;
    commentCounts[card.id] = card_comments?.length ?? 0;

    return {
      ...card,
      labels: card.labels ?? [],
      assignees: (card_assignees ?? [])
        .map((link) => membersById.get(link.user_id))
        .filter((member): member is Profile => Boolean(member)),
    };
  });

  return {
    board,
    members: members ?? [],
    commentCounts,
    columns: (columns ?? []).map((column) => ({
      ...column,
      cards: hydrated.filter((card) => card.column_id === column.id),
    })),
  };
}
