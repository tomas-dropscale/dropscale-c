import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { creditUnpaidInvoice, sendCorrectedInvoice } from "./client";

const remote = { id: "in_closing", customer: "cus_owner", currency: "eur", total: 8027,
  status: "open", amount_paid: 0, amount_remaining: 8027, livemode: true,
  collection_method: "send_invoice", auto_advance: false,
  metadata: { dropscale_invoice_id: "local" }, lines: { has_more: false, data: [
    { id: "il_fee", amount: 2783, description: "Approved fee" },
    { id: "il_arrears", amount: 5244, description: "Previous balance" },
  ] } };
const credit = { id: "cn_one", invoice: "in_closing", amount: 1067, currency: "eur", status: "issued",
  pre_payment_amount: 1067, post_payment_amount: 0, metadata: { dropscale_correction_id: "review-1" } };
const input = { expected: { localInvoiceId: "local", stripeInvoiceId: "in_closing", customerId: "cus_owner",
  currency: "EUR", amount: 80.27, requireMetadata: true, requireManualCollection: true },
  correctionId: "review-1", targetCents: 6960, lineAmountCents: 2783, lineDescription: "Approved fee",
  memo: "Service ended", reviewedBy: "admin", apply: true, assertLeaseOwnership: vi.fn(async () => {}) };
const fetcher = vi.fn();
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
beforeEach(() => { vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_unit_test"); vi.stubGlobal("fetch", fetcher); fetcher.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("reviewed unpaid-invoice credit", () => {
  it("credits only the fee line, emails once and verifies the resulting balance", async () => {
    fetcher.mockResolvedValueOnce(reply(remote)).mockResolvedValueOnce(reply({ data: [], has_more: false }))
      .mockResolvedValueOnce(reply(credit)).mockResolvedValueOnce(reply(credit))
      .mockResolvedValueOnce(reply({ ...remote, amount_remaining: 6960 }));
    const result = await creditUnpaidInvoice(input);
    expect(result.applied).toBe(true);
    const [url, options] = fetcher.mock.calls[3];
    expect(url).toMatch(/\/credit_notes$/);
    const body = new URLSearchParams(options.body);
    expect(body.get("lines[0][invoice_line_item]")).toBe("il_fee");
    expect(body.get("lines[0][amount]")).toBe("1067");
    expect(body.has("refund_amount")).toBe(false);
    expect(body.has("credit_amount")).toBe(false);
    expect(body.has("out_of_band_amount")).toBe(false);
    expect(body.get("email_type")).toBe("credit_note");
    expect(options.headers["Idempotency-Key"]).toBe("invoice-credit:review-1");
  });
  it("recovers an existing receipt without creating a second credit", async () => {
    fetcher.mockResolvedValueOnce(reply({ ...remote, amount_remaining: 6960 }))
      .mockResolvedValueOnce(reply({ data: [credit], has_more: false }));
    expect((await creditUnpaidInvoice(input)).applied).toBe(true);
    expect(fetcher.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });
  it("preview performs no mutation", async () => {
    fetcher.mockResolvedValueOnce(reply(remote)).mockResolvedValueOnce(reply({ data: [], has_more: false }))
      .mockResolvedValueOnce(reply(credit));
    expect((await creditUnpaidInvoice({ ...input, apply: false })).applied).toBe(false);
    expect(fetcher.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });
  it.each([
    { status: "paid", amount_paid: 8027, amount_remaining: 0 },
    { amount_paid: 100, amount_remaining: 7927 },
    { status: "void" },
    { customer: "cus_someone_else" },
    { total: 9999 },
    { livemode: false },
    { lines: { has_more: true, data: [] } },
  ])("refuses a changed or ambiguous invoice: %j", async changed => {
    fetcher.mockResolvedValueOnce(reply({ ...remote, ...changed }))
      .mockResolvedValueOnce(reply({ data: [], has_more: false }));
    await expect(creditUnpaidInvoice(input)).rejects.toThrow();
    expect(fetcher.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });
  it("refuses a preview that would refund or credit future invoices", async () => {
    fetcher.mockResolvedValueOnce(reply(remote)).mockResolvedValueOnce(reply({ data: [], has_more: false }))
      .mockResolvedValueOnce(reply({ ...credit, pre_payment_amount: 0, post_payment_amount: 1067 }));
    await expect(creditUnpaidInvoice(input)).rejects.toThrow();
    expect(fetcher.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });
  it("does not create another credit when the recorded one was voided", async () => {
    fetcher.mockResolvedValueOnce(reply(remote)).mockResolvedValueOnce(reply({ data: [{ ...credit, status: "void" }], has_more: false }));
    await expect(creditUnpaidInvoice(input)).rejects.toThrow();
    expect(fetcher.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });
});

describe("sending a corrected invoice", () => {
  const corrected = { ...remote, amount_remaining: 6960, customer_email: "billing@example.com" };
  const sendInput = { expected: input.expected, targetCents: 6960, email: "billing@example.com",
    deliveryId: "review-1", assertLeaseOwnership: vi.fn(async () => {}), onSent: vi.fn(async () => {}) };
  it("emails the existing invoice with stable retry key and persists acceptance", async () => {
    fetcher.mockResolvedValueOnce(reply(corrected)).mockResolvedValueOnce(reply({ email: sendInput.email }))
      .mockResolvedValueOnce(reply(corrected));
    await sendCorrectedInvoice(sendInput);
    expect(fetcher.mock.calls[2][0]).toMatch(/\/invoices\/in_closing\/send$/);
    expect(fetcher.mock.calls[2][1].headers["Idempotency-Key"]).toBe("send-corrected:review-1");
    expect(sendInput.onSent).toHaveBeenCalledWith(corrected);
  });
  it.each([
    { amount_remaining: 8027 }, { amount_paid: 6960, status: "paid" },
    { customer_email: "other@example.com" }, { customer: "cus_other" }, { livemode: false },
  ])("refuses a changed invoice: %j", async change => {
    fetcher.mockResolvedValueOnce(reply({ ...corrected, ...change }));
    await expect(sendCorrectedInvoice(sendInput)).rejects.toThrow();
    expect(fetcher.mock.calls.every(([,options]) => options.method === "GET")).toBe(true);
  });
  it("does not send when the current customer recipient differs", async () => {
    fetcher.mockResolvedValueOnce(reply(corrected)).mockResolvedValueOnce(reply({ email: "someone-else@example.com" }));
    await expect(sendCorrectedInvoice(sendInput)).rejects.toThrow("customer email differs");
    expect(fetcher.mock.calls.every(([,options]) => options.method === "GET")).toBe(true);
  });
});
