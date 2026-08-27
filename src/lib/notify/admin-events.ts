import "server-only";

// Relative, not aliased: this module is unit-tested and the suite runs without
// a path-alias config, the same reason lib/billing/review-token.ts does it.
import { escapeHtml } from "./telegram";

/**
 * Turns a Supabase Database Webhook payload into the message the team gets on
 * their phone.
 *
 * Two families of event, and the difference matters:
 *
 *   Creations  — a row appears in the approval queue. These mirror the admin
 *                bell (notifications-menu.tsx) exactly; if a row is added there,
 *                add it here too or the badge and the phone start disagreeing.
 *
 *   Transitions — a row changes into a state worth announcing (an invite is
 *                accepted, an invoice is paid). These fire on UPDATE, and ONLY
 *                when the field actually crosses into the interesting value.
 *                Invoices in particular are rewritten often by Stripe
 *                reconciliation, and announcing every write would train the
 *                team to ignore the channel.
 *
 * Message shape is fixed at three lines, because the first is all a locked
 * phone shows:
 *
 *   <emoji> <b>Short title</b>
 *   the identifying facts · joined by middots
 *   <a>Action →</a>              (omitted when there is nothing to do)
 */

/** What Supabase POSTs. `old_record` is null on INSERT. */
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
  "client_invites",
  "invoices",
  "ad_account_billing_starts",
] as const;

export type NotifiedTable = (typeof NOTIFIED_TABLES)[number];

export function isNotifiedTable(table: string): table is NotifiedTable {
  return (NOTIFIED_TABLES as readonly string[]).includes(table);
}

type Row = Record<string, unknown>;

/**
 * Names for the ids a payload references, looked up by the caller.
 *
 * Rows carry uuids, and "aprovado por 3f2a…" tells nobody anything. Resolution
 * is the route's job so this module stays pure and testable without a database;
 * when a name is missing the message simply omits the attribution rather than
 * printing a uuid.
 */
export type ResolvedNames = {
  profiles?: Record<string, string>;
  accounts?: Record<string, string>;
};

/** Which ids this payload would like resolved, so the route can fetch them. */
export function lookupsFor(payload: WebhookPayload): {
  profileIds: string[];
  adAccountIds: string[];
} {
  const record = payload.record;
  if (!record) return { profileIds: [], adAccountIds: [] };

  const profileIds: string[] = [];
  const adAccountIds: string[] = [];

  if (payload.table === "portal_clients") {
    const by = str(record, "approved_by");
    if (by) profileIds.push(by);
  }

  if (payload.table === "ad_account_billing_starts") {
    const by = str(record, "reviewed_by");
    if (by) profileIds.push(by);
    const account = str(record, "ad_account_id");
    if (account) adAccountIds.push(account);
  }

  return { profileIds, adAccountIds };
}

/** "por Tomás", or nothing at all when the name could not be resolved. */
function by(id: string | null, names: ResolvedNames | undefined): string | null {
  if (!id) return null;
  const name = names?.profiles?.[id];
  return name ? `por ${escapeHtml(name)}` : null;
}

