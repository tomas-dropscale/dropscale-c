import { cn } from "@/lib/utils";

export function AuthCard({
  title,
  subtitle,
  children,
  footer,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-window)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-7",
        className,
      )}
    >
      <div className="mb-6 space-y-1.5">
        <h1 className="text-[19px] leading-tight font-semibold tracking-tight text-[var(--text-primary)]">
          {title}
        </h1>
        {subtitle && (
          <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">{subtitle}</p>
        )}
      </div>

      {children}

      {footer && (
        <div className="mt-6 border-t border-[var(--border-subtle)] pt-5 text-center text-[13px] text-[var(--text-secondary)]">
          {footer}
        </div>
      )}
    </div>
  );
}

/** Error/success banner shared by all the auth forms. */
export function FormAlert({
  tone = "error",
  children,
}: {
  tone?: "error" | "success";
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-[10px] border px-3 py-2.5 text-[13px] leading-relaxed",
        tone === "error"
          ? "border-[var(--danger-red)]/30 bg-[var(--danger-red)]/10 text-[#e2a49b]"
          : "border-[var(--success-green)]/30 bg-[var(--success-green)]/10 text-[#a8d4b0]",
      )}
    >
      {children}
    </div>
  );
}
