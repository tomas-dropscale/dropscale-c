import type { Metadata } from "next";
import { Info } from "lucide-react";

import { PnlScopeControls } from "@/components/admin/pnl-scope-controls";
import { MixedCurrencyNotice } from "@/components/portal/mixed-currency-notice";
import { PnlSheetView } from "@/components/portal/pnl-sheet";
import { PageContainer } from "@/components/ui/page-container";
import {
  clampPnlPeriod,
  currentPnlPeriod,
  fetchAdminClientPnl,
  listAdminPnlClients,
  PNL_YEARS_BACK,
} from "@/lib/admin/client-pnl";
import { pnlHref } from "@/lib/admin/pnl-href";
import { money } from "@/lib/format";
import { intlLocale } from "@/lib/i18n";
import { getServerDictionary } from "@/lib/i18n/server";
import { displayCurrency } from "@/lib/portal/currency";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: "Client P&L · Dropscale IO" };
}

type PnlSearchParams = {
  client?: string | string[];
  store?: string | string[];
  year?: string | string[];
  month?: string | string[];
};

function singleParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

/**
 * A client's P&L as the client sees it, one month per view, for any client.
 *
 * Period, client and store live in the URL so every view is a link. The sheet
 * is the portal's own: same stores, same scope, same builder, same columns,
 * same running total - so what we read here is exactly what the client reads
 * there.
 */
export default async function AdminPnlPage({
  searchParams,
}: {
  searchParams: Promise<PnlSearchParams>;
}) {
  const params = await searchParams;
  // The month opens on the Lisbon business day, the clock the rows are keyed to.
  const now = new Date();
  const today = currentPnlPeriod(now);
  const { year, month } = clampPnlPeriod(
    Number(singleParam(params.year) ?? today.year),
    Number(singleParam(params.month) ?? today.month),
    now,
  );
  // Reauthenticates the admin before any cross-client read is constructed.
  const [clients, { d, locale }] = await Promise.all([
    listAdminPnlClients(),
    getServerDictionary(),
  ]);
  const intl = intlLocale(locale);
  const requestedClientId = singleParam(params.client);
  const selectedClient = clients.find((client) => client.id === requestedClientId) ?? null;
  const requestedStoreId = singleParam(params.store);

  const pnl = selectedClient
    ? await fetchAdminClientPnl({
        clientId: selectedClient.id,
        storeId: requestedStoreId,
        year,
        month,
      })
    : null;

  const years = Array.from({ length: PNL_YEARS_BACK + 1 }, (_, index) => today.year - index)
    .reverse();
  const hrefFor = (next: { year?: number; month?: number }) =>
    pnlHref({
      clientId: selectedClient?.id ?? null,
      storeId: pnl?.storeId ?? null,
      year: next.year ?? year,
      month: next.month ?? month,
    });

  return (
    <PageContainer
      title="Client P&L"
      description="Each client's profit and loss, exactly as they see it in their own portal - so we know how their money is doing."
      actions={
        <PnlScopeControls
          clients={clients}
          clientId={selectedClient?.id ?? null}
          stores={pnl?.stores ?? []}
          storeId={pnl?.storeId ?? null}
          year={year}
          month={month}
        />
      }
    >
      {!selectedClient ? (
        <p className="text-[12.5px] text-[var(--text-secondary)]">
          {requestedClientId
            ? "That client has no store to read a P&L for. Choose an available client."
            : "Choose a client to read their P&L."}
        </p>
      ) : !pnl ? (
        <p className="text-[12.5px] text-[var(--text-secondary)]">
          {requestedStoreId
            ? "That store does not belong to this client. Choose one of their stores, or every store."
            : "This client’s portal is unavailable right now."}
        </p>
      ) : (
        <>
          {pnl.stores.length === 0 && (
            <p className="mb-4 text-[12.5px] text-[var(--text-secondary)]">
              This client’s portal shows no store yet, so their P&L is the empty sheet below.
            </p>
          )}
          <MixedCurrencyNotice scope={pnl.currencies} className="mb-4" />
          {pnl.hasUnallocatedGoogle && (
            <div className="mb-4 flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--accent-gold)]/25 bg-[var(--accent-gold)]/8 px-4 py-3">
              <Info className="mt-0.5 size-4 shrink-0 text-[var(--accent-gold)]" aria-hidden />
              <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                <span className="font-semibold text-[var(--text-primary)]">
                  {d.portal.unallocatedGoogleSpend}: {money(pnl.unallocatedSpend, displayCurrency(pnl.currencies))}.
                </span>{" "}
                {d.portal.unallocatedGooglePnlWarning}
              </p>
            </div>
          )}
          <PnlSheetView
            d={d}
            intl={intl}
            sheet={pnl.sheet}
            currency={displayCurrency(pnl.currencies)}
            year={year}
            month={month}
            years={years}
            hrefFor={hrefFor}
          />
        </>
      )}
    </PageContainer>
  );
}
