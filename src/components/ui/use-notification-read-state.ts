"use client";

import * as React from "react";

export function useNotificationReadState(
  storageKey: string,
  currentFingerprints: string[],
) {
  const signature = [...new Set(currentFingerprints)].sort().join("\n");
  const fingerprints = React.useMemo(
    () => (signature ? signature.split("\n") : []),
    [signature],
  );
  const [read, setRead] = React.useState<Set<string> | null>(null);

  React.useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
        const values = Array.isArray(stored)
          ? stored.filter((item: unknown): item is string => typeof item === "string")
          : [];
        setRead(new Set(values));
      } catch {
        setRead(new Set());
      }
    });
    return () => {
      active = false;
    };
  }, [storageKey]);

  const markRead = React.useCallback(() => {
    const next = new Set(fingerprints);
    setRead(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...next]));
    } catch {
      // Browser storage can be unavailable; the in-memory read state still works.
    }
  }, [fingerprints, storageKey]);

  return {
    unread: read !== null && fingerprints.some((fingerprint) => !read.has(fingerprint)),
    markRead,
  };
}
