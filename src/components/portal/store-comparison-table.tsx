"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpDown } from "lucide-react";

import { compact, money, multiplier, percent } from "@/lib/format";
import { cn } from "@/lib/utils";

export type StoreComparisonRow = {
  accountId: string;
  storeName: string;
  colorDot: string;
  currency: string;
  spend: number;
  share: number; // 0..1 of total spend
  roas: number;
  conversions: number;
  cpa: number;
  ctr: number;
  impressions: number;
  fee: number;
};

type SortKey = keyof Omit<StoreComparisonRow, "accountId" | "colorDot" | "currency">;

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "storeName", label: "Store" },
  { key: "spend", label: "Spend", numeric: true },
  { key: "share", label: "Share", numeric: true },
  { key: "roas", label: "ROAS", numeric: true },
  { key: "conversions", label: "Conv.", numeric: true },
  { key: "cpa", label: "CPA", numeric: true },
  { key: "ctr", label: "CTR", numeric: true },
  { key: "impressions", label: "Impressions", numeric: true },
  { key: "fee", label: "Fee", numeric: true },
];

export function StoreComparisonTable({ rows }: { rows: StoreComparisonRow[] }) {
  const [sortKey, setSortKey] = React.useState<SortKey>("spend");
  const [descending, setDescending] = React.useState(true);

  const sorted = React.useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const left = a[sortKey];
      const right = b[sortKey];
      const compare =
        typeof left === "string" && typeof right === "string"
          ? left.localeCompare(right)
          : Number(left) - Number(right);
      return descending ? -compare : compare;
    });
    return copy;
  }, [rows, sortKey, descending]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setDescending((value) => !value);
    } else {
      setSortKey(key);
      setDescending(key !== "storeName");
    }
  }

  return (
    <section className="panel overflow-hidden">
      <header className="border-b border-[var(--border-subtle)] px-5 py-4">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
          Store Comparison
        </h2>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-[var(--border-subtle)]">
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  className={cn(
                    "px-4 py-2.5 whitespace-nowrap",
                    column.numeric ? "text-right" : "text-left",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(column.key)}
                    className={cn(
                      "label-caps transition-smooth inline-flex items-center gap-1 hover:text-[var(--text-primary)]",
                      sortKey === column.key && "text-[var(--accent-gold)]",
                    )}
                  >
                    {column.label}
                    <ArrowUpDown className="size-3" aria-hidden />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={row.accountId}
                className="transition-smooth border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-panel-hover)]"
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/dashboard/${row.accountId}`}
                    className="flex items-center gap-2.5 font-medium text-[var(--text-primary)]"
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: row.colorDot }}
                      aria-hidden
                    />
                    {row.storeName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap text-[var(--text-primary)]">
                  {money(row.spend, row.currency)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1 w-16 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                      <div
                        className="h-full rounded-full bg-[var(--accent-gold)]"
                        style={{ width: `${Math.round(row.share * 100)}%` }}
                      />
                    </div>
                    <span className="w-10 text-right text-[var(--text-secondary)]">
                      {percent(row.share, 0)}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-[var(--text-primary)]">
                  {multiplier(row.roas)}
                </td>
                <td className="px-4 py-3 text-right text-[var(--text-secondary)]">
                  {row.conversions}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap text-[var(--text-secondary)]">
                  {money(row.cpa, row.currency)}
                </td>
                <td className="px-4 py-3 text-right text-[var(--text-secondary)]">
                  {percent(row.ctr)}
                </td>
                <td className="px-4 py-3 text-right text-[var(--text-secondary)]">
                  {compact(row.impressions)}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap text-[var(--text-secondary)]">
                  {money(row.fee, row.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
