"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, LogOut, Settings } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n/provider";

/**
 * The signed-in user's menu in the window chrome — identical in the admin
 * dashboard and the client portal, so it lives here rather than being built
 * twice. `badge` is the only area-specific slot (admin shows the role).
 */
export function AccountMenu({
  name,
  email,
  avatarUrl,
  seed,
  settingsHref,
  badge,
  onSignOut,
  signingOut = false,
}: {
  name: string;
  email: string;
  avatarUrl?: string | null;
  seed?: string;
  settingsHref: string;
  badge?: React.ReactNode;
  onSignOut: () => void;
  signingOut?: boolean;
}) {
  const { d } = useI18n();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={d.portal.accountMenu}
        className="transition-smooth flex items-center gap-2 rounded-full py-0.5 pr-2 pl-0.5 outline-none hover:bg-[var(--bg-panel)] focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/30 data-[state=open]:bg-[var(--bg-panel)]"
      >
        <Avatar name={name} src={avatarUrl} seed={seed} size="sm" />
        <span className="hidden max-w-[110px] truncate text-[12.5px] text-[var(--text-primary)] sm:block">
          {name}
        </span>
        <ChevronDown className="size-3 text-[var(--text-muted)]" aria-hidden />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-[220px]">
        <div className="flex items-center gap-2.5 px-2.5 py-2.5">
          <Avatar name={name} src={avatarUrl} seed={seed} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">{name}</p>
            <p className="truncate text-[11.5px] text-[var(--text-secondary)]">{email}</p>
          </div>
        </div>

        {badge && <div className="px-2.5 pb-2">{badge}</div>}

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href={settingsHref}>
            <Settings aria-hidden />
            {d.userMenu.settings}
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          variant="danger"
          disabled={signingOut}
          onSelect={(event) => {
            event.preventDefault();
            onSignOut();
          }}
        >
          <LogOut aria-hidden />
          {signingOut ? d.userMenu.signingOut : d.userMenu.signOut}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
