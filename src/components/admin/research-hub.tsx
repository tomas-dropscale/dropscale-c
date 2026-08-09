"use client";

import * as React from "react";

export type ResearchView = "markets" | "keywords" | "compare";

/**
 * The trends radar, mounted inside the admin shell.
 *
 * The tool is the validated build from the research project — the same chart
 * engine, seasonality model and comparison flow — served from
 * /public/research and restyled to Dropscale's palette rather than rewritten.
 * A rewrite would have put the interesting part (five-year series, window
 * detection, joint-scale comparison) at risk for cosmetic gain.
 *
 * The tool boots from `location.hash`, which is how each admin route selects
 * its view; its own tab bar is hidden because the sidebar already navigates.
 */
export function ResearchHub({ view }: { view: ResearchView }) {
  const hostRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // The tool reads the hash once, at boot, so it must be set beforehand.
    if (window.location.hash !== `#${view}`) {
      window.history.replaceState(null, "", `#${view}`);
    }

    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/research/hub.css";
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = "/research/hub-app.js";
    script.async = false;
    document.body.appendChild(script);

    return () => {
      css.remove();
      script.remove();
      // The tool appends a tooltip and popover to <body>; leaving them behind
      // would stack a new pair on every navigation.
      document.querySelectorAll("#tip, #colfilter").forEach((node) => {
        if (!host.contains(node)) node.remove();
      });
    };
  }, [view]);

  return (
    <div
      ref={hostRef}
      className="research-hub"
      data-view={view}
      // The tool measures its own viewport; give it a real box inside the page.
      style={{ height: "calc(100svh - 9rem)", minHeight: 520 }}
      dangerouslySetInnerHTML={{ __html: SHELL }}
    />
  );
}

/**
 * The tool's own markup, verbatim apart from the hidden tab bar. It is static
 * HTML with no interpolation — every value rendered inside it is written by
 * the tool itself, which escapes its scraped strings.
 */
const SHELL = `
<header class="hub-top">
  <div class="hub-brand"><span class="hub-dot" aria-hidden="true"></span><span>Trends radar</span></div>
  <nav class="hub-tabs" id="tabs" role="tablist" aria-label="Vistas" hidden>
    <button class="hub-tab" role="tab" data-page="markets" aria-selected="true">Markets Overview</button>
    <button class="hub-tab" role="tab" data-page="keywords" aria-selected="false">Keywords by Market</button>
    <button class="hub-tab" role="tab" data-page="compare" aria-selected="false">Market Comparison</button>
  </nav>
  <div class="hub-ctl" id="ctl">
    <span class="hub-div" aria-hidden="true"></span>
    <select class="hub-select" id="market" aria-label="Market"></select>
    <input class="hub-input" id="search" type="search" placeholder="filter keywords…" aria-label="Filter">
  </div>
  <div class="hub-right"><span class="hub-fresh" id="fresh">loading…</span></div>
</header>

<main class="hub-body">
  <section class="page" id="page-markets">
    <div class="kpis" id="kpis"></div>
    <p class="note" id="note-markets"></p>
    <div class="tblwrap"><table id="tbl-markets"><thead></thead><tbody></tbody></table></div>
  </section>

  <section class="page" id="page-compare" hidden>
    <p class="note" id="note-compare"></p>
    <div class="cmp-steps">
      <div class="cmp-step">
        <div class="cmp-h"><span class="cmp-n">1</span> Pick the keyword</div>
        <input class="hub-input" id="cmp-search" type="search" placeholder="search concept…" aria-label="Search concept">
        <div class="cmp-list" id="cmp-concepts" role="listbox" aria-label="Concepts"></div>
      </div>
      <div class="cmp-step">
        <div class="cmp-h"><span class="cmp-n">2</span> Pick up to 5 markets</div>
        <div class="cmp-geos" id="cmp-geos"></div>
        <div class="cmp-run">
          <button class="cmp-btn" id="cmp-go" type="button" disabled>Run comparison</button>
          <span class="cmp-cost" id="cmp-cost"></span>
        </div>
      </div>
    </div>
    <div class="cmp-result" id="cmp-result"></div>
  </section>

  <section class="page" id="page-keywords" hidden>
    <div class="kpis" id="kpis-kw"></div>
    <p class="note" id="note-keywords"></p>
    <div class="tblwrap"><table id="tbl-keywords"><thead></thead><tbody></tbody></table></div>
  </section>
</main>

<div class="detail" id="detail" aria-live="polite">
  <div class="d-head">
    <span class="d-title" id="d-title"></span>
    <span class="d-sub" id="d-sub"></span>
    <button class="d-close" id="d-close" type="button">Close ✕</button>
  </div>
  <div class="legend" id="d-legend"></div>
  <div id="d-chart"></div>
  <div class="rising" id="d-rising"></div>
</div>

<div class="colfilter" id="colfilter">
  <input class="hub-input" id="colfilter-input" type="search" placeholder="type to filter…" aria-label="Filter column">
  <button type="button" class="cf-clear" id="colfilter-clear" title="Clear filter">clear</button>
</div>

<div id="tip"></div>
`;
