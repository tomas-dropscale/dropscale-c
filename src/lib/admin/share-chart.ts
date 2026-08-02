/**
 * The curve behind the share card's spend chart.
 *
 * Pure and I/O-free so the awkward inputs can be unit-tested: a period with one
 * day, a period where nothing was spent, and an empty range all reach this
 * function, and each one has its own way of producing NaN in an SVG path — a
 * path string with NaN in it renders as nothing at all, silently.
 */

export type ChartGeometry = { width: number; height: number; pad: number };

/**
 * A cubic through every value, with horizontal control handles.
 *
 * Handles are placed at the midpoint x of each segment, which keeps the curve
 * from overshooting above a peak or below the baseline — an overshoot on a
 * spend chart would draw a negative day that never happened.
 *
 * Returns "" for an empty series so the caller can skip rendering rather than
 * emit a malformed path.
 */
export function smoothPath(values: number[], geo: ChartGeometry): string {
  if (values.length === 0) return "";

  const { width, height, pad } = geo;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  // A flat series (every day zero, or a single day) has no range to scale
  // against. Dividing by it would be NaN, so it draws along the baseline.
  const max = Math.max(...values, 0);
  const span = max > 0 ? max : 1;

  const point = (index: number) => ({
    // One point has no span to spread across — centre it instead of pinning it
    // to the left edge, where it would read as a chart that failed to load.
    x: values.length === 1 ? width / 2 : pad + (index / (values.length - 1)) * innerW,
    y: pad + innerH - (values[index] / span) * innerH,
  });

  const first = point(0);
  let path = `M ${first.x} ${first.y}`;

  for (let index = 0; index < values.length - 1; index++) {
    const current = point(index);
    const next = point(index + 1);
    const midX = (current.x + next.x) / 2;
    path += ` C ${midX} ${current.y}, ${midX} ${next.y}, ${next.x} ${next.y}`;
  }

  return path;
}

/**
 * Where the curve ends, for the dot that marks the latest day.
 *
 * Shares the scaling rules above rather than recomputing them — a dot sitting
 * slightly off its own line is the kind of detail that makes a shared card look
 * unfinished. Null for an empty series so the caller renders nothing.
 */
export function endPoint(
  values: number[],
  geo: ChartGeometry,
): { x: number; y: number } | null {
  if (values.length === 0) return null;

  const { width, height, pad } = geo;
  const innerH = height - pad * 2;
  const max = Math.max(...values, 0);
  const span = max > 0 ? max : 1;

  return {
    x: values.length === 1 ? width / 2 : width - pad,
    y: pad + innerH - (values[values.length - 1] / span) * innerH,
  };
}

/** The same curve closed down to the baseline, for the gradient fill. */
export function areaPath(line: string, geo: ChartGeometry): string {
  if (!line) return "";
  const { width, height, pad } = geo;
  return `${line} L ${width - pad} ${height - pad} L ${pad} ${height - pad} Z`;
}
