import Link from "next/link";

import { Logo } from "@/components/brand/logo";

const COLUMNS: { heading: string; links: { label: string; href: string; external?: boolean }[] }[] =
  [
    {
      heading: "Product",
      links: [
        { label: "Client portal", href: "/login" },
        { label: "Create account", href: "/register" },
      ],
    },
    {
      heading: "Legal",
      links: [
        { label: "Privacy Policy", href: "/privacy-policy" },
        { label: "Terms of Service", href: "/terms-of-service" },
      ],
    },
    {
      heading: "Contact",
      links: [
        { label: "leandro@dropscale.io", href: "mailto:leandro@dropscale.io", external: true },
        // TODO: point at the real profiles before launch.
        { label: "LinkedIn", href: "#", external: true },
        { label: "Instagram", href: "#", external: true },
      ],
    },
  ];

export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--border-subtle)]">
      <div className="mx-auto grid w-full max-w-[1120px] gap-10 px-5 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-3">
          <Logo size="md" />
          <p className="max-w-[260px] text-[12.5px] leading-relaxed text-[var(--text-muted)]">
            A specialist Google Ads management agency. We plan, run and optimise
            paid search for brands that want profitable growth.
          </p>
        </div>

        {COLUMNS.map((column) => (
          <div key={column.heading}>
            <p className="label-caps mb-3">{column.heading}</p>
            <ul className="space-y-2">
              {column.links.map((link) => (
                <li key={link.label}>
                  {link.external ? (
                    <a
                      href={link.href}
                      className="transition-smooth text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      href={link.href}
                      className="transition-smooth text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center justify-between gap-2 px-5 py-5">
          <p className="text-[11.5px] text-[var(--text-muted)]">
            © {new Date().getFullYear()} Dropscale IO. All rights reserved.
          </p>
          {/* Clear-disclosure line — also what OAuth verification reviewers look for */}
          <p className="text-[11.5px] text-[var(--text-muted)]">
            Independent agency specialised in Google Ads. Google Ads is a trademark of Google LLC.
          </p>
        </div>
      </div>
    </footer>
  );
}