function str(record: Row, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function num(record: Row, key: string): number | null {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** Absolute, because a phone notification is useless without somewhere to go. */
function link(path: string): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://dropscale.app").replace(/\/+$/, "");
  return `${base}${path}`;
}

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

function money(amount: number, currency: string | null): string {
  const code = (currency ?? "EUR").toUpperCase();
  const value = amount.toFixed(2);
  const symbol = SYMBOLS[code];
  return symbol ? `${symbol}${value}` : `${value} ${code}`;
}

/** "2026-08-01" → "01/08". Full dates are noise when the year is obvious. */
function shortDay(iso: string | null): string | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[3]}/${match[2]}` : null;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function compose(parts: {
  emoji: string;
  title: string;
  facts: (string | null)[];
  action?: { label: string; href: string };
}): string {
  const lines = [`${parts.emoji} <b>${parts.title}</b>`];

  const facts = parts.facts.filter((fact): fact is string => Boolean(fact));
  if (facts.length > 0) lines.push(facts.join(" · "));

  if (parts.action) {
    lines.push(`<a href="${link(parts.action.href)}">${parts.action.label} →</a>`);
  }

  return lines.join("\n");
}

/** True when `field` was something else before and is `value` now. */
function became(payload: WebhookPayload, field: string, value: string): boolean {
  const now = payload.record ? str(payload.record, field) : null;
  const before = payload.old_record ? str(payload.old_record, field) : null;
  return now === value && before !== value;
}

/**
 * The message, or null when this payload isn't worth a notification.
 *
 * Null is the common case and not an error. Supabase webhooks fire per row
 * change; only the ones that need a human should reach a phone. A row inserted
 * already-approved, or an invoice whose Stripe metadata was refreshed, are both
 * real events and neither is news.
 */
export function formatAdminEvent(
  payload: WebhookPayload,
  names?: ResolvedNames,
): string | null {
  const record = payload.record;
  if (!record) return null;

  const isInsert = payload.type === "INSERT";

  switch (payload.table) {
    // ---- creations: the approval queue --------------------------------
    case "portal_clients": {
      const name = str(record, "full_name");

      if (isInsert) {
        if (str(record, "approval_status") !== "pending") return null;
        const email = str(record, "email");
        return compose({
          emoji: "👤",
          title: "Cliente novo",
          facts: [name ? escapeHtml(name) : null, email ? escapeHtml(email) : null],
          action: { label: "Aprovar", href: "/admin/client-onboarding" },
        });
      }

      // The closing half of the queue. This is the one place a notification
      // about the team's OWN action earns its keep: it tells everyone else the
      // item is handled and by whom, which is what stops two people working the
      // same queue.
      const actor = by(str(record, "approved_by"), names);

      if (became(payload, "approval_status", "approved")) {
        return compose({
          emoji: "✅",
          title: "Cliente aprovado",
          facts: [name ? escapeHtml(name) : null, actor],
        });
      }

      if (became(payload, "approval_status", "rejected")) {
        return compose({
          emoji: "🚫",
          title: "Cliente rejeitado",
          facts: [name ? escapeHtml(name) : null, actor],
        });
      }

      return null;
    }

    // The team confirmed agency access and captured Google's opening counter —
    // the irreversible step that starts billing for this store.
    case "ad_account_billing_starts": {
      if (!isInsert) return null;
      const accountId = str(record, "ad_account_id");
      const store = accountId ? names?.accounts?.[accountId] : null;
      return compose({
        emoji: "🚀",
        title: "Loja verificada",
        facts: [store ? escapeHtml(store) : null, by(str(record, "reviewed_by"), names)],
        action: { label: "Ver operações", href: "/admin/billing#financial-operations" },
      });
    }

    case "ad_accounts": {
      if (!isInsert || str(record, "status") !== "pending") return null;
      // A normalized reporting account is provisioned pending by the V2
      // lifecycle and leaves that state when its billing baseline starts, not
      // when a person acts. Announcing it as a store to activate interrupted
      // the team for work that was never theirs, and pointed them at a page
      // with nothing on it to click.
      if (str(record, "reporting_role") !== "legacy_hybrid") return null;
      const store = str(record, "store_name");
      const customerId = str(record, "google_ads_customer_id");
      return compose({
        emoji: "🏪",
        title: "Loja por ativar",
        facts: [
          store ? escapeHtml(store) : null,
          customerId ? `<code>${escapeHtml(customerId)}</code>` : "sem ID Google",
        ],
        action: { label: "Verificar Google", href: "/admin/billing#financial-operations" },
      });
    }

    case "account_requests": {
      if (!isInsert || str(record, "status") !== "pending") return null;
      const isGoogle = str(record, "request_type") === "google_ads";
      const store = str(record, "store_name");
      const customerId = str(record, "google_ads_customer_id");
      const shop = str(record, "myshopify_url");
      const code = str(record, "shopify_collaborator_code");
      return compose({
        emoji: "🎫",
        title: isGoogle ? "Pedido Google Ads" : "Pedido Shopify",
        facts: isGoogle
          ? [
              store ? escapeHtml(store) : null,
              customerId ? `<code>${escapeHtml(customerId)}</code>` : null,
            ]
          : [
              shop ? escapeHtml(shop) : null,
              code ? `código <code>${escapeHtml(code)}</code>` : null,
            ],
        action: { label: "Ver pedido", href: "/admin/billing#financial-operations" },
      });
    }

    case "creative_submissions": {
      if (!isInsert || str(record, "status") !== "new") return null;
      const title = str(record, "title");
      const notes = str(record, "notes");
      return compose({
        emoji: "🎬",
        title: "Criativos entregues",
        facts: [
          title ? escapeHtml(title) : null,
          notes ? escapeHtml(truncate(notes, 90)) : null,
        ],
        action: { label: "Rever", href: "/admin/creatives?status=new" },
      });
    }

    // ---- partners: informational, no action the team owes -------------
    case "client_invites": {
      const email = str(record, "email");

      if (isInsert) {
        return compose({
          emoji: "🤝",
          title: "Sócio convidado",
          facts: [email ? escapeHtml(email) : null, "à espera do primeiro acesso"],
        });
      }

      // The invite turning into real access — the half that actually confirms
      // the sócio got in, which the invite alone never tells you.
      if (became(payload, "status", "accepted")) {
        return compose({
          emoji: "🤝",
          title: "Sócio entrou",
          facts: [email ? escapeHtml(email) : null],
        });
      }

      return null;
    }

    // ---- billing: transitions only ------------------------------------
    case "invoices": {
      const amount = num(record, "amount");
      const currency = str(record, "currency");
      const total = amount !== null ? money(amount, currency) : null;

      if (became(payload, "status", "paid")) {
        return compose({
          emoji: "✅",
          title: "Fatura paga",
          facts: [total, str(record, "stripe_invoice_number")],
          action: { label: "Ver faturação", href: "/admin/billing" },
        });
      }

      // Issued is the moment it reaches the client, and issued_at is what
      // records it — status alone also moves for reasons nobody needs to hear
      // about.
      const issuedNow = str(record, "issued_at");
      const issuedBefore = payload.old_record ? str(payload.old_record, "issued_at") : null;
      if (issuedNow && !issuedBefore) {
        const from = shortDay(str(record, "period_start"));
        const to = shortDay(str(record, "period_end"));
        return compose({
          emoji: "🧾",
          title: "Fatura emitida",
          facts: [total, from && to ? `${from}–${to}` : null],
          action: { label: "Ver faturação", href: "/admin/billing" },
        });
      }

      return null;
    }

    default:
      return null;
  }
}
