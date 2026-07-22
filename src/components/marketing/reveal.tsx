"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Fades + slides children in the first time they scroll into view.
 *
 * IntersectionObserver only — no animation library, and no React state: the
 * observer adds the class straight to the DOM node, so revealing never causes
 * a re-render. The observer disconnects after the first reveal, so scrolling
 * back up never re-hides content, and the CSS side (globals.css `.reveal`)
 * short-circuits everything for prefers-reduced-motion.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  /** Milliseconds; use to stagger sibling cards (0 / 80 / 160…). */
  delay?: number;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const show = () => node.classList.add("reveal-visible");

    // No IO (very old browsers, some crawlers): just show the content.
    if (typeof IntersectionObserver === "undefined") {
      show();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          show();
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cn("reveal", className)}
      style={delay ? ({ "--reveal-delay": `${delay}ms` } as React.CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}
