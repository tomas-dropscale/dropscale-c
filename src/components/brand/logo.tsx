import { cn } from "@/lib/utils";

/**
 * Dropscale IO wordmark. Type only — no monogram mark.
 */
export function Logo({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const word = {
    sm: "text-[13px]",
    md: "text-[14px]",
    lg: "text-[18px]",
  }[size];

  return (
    <span
      className={cn(
        "font-semibold tracking-tight text-[var(--text-primary)] select-none",
        word,
        className,
      )}
    >
      Dropscale <span className="text-[var(--accent-gold)]">IO</span>
    </span>
  );
}
