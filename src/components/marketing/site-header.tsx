"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

const NAV = [
  { href: "#services", label: "Services" },
  { href: "#process", label: "How it works" },
  { href: "#results", label: "Results" },
  { href: "#pricing", label: "Pricing" },
];

/**
 * Marketing header. Sticky with a blur so the dark hero scrolls underneath;
 * the anchor nav collapses away on small screens where the two CTAs are what
 * matter.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--bg-base)]/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-[1120px] items-center gap-8 px-5">
        <Link href="/" aria-label="Dropscale IO — home">
          <Logo size="md" />
        </Link>

        <nav aria-label="Site" className="hidden flex-1 items-center gap-6 md:flex">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="transition-smooth text-[13.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2.5 md:ml-0">
          <Button variant="ghost" size="sm" asChild>
            {/* The client portal — same domain, different world */}
            <Link href="/login">Sign in</Link>
          </Button>
          <Button variant="primary" size="sm" asChild>
            <Link href="/register">
              Get started
              <ArrowRight />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
