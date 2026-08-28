"use client";

import * as React from "react";

/**
 * Coordinates the "fill in" animation across the two halves of the Costs page.
 *
 * The supplier panel and the product grid are siblings rendered by a server
 * page, so neither can hand the other a prop. When the panel starts pulling a
 * store's supplier costs it bumps the nonce here; the grid watches the nonce,
 * and when the fresh costs arrive from the refresh it cascades them in.
 *
 * A context rather than a window event on purpose: a grid that mounts or
 * re-renders mid-pull still reads the current nonce, where an event it missed
 * would be gone.
 */
type CogsFill = {
  /** Bumped once each time a supplier pull begins. */
  nonce: number;
  /** The supplier panel calls this the moment it starts a pull. */
  begin: () => void;
};

const Ctx = React.createContext<CogsFill>({ nonce: 0, begin: () => {} });

export function CogsFillProvider({ children }: { children: React.ReactNode }) {
  const [nonce, setNonce] = React.useState(0);
  const begin = React.useCallback(() => setNonce((value) => value + 1), []);
  const value = React.useMemo(() => ({ nonce, begin }), [nonce, begin]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCogsFill(): CogsFill {
  return React.useContext(Ctx);
}
