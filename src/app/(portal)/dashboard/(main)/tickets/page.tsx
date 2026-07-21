import type { Metadata } from "next";
import { Ticket } from "lucide-react";

export const metadata: Metadata = { title: "Tickets" };

/** Placeholder — support tickets arrive in a later phase. */
export default function TicketsPage() {
  return (
    <div className="panel flex flex-col items-center gap-3 px-6 py-20 text-center">
      <Ticket className="size-8 text-[var(--text-muted)]" />
      <p className="text-[15px] font-medium text-[var(--text-primary)]">Support tickets</p>
      <p className="max-w-[380px] text-[13px] leading-relaxed text-[var(--text-secondary)]">
        Coming soon. Until then, reach your account manager directly for anything you
        need.
      </p>
    </div>
  );
}
