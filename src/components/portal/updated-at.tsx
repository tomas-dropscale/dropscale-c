"use client";

import * as React from "react";

import { fmt } from "@/lib/i18n";
import { dateTime } from "@/lib/format";

/**
 * "Updated 00:22 · next update at 01:00", in the READER's timezone.
 *
 * This has to run on the client. The pages that show it are server components,
 * and a server component formatting a time formats it wherever the server is —
 * on Cloudflare that is UTC. A client in Lisbon then read every timestamp
 * exactly one hour behind, all summer, with nothing on screen to suggest the
 * clock was the problem rather than the data.
 *
 * `toLocaleString` with no `timeZone` uses the runtime's own zone, which is the
 * correct answer once the runtime is the viewer's browser. Deliberately not
 * pinned to Europe/Lisbon: the portal ships in five languages, so the reader is
 * not necessarily in Portugal.
 *
 * The template arrives already translated — the dictionary lives on the server
 * side of this boundary, and passing the finished string keeps this component
 * from needing the whole dictionary.
 */
/** Nothing to subscribe to — the value never changes after mount. */
const subscribeNever = () => () => {};

export function UpdatedAt({
  template,
  updatedAt,
  nextUpdateAt,
}: {
  /** e.g. "Updated {time}" or "Updated {time} · next update at {next}". */
  template: string;
  updatedAt: string;
  nextUpdateAt?: string | null;
}) {
  // "Are we on the client yet?" without setState in an effect, which cascades a
  // render. The server snapshot is false and the client one is true, so React
  // hydrates the placeholder and swaps it in the same pass.
  const mounted = React.useSyncExternalStore(subscribeNever, () => true, () => false);

  // Before mount the sentence renders with the clock parts as an ellipsis
  // rather than as a wrong time. Same shape, so nothing shifts when it fills in.
  if (!mounted) return <>{fmt(template, { time: "…", next: "…" })}</>;

  return (
    <>
      {fmt(template, {
        time: dateTime(updatedAt),
        next: nextUpdateAt
          ? new Date(nextUpdateAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "",
      })}
    </>
  );
}
