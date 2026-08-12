import type { AuditConnectionDTO } from "@/lib/audit/connections";

export type AuditConnectionSummary = {
  connected: number;
  waiting: number;
  waitingOnReviews: number;
};

export function visibleAuditConnections(
  connections: AuditConnectionDTO[],
): AuditConnectionDTO[] {
  return connections.filter((connection) => connection.status !== "revoked");
}

export function getAuditConnectionSummary(
  connections: AuditConnectionDTO[],
): AuditConnectionSummary {
  const visible = visibleAuditConnections(connections);

  return {
    connected: visible.filter((connection) => connection.status === "connected").length,
    waiting: visible.filter((connection) => connection.status === "waiting").length,
    waitingOnReviews: visible.filter((connection) => connection.needsReview).length,
  };
}
