import Link from "next/link";
import { Logo } from "@/components/brand/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden px-4 py-12">
      {/* Very subtle gold halo behind the card — depth without heavy shadows */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-[-18rem] left-1/2 size-[38rem] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(212,168,106,0.10),transparent_65%)] blur-2xl"
      />

      <div className="relative z-10 w-full max-w-[420px]">
        <div className="mb-8 flex justify-center">
          <Link href="/" aria-label="Dropscale IO">
            <Logo size="lg" />
          </Link>
        </div>

        {children}
      </div>

      <p className="relative z-10 mt-10 text-[11px] text-[var(--text-muted)]">
        © {new Date().getFullYear()} Dropscale IO — Client Portal
      </p>
    </div>
  );
}
