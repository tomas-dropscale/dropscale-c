import { NextResponse, type NextRequest } from "next/server";
import { getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { isExactRecord, readSmallJson } from "@/lib/client-onboarding/http";
import { DIOGO_CLOSING_CORRECTION as correction } from "@/lib/billing/reviewed-corrections";
import { acquireBillingIssueLease, renewBillingIssueLease, releaseBillingIssueLease } from "@/lib/billing/issue-lease";
import { authoritativeInvoiceUpdate, creditUnpaidInvoice, getStripeAccountId, StripeError } from "@/lib/stripe/client";

export const dynamic = "force-dynamic";
const respond = (value: unknown, status = 200) => NextResponse.json(value, {
  status, headers: { "Cache-Control": "private, no-store" },
});

export async function POST(request: NextRequest) {
  const { user, profile } = await getSessionProfile();
  if (!user || profile?.role !== "admin") return respond({ error: "Sem acesso." }, 403);
  if (request.headers.get("origin") !== request.nextUrl.origin) return respond({ error: "Origem inválida." }, 403);
  let body: unknown;
  try { body = await readSmallJson(request, 1024); } catch { return respond({ error: "Pedido inválido." }, 400); }
  if (!isExactRecord(body, ["correctionId", "apply"]) || body.correctionId !== correction.id || typeof body.apply !== "boolean") {
    return respond({ error: "Correção não reconhecida." }, 400);
  }
  const service = createServiceClient();
  if (!service) return respond({ error: "Faturação indisponível." }, 503);
  const lease = await acquireBillingIssueLease(service, {
    clientId: correction.clientId, periodStart: correction.periodStart, issuedBy: profile.id,
  });
  if (!lease) return respond({ error: "Existe outra operação de faturação em curso." }, 409);
  try {
    const { data: local, error } = await service.from("invoices").select("*").eq("id", correction.invoiceId).single();
    const { data: client, error: clientError } = await service.from("portal_clients").select("stripe_customer_id").eq("id", correction.clientId).single();
    if (error || clientError || !local || !client?.stripe_customer_id) throw new Error("Não foi possível verificar a fatura e o cliente.");
    if (local.client_id !== correction.clientId || local.stripe_invoice_id !== correction.stripeInvoiceId ||
        Math.round(Number(local.amount) * 100) !== correction.originalCents || local.currency !== "EUR" ||
        local.period_start !== correction.periodStart || local.period_end !== correction.periodEnd || local.status !== "open") {
      throw new StripeError("A fatura mudou desde a revisão. Não foi alterada.", 409);
    }
    const lines = local.line_items as { kind: string; accountId: string | null; amount: number; label: string }[];
    const fee = lines.filter(line => line.kind === "fee" && line.accountId === correction.accountId && Math.round(line.amount * 100) === correction.feeCents);
    if (lines.length !== 2 || fee.length !== 1 || !lines.some(line => line.kind === "arrears" && Math.round(line.amount * 100) === correction.arrearsCents)) {
      throw new StripeError("As linhas da fatura diferem das aprovadas.", 409);
    }
    if (await getStripeAccountId() !== correction.stripeAccountId) throw new StripeError("A conta Stripe não é a DROPSCALE LLC aprovada.", 409);
    const result = await creditUnpaidInvoice({
      expected: { localInvoiceId: local.id, stripeInvoiceId: local.stripe_invoice_id, customerId: client.stripe_customer_id,
        currency: local.currency, amount: Number(local.amount), requireMetadata: true, requireManualCollection: true },
      correctionId: correction.id, targetCents: correction.targetCents, lineAmountCents: correction.feeCents,
      lineDescription: fee[0].label, memo: correction.memo, reviewedBy: profile.id, apply: body.apply,
      assertLeaseOwnership: () => renewBillingIssueLease(service, lease),
    });
    if (result.applied) {
      const update = authoritativeInvoiceUpdate(result.invoice, "invoice.updated", Math.floor(Date.now() / 1000));
      const { data: saved, error: saveError } = await service.from("invoices").update(update)
        .eq("id", local.id).eq("stripe_invoice_id", correction.stripeInvoiceId).eq("status", "open").select("id").maybeSingle();
      if (saveError || !saved) throw new Error("Nota de crédito emitida; falta reconciliar o saldo local. Não emitir outra nota.");
    }
    return respond({ applied: result.applied, account: "DROPSCALE LLC", invoiceNumber: result.invoice.number,
      originalCents: correction.originalCents, targetCents: correction.targetCents,
      remainingCents: result.invoice.amount_remaining, creditCents: result.credit.amount,
      creditNumber: result.applied ? result.credit.number : null, creditPdf: result.applied ? result.credit.pdf : null,
      hostedUrl: result.invoice.hosted_invoice_url });
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : "Não foi possível concluir a correção." }, error instanceof StripeError ? error.status : 500);
  } finally {
    await releaseBillingIssueLease(service, lease);
  }
}
