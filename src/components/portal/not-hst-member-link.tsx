"use client";

import * as React from "react";

/**
 * "I am not an HST member" — the way down to the plain cost settings for a store
 * that leads with the supplier's order list.
 *
 * It scrolls to the settings and flashes them, so the destination announces
 * itself rather than leaving the reader to find what changed. The href alone
 * would still jump there with JavaScript off; the handler adds the glide and the
 * glow on top.
 */
export function NotHstMemberLink() {
  const onClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById("cost-settings");
    if (!target) return; // let the bare anchor do its default jump
    event.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    // Restart the animation even if it fired moments ago.
    target.classList.remove("settings-glow");
    void target.offsetWidth;
    target.classList.add("settings-glow");
    // Clear once the four ~0.9s swells have finished.
    window.setTimeout(() => target.classList.remove("settings-glow"), 3800);
  };

  return (
    <a
      href="#cost-settings"
      onClick={onClick}
      className="transition-smooth inline-flex items-center gap-1.5 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--text-secondary)] hover:border-[var(--accent-gold)]/40 hover:text-[var(--text-primary)]"
    >
      I am not an HST member
    </a>
  );
}
