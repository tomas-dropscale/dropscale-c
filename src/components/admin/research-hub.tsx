"use client";

import * as React from "react";

export type ResearchView = "markets" | "keywords" | "compare";

/**
 * The trends radar, mounted inside the admin shell.
 *
 * The tool is the validated build from the research project — the same chart
 * engine, seasonality model and joint-scale comparison — served from
 * /public/research and restyled to Dropscale's palette rather than rewritten.
 * A rewrite would have put the interesting part at risk for cosmetic gain.
 *
 * It runs in a same-origin frame, and that is not laziness: injecting its
 * script into the admin document re-evaluated `const` declarations on every
 * client-side navigation between the three research routes, which threw
 * "already declared" and left the second and third pages dead. A frame gives
 * each view a clean global, guarantees the tool's boot runs exactly once, and
 * keeps its page-level CSS from ever reaching the shell around it.
 */
export function ResearchHub({ view }: { view: ResearchView }) {
  return (
    <iframe
      // The tool reads the view from the hash at boot; keying on it makes a
      // route change remount the frame rather than reuse a booted one.
      key={view}
      src={`/research/app.html#${view}`}
      title="Trends radar"
      className="w-full rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-base)]"
      style={{ height: "calc(100svh - 11rem)", minHeight: 520 }}
    />
  );
}
