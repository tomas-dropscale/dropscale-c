"use client";

import * as React from "react";

/**
 * Drops a long-lived cookie the moment a page mounts, so the server can later
 * tell the page has been visited. Used to mark the onboarding "set your costs"
 * step done once the client has actually opened the Costs page — even if they
 * leave the defaults in place.
 */
export function VisitMarker({ cookie }: { cookie: string }) {
  React.useEffect(() => {
    document.cookie = `${cookie}=1; path=/; max-age=31536000; samesite=lax`;
  }, [cookie]);
  return null;
}
