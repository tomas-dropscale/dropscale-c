/**
 * The admin P&L's URL is its state: client, store and period all live in the
 * query string, so every view is a link and the back button works. Shared by
 * the server page and the client-side scope controls, hence a plain module.
 */
export function pnlHref(next: {
  clientId?: string | null;
  storeId?: string | null;
  year?: number;
  month?: number;
}): string {
  const query = new URLSearchParams();
  if (next.clientId) query.set("client", next.clientId);
  if (next.storeId) query.set("store", next.storeId);
  if (next.year) query.set("year", String(next.year));
  if (next.month) query.set("month", String(next.month));
  const text = query.toString();
  return text ? `/admin/pnl?${text}` : "/admin/pnl";
}
