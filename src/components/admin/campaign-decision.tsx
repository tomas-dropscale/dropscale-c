import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, CircleHelp, Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { money, multiplier } from "@/lib/format";
import type { CampaignDecision, DecisionLevel } from "@/lib/admin/campaign-decisions";
import { decisionDay } from "@/lib/admin/campaign-decisions";

export const DECISION_LABELS: Record<DecisionLevel, string> = {
  ready: "Scale prioritário", scale: "Candidata a scale", review: "Analisar scale",
  reduce: "Descalar / kill?", maintain: "No equilíbrio", learning: "Observar",
  no_sales: "Gasto sem receita", missing: "Faltam dados", inactive: "Inativa",
};
export const decisionCategory = (level: DecisionLevel): "scale" | "review" | "observe" | "missing" =>
  ["ready", "scale", "review"].includes(level) ? "scale" : ["reduce", "no_sales"].includes(level) ? "review" : level === "missing" ? "missing" : "observe";
const dayLabel = (day: string) => day.split("-").reverse().join("/");

export function CampaignDecisionPanel({ decision: s, currency, analyticsHref }: {
  decision: CampaignDecision; currency: string; analyticsHref: string;
}) {
  const category = decisionCategory(s.level);
  const variant = category === "scale" ? "success" : category === "review" ? "danger" : category === "missing" ? "warning" : "neutral";
  const Icon = category === "scale" ? ArrowUpRight : category === "review" ? ArrowDownRight : category === "missing" ? CircleHelp : Clock3;
  const amount = (n: number | null) => n === null ? "—" : money(n, currency);
  const period = s.days ? `${dayLabel(s.from)} – ${dayLabel(s.to)}` : "A aguardar um dia fechado";
  const scope = s.basis === "google" ? "Google individual" : "Real da coleção";
  const params = new URLSearchParams(analyticsHref.split("?")[1]);
  params.set("range", "custom"); params.set("from", s.days ? s.from : s.to); params.set("to", s.to);
  return (
    <details className="group/decision col-span-2 min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 text-[11px] xl:col-span-7 xl:ml-6">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2 outline-offset-4 focus-visible:outline-2 focus-visible:outline-[var(--accent-gold)]">
        <span className="font-medium text-[var(--text-secondary)]">Análise até ontem</span>
        <Badge variant={variant}><Icon className="size-3" aria-hidden />{DECISION_LABELS[s.level]}</Badge>
        <span className="text-[var(--text-secondary)]">{scope} · <strong>{s.roas === null ? "—" : multiplier(s.roas)}</strong> <span className="text-[var(--text-muted)]">/ equilíbrio {s.breakEven === null ? "—" : multiplier(s.breakEven)}</span></span>
        <span className="text-[var(--text-secondary)]">{s.changedAt ? "Após alteração" : s.startedOn && s.days < 7 ? "Após início" : "Referência · 7 dias"} · {period}</span>
        {s.provisional && <span className="text-[var(--warning-orange)]">Confirmar histórico</span>}
        <span className="ml-auto whitespace-nowrap font-medium text-[var(--accent-gold-strong)]"><span className="group-open/decision:hidden">Ver motivo +</span><span className="hidden group-open/decision:inline">Fechar −</span></span>
      </summary>
      <div className="space-y-4 border-t border-[var(--border-subtle)] p-4">
        <p className="text-[12px] leading-relaxed text-[var(--text-primary)]">{s.reason}</p>
        <p className="text-[var(--text-secondary)]">Esta análise usa {period}. O ROAS na coluna acima usa o período selecionado na tabela e pode ser diferente.</p>
        {s.provisional && <p className="rounded-md bg-[var(--warning-orange)]/8 px-3 py-2 leading-relaxed text-[var(--warning-orange)]">Leitura indicativa: não há histórico completo de alterações para este período. Confirma no Google se o orçamento, estado ou estratégia mudaram antes de agir.</p>}
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Gasto analisado", amount(s.spend)],
            [s.basis === "google" ? "Receita atribuída pelo Google" : "Receita líquida da coleção", amount(s.revenue)],
            [s.basis === "google" ? "Conversões Google" : "Resultado estimado da coleção", s.basis === "google" ? s.conversions === null ? "—" : s.conversions.toLocaleString("pt-PT", { maximumFractionDigits: 2 }) : amount(s.profit)],
            ["Dias com dados / esperados", `${s.coverage} / ${s.days}`],
          ].map(([label,value]) => <div key={label} className="rounded-md border border-[var(--border-subtle)] p-3"><dt className="text-[var(--text-muted)]">{label}</dt><dd className="mt-1 text-[15px] font-semibold text-[var(--text-primary)]">{value}</dd></div>)}
        </dl>
        {s.days < 5 && s.level !== "inactive" && <div><div className="h-1.5 overflow-hidden rounded-full bg-[var(--border-subtle)]"><div className="h-full rounded-full bg-[var(--accent-gold)]" style={{ width: `${Math.min(s.days / 5, 1) * 100}%` }} /></div><p className="mt-1 text-[var(--text-muted)]">{s.days}/5 dias completos · hoje e o dia do início / alteração ficam de fora.</p></div>}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 leading-relaxed text-[var(--text-secondary)]">
            <p className="font-semibold text-[var(--text-primary)]">Como interpretar</p>
            <p>{s.basis === "google" ? "Receita e ROAS pertencem apenas a esta campanha Google. O equilíbrio é uma referência estimada a partir da margem dos produtos da coleção; não é lucro confirmado desta campanha." : "Só produtos da coleção comprados por quem entrou nela na primeira visita. Todos os canais; gasto somado das campanhas desta coleção, sem duplicar vendas."}</p>
            {s.basis === "google" && <p>ROAS real da coleção no mesmo período: <strong>{s.collectionRoas === null ? "—" : multiplier(s.collectionRoas)}</strong>. Diferenças podem resultar da atribuição e do atraso de conversões do Google.</p>}
            <p>{s.changedAt ? `Período após a última alteração confirmada na Dropscale (${dayLabel(decisionDay(s.changedAt))}). Alterações diretas no Google ainda não são importadas.` : "Sem data de alteração confirmada: usamos os últimos sete dias fechados como referência, não como prova de estabilidade."}</p>
            {s.startedOn && <p>Início indicado pelo Google: {dayLabel(s.startedOn)}. Os dias anteriores ao início não contam para a avaliação.</p>}
            <Link href={`/admin/analytics?${params}`} className="inline-flex py-1 font-medium text-[var(--accent-gold-strong)] underline underline-offset-4">Abrir Analytics deste período →</Link>
          </div>
          <div className="space-y-2 leading-relaxed text-[var(--text-secondary)]">
            <p className="font-semibold text-[var(--text-primary)]">Equilíbrio estimado da coleção</p>
            <p>Receita × (1 + taxa da agência) ÷ (receita − produtos − pagamentos − portes).</p>
            <p>Produtos: {amount(s.cogs)} · Pagamentos: {amount(s.paymentFees)} · Portes: {amount(s.shipping)}</p>
            {s.fees && <p>Taxas configuradas: pagamentos {s.fees.paymentFeePct}% + {amount(s.fees.paymentFeeFixed)}/encomenda · portes {amount(s.fees.shippingCostPerOrder)}/encomenda · agência {s.fees.agencyFeeRate}% do gasto.</p>}
            <p>Custos conforme as definições da loja, incluindo estimativas quando não há custo por produto. O sinal não altera o orçamento nem pausa campanhas.</p>
          </div>
        </div>
        {s.daily.length > 0 && <details><summary className="cursor-pointer py-1 font-medium text-[var(--text-secondary)]">Ver os {s.daily.length} dias analisados</summary><div className="mt-2 max-h-56 overflow-auto"><table className="w-full text-right"><thead className="sticky top-0 bg-[var(--bg-elevated)] text-[var(--text-muted)]"><tr><th className="p-2 text-left">Dia</th><th className="p-2">Gasto</th><th className="p-2">Receita {s.basis === "google" ? "Google" : "coleção"}</th><th className="p-2">ROAS</th></tr></thead><tbody>{s.daily.map(d => <tr key={d.day} className="border-t border-[var(--border-subtle)]"><td className="p-2 text-left">{dayLabel(d.day)}</td><td className="p-2">{amount(d.spend)}</td><td className="p-2">{amount(d.revenue)}</td><td className="p-2">{d.roas === null ? "—" : multiplier(d.roas)}</td></tr>)}</tbody></table></div></details>}
        <p className="text-[10px] text-[var(--text-muted)]">Atualização: {s.refreshedAt ? new Date(s.refreshedAt).toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" }) : "por sincronizar"} · Lisboa · mínimo de 5 dias completos para sinais de scale / redução.</p>
      </div>
    </details>
  );
}

