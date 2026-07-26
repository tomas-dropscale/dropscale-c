"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AddAccountModal } from "@/components/portal/add-account-modal";
import { useI18n } from "@/lib/i18n/provider";

/**
 * "Add account", wherever a client can be without the main sidebar.
 *
 * The settings zone swaps the sidebar for its own nav, so a page that told
 * people to "add one from the sidebar" was pointing at something that isn't
 * on screen. The action travels with the page instead.
 */
export function AddAccountButton({
  clientId,
  variant = "primary",
}: {
  clientId: string;
  variant?: "primary" | "secondary";
}) {
  const { d } = useI18n();
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
        <Plus />
        {d.portal.addAccount}
      </Button>
      <AddAccountModal open={open} onOpenChange={setOpen} clientId={clientId} />
    </>
  );
}
