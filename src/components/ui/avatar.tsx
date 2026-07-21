"use client";

import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn, initials, avatarTint } from "@/lib/utils";

const SIZES = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  md: "size-8 text-[11px]",
  lg: "size-10 text-[13px]",
} as const;

type AvatarProps = {
  name: string;
  src?: string | null;
  seed?: string;
  size?: keyof typeof SIZES;
  className?: string;
};

export function Avatar({ name, src, seed, size = "md", className }: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        "relative flex shrink-0 overflow-hidden rounded-full border border-[var(--border-strong)] select-none",
        SIZES[size],
        className,
      )}
    >
      {src ? (
        <AvatarPrimitive.Image
          src={src}
          alt={name}
          className="aspect-square size-full object-cover"
        />
      ) : null}
      <AvatarPrimitive.Fallback
        delayMs={src ? 300 : 0}
        className={cn(
          "flex size-full items-center justify-center font-semibold tracking-wide",
          avatarTint(seed ?? name),
        )}
      >
        {initials(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

type Person = { id: string; full_name: string; avatar_url?: string | null };

/** Overlapping avatars: shows `max` and rolls the rest into a "+N". */
export function AvatarStack({
  people,
  max = 3,
  size = "sm",
}: {
  people: Person[];
  max?: number;
  size?: keyof typeof SIZES;
}) {
  if (people.length === 0) return null;

  const visible = people.slice(0, max);
  const overflow = people.length - visible.length;

  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((person) => (
        <Avatar
          key={person.id}
          name={person.full_name}
          src={person.avatar_url}
          seed={person.id}
          size={size}
          className="ring-2 ring-[var(--bg-panel)]"
        />
      ))}
      {overflow > 0 && (
        <span
          className={cn(
            "flex items-center justify-center rounded-full bg-[var(--bg-elevated)] font-semibold text-[var(--text-secondary)] ring-2 ring-[var(--bg-panel)]",
            SIZES[size],
          )}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