export function CampaignDecisionGuide() {
  return <details className="border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3 md:px-5"><summary className="cursor-pointer text-[12px] font-medium text-[var(--text-secondary)]">Como decidir: scale, descalar ou kill</summary><div className="mt-3 grid gap-4 text-[11.5px] leading-relaxed text-[var(--text-muted)] md:grid-cols-3"><p><strong className="text-[var(--text-primary)]">1. Ver o resultado certo.</strong><br />A linha dourada mede a coleção inteira. Cada campanha usa apenas a receita que o Google atribui ao seu próprio ID. Os valores da tabela seguem o filtro de datas.</p><p><strong className="text-[var(--text-primary)]">2. Esperar dados suficientes.</strong><br />Os sinais usam dias fechados até ontem, após a última alteração registada; sem histórico, usam 7 dias de referência. Exigem 5 dias completos, dados recentes e equilíbrio calculável. Não mudam com o filtro da tabela.</p><p><strong className="text-[var(--text-primary)]">3. Comparar com o equilíbrio.</strong><br />Abaixo: rever descalar/kill. Acima e até 2x: analisar scale. Acima de 2x: candidata a scale. Acima de 3x: prioridade. Zero receita exige revisão; dados em falta nunca valem zero. A decisão final é do media buyer.</p></div></details>;
}
