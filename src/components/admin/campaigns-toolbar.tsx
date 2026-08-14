"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Plus, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
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

export function CampaignsToolbar() {
  const router = useRouter();
  const [syncing, startSync] = useTransition();

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

      <Button
        type="button"
        variant="secondary"
        size="sm"
        loading={syncing}
        onClick={() => startSync(() => router.refresh())}
      >
        <RefreshCw aria-hidden />
        Sync
      </Button>
    </>
  );
}
