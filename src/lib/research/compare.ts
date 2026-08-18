import "server-only";

/**
 * Google Trends comparison mode, ported from the research tool.
 *
 * WHY IT EXISTS: the stored Trends index is normalised per keyword AND per
 * market, so the saved data cannot say which market searches more. Comparison
 * mode returns up to five series on one shared scale (global max = 100) — the
 * only honest answer to that question. It costs about $0.05 per run, so it
 * happens on explicit request and every result is cached by combination.
 *
 * MEASURED LIMIT (2026-08-09, ~$1.50 of diagnostic runs): the actor only
 * returns the joint series for SINGLE-WORD terms. With multi-word terms the
 * page loads and the series exists, but the RELATED_* widgets never appear and
 * the actor discards the whole run. Retrying does not help, so the caller is
 * warned before spending rather than charged for a doomed attempt.
 *
 * The original polled in-process; a Worker cannot hold that job between
 * requests, so the run context lives in the database and the browser drives
 * the polling.
 */

const ACTOR = "apify~google-trends-scraper";
export const MAX_GEOS = 5;
const TIMEFRAME_DEFAULT = "today 5-y";
const RUN_TIMEOUT_S = 900;
/**
 * The Apparel category returned zero items on run bjXKPGCtY5NofgtWs and the
 * comparison URL known to work never carried it. Off until proven otherwise:
 * a comparison is the SAME keyword across markets, so the category filter
 * matters less here than it does for the stored sweeps.
 */
const CATEGORY: number | null = null;

export type ComparePair = { geo: string; kw: string };

export type CompareSeries = {
  geo: string;
  kw: string;
  points: [string, number][];
  mean: number;
  max: number;
  last12: number;
};

export type CompareResult = {
  id: string;
  geos: string[];
  key: string;
  runId: string;
  url: string;
  costUsd: number;
  generated: string;
  scale: string;
  series: CompareSeries[];
};

async function apify<T>(path: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.apify.com/v2${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`Apify ${path} answered ${response.status}.`);
  }
  return (await response.json()) as T;
}

/** Stable cache identity: same concept and same markets, in any order. */
export async function cacheKey(
  id: string,
  geos: string[],
  timeframe?: string,
): Promise<string> {
  // The timeframe changes the paid query, so it changes the cache identity —
  // without it, a five-year run would be served for a twelve-month request.
  const source = `${id}|${[...geos].sort().join(",")}|${timeframe ?? TIMEFRAME_DEFAULT}`;
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(source),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** date/geo/q repeated once per series, exactly as Trends encodes them. */
export function compareUrl(pairs: ComparePair[], timeframe = TIMEFRAME_DEFAULT) {
  const date = pairs.map(() => encodeURIComponent(timeframe)).join(",");
  const geo = pairs.map((pair) => pair.geo).join(",");
  // '+' rather than %20: that is how Trends encodes spaces in comparison queries.
  const q = pairs
    .map((pair) => encodeURIComponent(pair.kw).replace(/%20/g, "+"))
    .join(",");
  return (
    `https://trends.google.com/trends/explore?date=${date}&geo=${geo}&q=${q}` +
    (CATEGORY ? `&cat=${CATEGORY}` : "") +
    "&hl=en"
  );
}

/** Start the run and return immediately; the state endpoint finishes it. */
export async function startCompareRun(
  pairs: ComparePair[],
  token: string,
  timeframe = TIMEFRAME_DEFAULT,
): Promise<{ runId: string; url: string }> {
  if (pairs.length < 2 || pairs.length > MAX_GEOS) {
    throw new Error(`Pick between 2 and ${MAX_GEOS} markets.`);
  }
  const url = compareUrl(pairs, timeframe);
  const run = await apify<{ data: { id: string } }>(
    `/acts/${ACTOR}/runs?timeout=${RUN_TIMEOUT_S}`,
    token,
    {
      startUrls: [{ url }],
      skipDebugScreen: true,
      maxItems: 0,
      maxConcurrency: 1,
      maxRequestRetries: 3,
      pageLoadTimeoutSecs: 480,
    },
  );
  return { runId: run.data.id, url };
}

type TimelinePoint = {
  time: string | number;
  value: number | number[];
  isPartial?: boolean;
};

export type CompareProgress =
  | { state: "running" }
  | { state: "error"; error: string }
  | { state: "done"; series: CompareSeries[]; costUsd: number };

/**
 * Ask Apify where the run stands, and build the joint-scale series once it has
 * finished. Returns "running" while the actor works — the browser polls.
 */
export async function pollCompareRun(
  runId: string,
  pairs: ComparePair[],
  token: string,
): Promise<CompareProgress> {
  const run = await apify<{
    data: { status: string; defaultDatasetId: string; usageTotalUsd?: number };
  }>(`/actor-runs/${runId}`, token);

  if (run.data.status === "READY" || run.data.status === "RUNNING") {
    return { state: "running" };
  }
  if (run.data.status !== "SUCCEEDED") {
    return { state: "error", error: `The Apify run ended as ${run.data.status}.` };
  }

  const items = await apify<{ interestOverTime_timelineData?: TimelinePoint[] }[]>(
    `/datasets/${run.data.defaultDatasetId}/items?clean=true`,
    token,
  );
  const timeline = items[0]?.interestOverTime_timelineData ?? [];
  if (timeline.length === 0) {
    const multiWord = pairs
      .filter((pair) => pair.kw.trim().includes(" "))
      .map((pair) => `${pair.geo} "${pair.kw}"`);
    return {
      state: "error",
      error: multiWord.length
        ? `No series came back. Known actor limit: it fails on multi-word terms — ${multiWord.join(", ")}. Try markets whose term is a single word.`
        : `No series came back (${items.length} items). The actor is unstable; try again.`,
    };
  }

  // value[] carries one number per series, in URL order — the joint scale.
  const series: CompareSeries[] = pairs.map((pair, index) => {
    const points = timeline
      .filter((point) => !point.isPartial)
      .map(
        (point): [string, number] => [
          new Date(Number(point.time) * 1000).toISOString().slice(0, 10),
          Array.isArray(point.value) ? (point.value[index] ?? 0) : point.value,
        ],
      );
    const values = points.map((point) => point[1]);
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    const recent = values.slice(-52);
    const last12 =
      recent.reduce((sum, value) => sum + value, 0) / Math.max(recent.length, 1);
    return {
      geo: pair.geo,
      kw: pair.kw,
      points,
      mean: Number(mean.toFixed(1)),
      max: Math.max(...values, 0),
      last12: Number(last12.toFixed(1)),
    };
  });

  // The cost settles a little after the run ends; it is informative only, so a
  // missing value must never fail an otherwise good result.
  return {
    state: "done",
    series,
    costUsd: Number((run.data.usageTotalUsd ?? 0).toFixed(4)),
  };
}
