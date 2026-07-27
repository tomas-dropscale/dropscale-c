import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Renders `**marked**` runs of a translated string as emphasised spans.
 *
 * Translated copy sometimes needs a word or a UI path picked out — "click
 * **Save**", "stays **pending** until approved". Splitting that into separate
 * dictionary keys forces English word order onto every language, which is how
 * you end up with sentences that read backwards in French. Keeping the marker
 * inside the string lets each translation put the emphasis where its own
 * grammar wants it.
 *
 * Deliberately not markdown: one marker, no nesting, no HTML. The input is our
 * own dictionary, never user content, and it is rendered as text either way.
 */
export function Rich({
  text,
  className,
  as: Tag = "span",
}: {
  text: string;
  /** Classes for the emphasised runs. Defaults to the brighter body colour. */
  className?: string;
  as?: "span" | "strong";
}) {
  // Odd indices are the captured groups, i.e. what was inside the markers.
  const parts = text.split(/\*\*(.+?)\*\*/g);

  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <Tag key={index} className={cn("text-[var(--text-primary)] font-medium", className)}>
            {part}
          </Tag>
        ) : (
          part
        ),
      )}
    </>
  );
}
