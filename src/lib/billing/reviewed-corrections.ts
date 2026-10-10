import "server-only";

/** Explicitly reviewed closing-invoice adjustments. No automatic recalculation. */
export const DIOGO_CLOSING_CORRECTION = {
  id: "diogo-patricia-service-end-2026-09-29-v1",
  clientId: "927cbac3-8121-456b-9d19-1e7d5c62184a",
  invoiceId: "4bd82b76-4031-429d-ad41-6733881aea06",
  stripeInvoiceId: "in_1UNCpI1KRm9v1VRqg1iSHEd8",
  stripeAccountId: "acct_1UGihQ1KRm9v1VRq",
  accountId: "a572fc2c-82b3-413d-a085-c42cc35f2f2d",
  periodStart: "2026-09-28",
  periodEnd: "2026-10-04",
  lastServiceDay: "2026-09-29",
  originalCents: 8027,
  targetCents: 6960,
  feeCents: 2783,
  arrearsCents: 5244,
  memo: "Fim do serviço em 29/09/2026, inclusive. Comissão de 28–29/09 corrigida de 27,83 € para 17,16 €. Saldo de 21–27/09: 52,44 €. Total a pagar após esta nota de crédito: 69,60 €.",
} as const;
