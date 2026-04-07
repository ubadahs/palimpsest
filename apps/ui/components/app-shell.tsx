"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isHome = pathname === "/";

  return (
    <div className="paper-grid min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col px-6 pb-10 pt-8 md:px-10">
        <header
          className={cn(
            "flex flex-col gap-6 border-b border-[var(--border)] pb-6 md:flex-row md:items-end md:justify-between",
            isHome ? "mb-8" : "mb-5",
          )}
        >
          <div className="space-y-2">
            <Link href="/" className="inline-block">
              {isHome ? (
                <h1 className="font-[var(--font-instrument)] text-4xl leading-none tracking-[-0.03em] text-[var(--text)] md:text-6xl">
                  palimpsest
                </h1>
              ) : (
                <h1 className="font-[var(--font-instrument)] text-2xl leading-tight tracking-[-0.03em] text-[var(--text)] md:text-3xl">
                  palimpsest
                </h1>
              )}
            </Link>
            {isHome ? (
              <p className="max-w-2xl text-sm text-[var(--text-muted)] md:text-base">
                Check whether citing papers faithfully represent the claims of
                cited papers.
              </p>
            ) : null}
          </div>
          <nav className="flex items-center gap-3 text-sm text-[var(--text-muted)]">
            <Link
              href="/"
              className={cn(
                "rounded-full border px-4 py-2 transition",
                pathname === "/"
                  ? "border-[var(--border-strong)] bg-[var(--panel-muted)] text-[var(--text)]"
                  : "border-[var(--border)] hover:bg-[var(--panel-muted)] hover:text-[var(--text)]",
              )}
            >
              Dashboard
            </Link>
            <Link
              href="/runs/new"
              className={cn(
                "rounded-full border px-4 py-2 font-semibold transition",
                pathname === "/runs/new"
                  ? "border-[var(--border-strong)] bg-[var(--text)] text-white"
                  : "border-[var(--border-strong)] bg-[var(--text)] text-white hover:bg-[#2b241d]",
              )}
            >
              New run
            </Link>
          </nav>
        </header>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
