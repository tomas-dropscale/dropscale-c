import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** "Ada Lovelace" → "AL" — used by the fallback avatars. */
export function initials(name: string | null | undefined) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Deterministic colour per id, for the background of photo-less avatars.
 * Stays within the design system's warm palette.
 */
const AVATAR_TINTS = [
  "bg-[#3a2f22] text-[#e8c088]",
  "bg-[#2b3329] text-[#9dc5a5]",
  "bg-[#33272b] text-[#d99a90]",
  "bg-[#2a2f38] text-[#9fb3cc]",
  "bg-[#332e22] text-[#d6c58a]",
  "bg-[#2e2a33] text-[#b7a5cc]",
];

export function avatarTint(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}
