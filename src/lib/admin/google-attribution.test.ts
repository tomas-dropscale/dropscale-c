import { describe, expect, it } from "vitest";

import {
  googleProfit,
  googleRoas,
  googleShare,
  sumAttributed,
  type DayCosts,
} from "./google-attribution";

const costs = (over: Partial<DayCosts> = {}): DayCosts => ({
  revenue: 0,
  refunds: 0,
  productCost: 0,
  paymentFees: 0,
  shippingCost: 0,
  adSpend: 0,
  ...over,
});

describe("googleShare", () => {
  it("is the non-Meta fraction of gross revenue", () => {
    expect(googleShare(600, 1000)).toBe(0.6);
  });

  it("is 0 — not 1 — when the split was never computed", () => {
    // The whole point of the module: an unknown split must never credit Google
    // with the entire shop.
    expect(googleShare(null, 1000)).toBe(0);
  });

  it("is 0 when the shop made nothing, rather than dividing by zero", () => {
    expect(googleShare(0, 0)).toBe(0);
    expect(googleShare(50, 0)).toBe(0);
  });

  it("clamps above 1, which refunds can otherwise produce", () => {
    // attributed_revenue is gross while `revenue` can be dented by a same-day
    // refund on a Meta order, so the ratio really can exceed 1.
    expect(googleShare(1200, 1000)).toBe(1);
  });
});

describe("googleProfit", () => {
  it("apportions variable costs by revenue share and charges ALL ad spend", () => {
    // 60% of revenue is Google's, so 60% of the 500 in variable costs is too.
    // 600 − 300 − 100 = 200.
    const profit = googleProfit(
      600,
      costs({ revenue: 1000, productCost: 400, paymentFees: 50, shippingCost: 50, adSpend: 100 }),
    );
    expect(profit).toBe(200);
  });

  it("does not scale ad spend down with the share", () => {
    // Every euro went to Google. Scaling it by 0.5 would invent 50 of profit.
    expect(googleProfit(500, costs({ revenue: 1000, adSpend: 100 }))).toBe(400);
  });

  it("counts refunds as a variable cost", () => {
    expect(googleProfit(500, costs({ revenue: 1000, refunds: 200 }))).toBe(400);
  });

  it("returns null when attribution was never computed", () => {
    expect(googleProfit(null, costs({ revenue: 1000, productCost: 400 }))).toBeNull();
  });

  it("goes negative when the ads cost more than the slice earned", () => {
    expect(googleProfit(100, costs({ revenue: 100, adSpend: 300 }))).toBe(-200);
  });

  it("charges no variable cost when the shop is all Meta", () => {
    // Google earned nothing, so it absorbs none of the COGS — only the spend.
    expect(googleProfit(0, costs({ revenue: 1000, productCost: 400, adSpend: 80 }))).toBe(-80);
  });
});

describe("googleRoas", () => {
  it("is Google revenue over ad spend", () => {
    expect(googleRoas(500, 100)).toBe(5);
  });

  it("is 0 rather than Infinity when nothing was spent", () => {
    expect(googleRoas(500, 0)).toBe(0);
  });

  it("is 0 when the split was never computed", () => {
    expect(googleRoas(null, 100)).toBe(0);
  });
});

describe("sumAttributed", () => {
  it("sums the days that have been computed", () => {
    expect(sumAttributed([10, 20, 30])).toBe(60);
  });

  it("ignores the uncomputed days rather than reading them as zero", () => {
    expect(sumAttributed([10, null, 30])).toBe(40);
  });

  it("keeps a genuine zero distinct from nothing computed", () => {
    expect(sumAttributed([0, 0])).toBe(0);
    expect(sumAttributed([null, null])).toBeNull();
    expect(sumAttributed([])).toBeNull();
  });
});
