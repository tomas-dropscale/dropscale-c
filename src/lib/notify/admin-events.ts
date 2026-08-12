import "server-only";

// Relative, not aliased: this module is unit-tested and the suite runs without
// a path-alias config, the same reason lib/billing/review-token.ts does it.
import { escapeHtml } from "./telegram";

/**
 * Turns a Supabase Database Webhook payload into the message the team gets on
 * their phone.
 *
 * The four events mirror the admin bell exactly (notifications-menu.tsx). If a
 * row is added there, add it here too, or the badge and the phone start
 * disagreeing about what is waiting — the one thing fetchPendingCounts() was
 * written to prevent.
 */

/** What Supabase POSTs. `record` is the new row; `old_record` is null on INSERT. */
export type WebhookPayload = {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema?: string;
  record: Record<string, unknown> | null;
  old_record?: Record<string, unknown> | null;
};

const NOTIFIED_TABLES = [
  "portal_clients",
  "ad_accounts",
  "account_requests",
  "creative_submissions",
] as const;

export type NotifiedTable = (typeof NOTIFIED_TABLES)[number];

export function isNotifiedTable(table: string): table is NotifiedTable {
  return (NOTIFIED_TABLES as readonly string[]).includes(table);
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Absolute, because a phone notification is useless without somewhere to go. */
function link(path: string): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://dropscale.app").replace(/\/+$/, "");
  return `${base}${path}`;
}

function compose(parts: {
  heading: string;
  lines: (string | null)[];
  action: string;
  href: string;
}): string {
  const body = parts.lines.filter((line): line is string => line !== null);
  return [
    `<b>${parts.heading}</b>`,
    ...body,
    "",
    `<a href="${link(parts.href)}">${parts.action}</a>`,
  ].join("\n");
}

/**
 * The message, or null when this payload isn't worth a notification.
 *
 * Null is the common case and not an error: Supabase webhooks fire per row
 * change, and only the ones that actually land in the approval queue should
 * reach somebody's phone. A row inserted already-approved (an admin creating an
 * account by hand) is exactly that — real, and not news.
 */
export function formatAdminEvent(payload: WebhookPayload): string | null {
  // Only creations. An UPDATE here is usually the team's own approval, and
  // being notified about the thing you just did is how people learn to ignore
  // a channel.
  if (payload.type !== "INSERT") return null;

  const record = payload.record;
  if (!record) return null;

  switch (payload.table) {
    case "portal_clients": {
      if (str(record, "approval_status") !== "pending") return null;
      const name = str(record, "full_name");
      const email = str(record, "email");
      return compose({
        heading: "👤 Novo cliente registado",
        lines: [
          name ? escapeHtml(name) : null,
          email ? `<code>${escapeHtml(email)}</code>` : null,
        ],
        action: "Aprovar no painel",
        href: "/admin/clients",
      });
    }

    case "ad_accounts": {
      if (str(record, "status") !== "pending") return null;
      const customerId = str(record, "google_ads_customer_id");
      return compose({
        heading: "🏪 Conta de anúncios por ativar",
        lines: [
          str(record, "store_name") ? escapeHtml(str(record, "store_name")!) : null,
          customerId ? `Google Ads <code>${escapeHtml(customerId)}</code>` : "Sem ID Google Ads",
        ],
        action: "Verificar Google e iniciar tracking",
        href: "/admin/clients",
      });
    }

    case "account_requests": {
      if (str(record, "status") !== "pending") return null;
      const isGoogle = str(record, "request_type") === "google_ads";
      return compose({
        heading: isGoogle ? "🎫 Pedido de conta Google Ads" : "🎫 Pedido de ligação Shopify",
        lines: isGoogle
          ? [
              str(record, "store_name") ? escapeHtml(str(record, "store_name")!) : null,
              str(record, "google_ads_customer_id")
                ? `<code>${escapeHtml(str(record, "google_ads_customer_id")!)}</code>`
                : null,
            ]
          : [
              str(record, "myshopify_url")
                ? `<code>${escapeHtml(str(record, "myshopify_url")!)}</code>`
                : null,
              str(record, "shopify_collaborator_code")
                ? `Código de colaborador <code>${escapeHtml(str(record, "shopify_collaborator_code")!)}</code>`
                : null,
            ],
        action: "Ver o pedido",
        href: "/admin/clients",
      });
    }

    case "creative_submissions": {
      if (str(record, "status") !== "new") return null;
      return compose({
        heading: "🎬 Criativos entregues",
        lines: [
          str(record, "title") ? escapeHtml(str(record, "title")!) : null,
          str(record, "notes") ? escapeHtml(truncate(str(record, "notes")!, 160)) : null,
        ],
        action: "Rever criativos",
        href: "/admin/creatives?status=new",
      });
    }

    default:
      return null;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
