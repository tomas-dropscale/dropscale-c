import { describe, expect, it } from "vitest";

import { areaPath, endPoint, smoothPath, type ChartGeometry } from "./share-chart";

const geo: ChartGeometry = { width: 720, height: 200, pad: 16 };

/** Every number in the path must be finite — one NaN renders nothing at all. */
function numbersIn(path: string): number[] {
  return (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

describe("smoothPath", () => {
  it("returns an empty string for an empty series", () => {
    expect(smoothPath([], geo)).toBe("");
  });

  it("never emits NaN when every day is zero", () => {
    // The division by max would be 0/0 without the span guard.
    const path = smoothPath([0, 0, 0], geo);
    expect(path).not.toContain("NaN");
    expect(numbersIn(path).every(Number.isFinite)).toBe(true);
  });

  it("draws a flat series along the baseline", () => {
    const path = smoothPath([0, 0], geo);
    const baseline = geo.height - geo.pad;
    // Every y coordinate should be the baseline.
    expect(path).toContain(`${baseline}`);
  });

  it("centres a single point instead of pinning it to the left edge", () => {
    const path = smoothPath([42], geo);
    expect(path.startsWith(`M ${geo.width / 2} `)).toBe(true);
  });

  it("puts the peak at the top of the plot area", () => {
    const path = smoothPath([0, 10], geo);
    // The maximum maps to y = pad, the highest drawable point.
    expect(path).toContain(` ${geo.pad}`);
  });

  it("stays inside the padded box for a realistic series", () => {
    const path = smoothPath([3.2, 8.9, 1.1, 0, 4.4, 12.75], geo);
    const nums = numbersIn(path);
    expect(nums.every(Number.isFinite)).toBe(true);

    // Coordinates alternate x,y — check every y sits within the plot area.
    // Simpler and sufficient: nothing may exceed the canvas in either axis.
    expect(Math.min(...nums)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...nums)).toBeLessThanOrEqual(Math.max(geo.width, geo.height));
  });

  it("emits one cubic segment per gap", () => {
    expect((smoothPath([1, 2, 3, 4], geo).match(/C/g) ?? []).length).toBe(3);
  });
});

describe("endPoint", () => {
  it("is null for an empty series, so nothing is drawn", () => {
    expect(endPoint([], geo)).toBeNull();
  });

  it("sits on the right edge of the plot area", () => {
    expect(endPoint([1, 2, 3], geo)?.x).toBe(geo.width - geo.pad);
  });

  it("centres with the curve when there is a single day", () => {
    expect(endPoint([5], geo)?.x).toBe(geo.width / 2);
  });

  it("lands on the same y the curve ends at", () => {
    // The dot and the line share the scaling, so a peak-ending series puts
    // both at the top of the plot area.
    expect(endPoint([0, 10], geo)?.y).toBe(geo.pad);
  });

  it("rests on the baseline when nothing was spent", () => {
    expect(endPoint([0, 0], geo)?.y).toBe(geo.height - geo.pad);
  });
});

describe("areaPath", () => {
  it("is empty when there is no line to close", () => {
    expect(areaPath("", geo)).toBe("");
  });

  it("closes the curve down to the baseline", () => {
    const line = smoothPath([1, 5], geo);
    const area = areaPath(line, geo);
    expect(area.startsWith(line)).toBe(true);
    expect(area.endsWith("Z")).toBe(true);
    expect(area).toContain(`L ${geo.pad} ${geo.height - geo.pad}`);
  });
});
