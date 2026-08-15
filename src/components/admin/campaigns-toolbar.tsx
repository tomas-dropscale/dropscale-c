"use client";

import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ReportingSyncButton } from "@/components/admin/reporting-sync-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { RangeSelection } from "@/lib/portal/range";

export function CampaignsToolbar({ range }: { range: RangeSelection }) {
  return (
    <>
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button" variant="primary" size="sm">
            <Plus aria-hidden />
            New Campaign
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Campaign</DialogTitle>
            <DialogDescription>
              Campaign creation will get its own reviewed flow after the Demand Gen and PMax setup
              rules are connected to the audited Google Ads executor.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            This page stops before creating anything. No Google Ads account, budget or creative is
            changed from this dialog.
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" size="sm">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReportingSyncButton request={{ scope: "campaigns", range }} />
    </>
  );
}
