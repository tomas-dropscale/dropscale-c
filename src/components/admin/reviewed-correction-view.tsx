"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Result = { applied: boolean; account: string; invoiceNumber: string; remainingCents: number;
  creditNumber: string | null; creditPdf: string | null; hostedUrl: string | null };

export function ReviewedCorrectionView({ correction }: { correction: {
  id: string; originalCents: number; targetCents: number; feeCents: number; arrearsCents: number; lastServiceDay: string;
} }) {
  const euros = (cents: number) => new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(cents / 100);
  const lastDay = correction.lastServiceDay.split("-").reverse().join("/");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(apply: boolean) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/billing/reviewed-correction", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correctionId: correction.id, apply }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Falha ao verificar a correção.");
      setResult(data);
    } catch (e) { setError(e instanceof Error ? e.message : "Falha na operação."); }
    finally { setBusy(false); }
  }
  return <section className="max-w-2xl space-y-5 rounded-xl border border-[var(--border-subtle)] p-6">
    <p>Último dia de serviço aprovado: <strong>{lastDay}, inclusive</strong>.</p>
    <dl className="grid grid-cols-2 gap-3">
      <dt>Saldo da semana anterior</dt><dd>{euros(correction.arrearsCents)}</dd>
      <dt>Comissão até ao último dia de serviço</dt><dd>{euros(correction.targetCents - correction.arrearsCents)}</dd>
      <dt>Valor original</dt><dd>{euros(correction.originalCents)}</dd>
      <dt>Nota de crédito</dt><dd>−{euros(correction.originalCents - correction.targetCents)}</dd>
      <dt className="font-semibold">Total corrigido a pagar</dt><dd className="font-semibold">{euros(correction.targetCents)}</dd>
    </dl>
    <p className="text-sm text-[var(--text-secondary)]">A correção mantém a fatura e o saldo anterior, reduz o valor a pagar e envia a nota de crédito ao cliente. Novas emissões que incluam dias após {lastDay} estão bloqueadas. As semanas seguintes ficam excluídas automaticamente.</p>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {result && <p role="status">{result.applied
      ? `Correção aplicada · ${result.creditNumber} · Saldo confirmado: ${(result.remainingCents / 100).toFixed(2)} €`
      : `Verificado em ${result.account}: ${result.invoiceNumber}, por pagar. Correção pronta.`}</p>}
    <div className="flex flex-wrap gap-3">
      <Button loading={busy} onClick={() => run(false)}>Verificar na Stripe</Button>
      {result && !result.applied && <Button variant="primary" loading={busy} onClick={() => run(true)}>Aplicar correção para {euros(correction.targetCents)} e enviar nota</Button>}
      {result?.applied && result.hostedUrl && <a href={result.hostedUrl} target="_blank" rel="noreferrer" className="underline">Abrir fatura corrigida</a>}
      {result?.applied && result.creditPdf && <a href={result.creditPdf} target="_blank" rel="noreferrer" className="underline">Nota de crédito</a>}
    </div>
  </section>;
}
