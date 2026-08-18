# Handoff — estado da plataforma Dropscale (2026-08-17)

Escrito pelo Fable (Claude) após a revisão ultracode de 17 de agosto, para quem pegar
no projeto a seguir. Tudo aqui foi verificado contra o código deployed e a base de
dados live nesse dia. Documentos irmãos: `FABLE_AUDIT_E_TAKEOVER_2026-08-04.md` e
`FABLE_HANDOFF_BILLING_AUDIT_2026-08-04.md` (auditoria e recovery do billing).

## Arquitetura em 1 parágrafo

Next.js App Router num único Worker Cloudflare (`dropscale-da`, deploy automático
via Workers Builds no push para `main` — o CI **só faz build, não corre testes**).
Base de dados Supabase (`zlzscedvqovjjphwojco`). Fontes de dados: **Shopify Admin
API** (custom app por loja, credenciais nas connections) e **Windsor.ai** para
TODOS os dados Google Ads de clientes — **regra do dono: nunca usar MCC/service
account como via de acesso a contas de clientes**. Contas legacy antigas ainda têm
refresh tokens OAuth próprios (via `ad_accounts.google_ads_refresh_token`); são a
exceção histórica, não o modelo. Pagamentos: Stripe (invoices semanais, fee 10%
sobre adspend EUR).

## Modelo de dados que interessa (o resto é acessório)

- **`portal_clients`** — o roster único de clientes (auth.users.id = id).
  `profiles` guarda role (admin/member). A antiga tabela `clients` (CRM) foi
  DROPADA a 2026-08-17 (migration 0071) — nunca teve rows.
- **`client_onboarding_sessions`** — os connect links. Token hasheado, expira em
  7 dias, morre na submissão; auto-review desde a migration 0063 (+0068 para o
  reviewer de sistema). Só sessões `pending`/`collecting` aparecem como "Open
  links" no admin — é isso que faz o link "desaparecer" quando o cliente aprova.
- **`client_shopify_connections`/`client_google_ads_connections`** — as ligações
  v2 (Shopify custom app; Google via Windsor co-user). `client_reporting_bindings`
  liga connections → `ad_accounts` (IMUTÁVEIS por trigger: nunca editar uma
  binding; revoga-se e cria-se nova — ver fusão da Lia abaixo).
- **`ad_accounts`** — uma row por loja; chave estável de todo o reporting/billing.
  `daily_metrics` (spend+vendas por dia, EUR, rollup ÚNICO que alimenta
  Campaigns, Analytics e Billing — os três leem a mesma tabela).
- **Billing**: `ad_account_billing_starts` (data de entrada + baseline, imutável),
  `commissions` (ledger diário certificado), `google_ledger_sync_windows` (prova
  de sync por período), `invoices` + Stripe, `billing_cycle_skips`,
  `billing_automation_runs/items` + `billing_issue_leases` (idempotência da
  emissão em massa).

## Como funciona o billing AGORA (decisão do dono, 2026-08-17)

- **Não há emissão automática.** O commit `e1d32dd` removeu o cron semanal (que
  aliás nunca disparou à segunda: **na Cloudflare, `1` no day-of-week é DOMINGO** —
  usar `MON`). Crons ativos: `0 * * * *` (sync horário) e `55 23 * * *` (fecho do
  dia + reconcile de invoices abertas; NÃO emite).
- A emissão é o botão **"Emitir faturas"** em `/admin/billing` → POST
  `/api/billing/issue-all`. Pre-sync da semana fechada + emissão idempotente
  (leases, blockers fail-closed, alreadyIssued). Gate:
  `BILLING_ISSUANCE_ENABLED === 'true'` (secret do Worker; rearmado a 17/08 —
  se o botão der 503 "Billing issuance is disabled", é esta env, NUNCA remover o
  check do código). Janela: o botão só funciona depois de segunda 14:05 UTC
  (evidence ready). Invoices ficam `open` e aparecem no portal do cliente.
- Cartão "**Por emitir · ciclos fechados**" no topo do /admin/billing mostra o fee
  fechado por emitir (positions.summary.closedSupportedUnissued).
- **Evidência de spend para o ledger** (`commission-sync.ts`): conta COM refresh
  token OAuth → Google direto (como sempre); conta SEM token (onboarding v2) →
  **fallback Windsor** (`fetchGoogleAdsDailyBreakdown`), e o OAuth que falhe em
  runtime também cai para Windsor. Implementado a 17/08.
- **Billing start automático** (`src/lib/billing/auto-start.ts`, regra do dono
  17/08): assim que uma conta tem binding ativa com fonte Google, o sync horário
  cria o start sozinho — `observed_google_counter`, baseline 0, datado do
  **primeiro dia Google-local completo após o `connected_at` da ligação** — e
  ativa a conta (pending→active). Todo o adspend após a entrada do cliente fica
  imediatamente apto para faturação; o dia parcial da entrada nunca é cobrado
  (zero risco de overcharge). Contas não-EUR/identidade divergente ficam de fora
  e continuam a bloquear fail-closed. O passo manual "ativar + criar start" do
  onboarding deixou de existir.

## O que foi corrigido/mudado a 2026-08-17 (commits dessa noite em `main`)

1. **Creatives**: migration 0070 (função SECURITY DEFINER `can_use_creative_account`)
   corrige a RLS que a 0069 partiu para clientes v2 (42501 no INSERT + lista vazia);
   collection URL passou a opcional no form do portal. Verificado live com sessão
   simulada de cliente.
2. **Clients**: `/admin/client-onboarding` → redirect para `/admin/clients` (uma
   única lista, com termos comerciais); componentes mortos apagados
   (clients-manager, reporting-bindings-queue).
3. **Provisioning**: guard novo em `reporting-cutover.ts` — nunca auto-provisionar
   shell shopify-only quando o cliente já tem binding google-only ativa (causa da
   duplicação "Lia Singapura"); teste de regressão validado nas duas direções.
4. **Reporting Shopify**: collection sales voltou ao contrato `TIMESERIES day`
   (o modo horário de 5968b84 partia ranges de 1 dia) e produtos APAGADOS da loja
   deixam de rebentar a família inteira (causa do "Return by Collection" vazio e
   dos `provider_failed` da Miyu) — saem da atribuição, o resto sobrevive.
5. **Windsor adapter**: final_url inválido passou a ser ignorado por-anúncio em vez
   de chumbar a conta inteira; teste do Demand Gen atualizado ao contrato asset-view.
6. **Ledger**: fallback Windsor descrito acima.
7. **Test suite**: as ~24 falhas herdadas (codex commitava sem correr testes) foram
   triadas e corrigidas — ver o commit dessa noite para o detalhe por ficheiro.
8. **Schema**: migrations 0069-0071 commitadas (0069/0070/0071 JÁ APLICADAS no
   live e registadas em `supabase_migrations.schema_migrations` — não re-aplicar).

## Cirurgia de dados executada a 2026-08-17 (backups locais em `audits/backups/`)

- **Lia Singapura** (cliente Diogo e Patricia): tinha 2 ad_accounts com bindings
  ativas (spend Google numa, vendas Shopify noutra, criadas pelo bug do
  provisioning). Fusão: bindings antigas `fac25e9f`/`20aaf7fa` revogadas (audit
  preservado), binding nova emparelhada `7c87f048` na conta original `bf747ff2`,
  dados do shell `18d6d6ef` apagados (7 dm rows re-materializam pelo sync
  horário). O shell ficou como husk `pending` sem dados — as bindings não podem
  ser apagadas por design, logo a conta também não; é inerte e invisível.
- **Orivelle Paris**: shell órfão `69a5d67e` apagado; a creative submission que lá
  estava foi repontada para a conta boa `1574aecd`.
- **Stale**: 5 portal_clients rejected + 3 signups abandonados (auth.users) +
  2 lojas internas nunca ligadas (Eva Lisboa, Elena) apagados. Ficam como lojas
  internas ativas: Store teste e Elena Eger (do Tomás, com dados; excluídas de
  billing/campaigns por serem de admins).
- **Tabelas mortas dropadas** (migration 0071): kanban (boards/cards/…),
  app_secrets, research_comparisons, client_google_ads_reporting_identity_events,
  clients (CRM). A tabela `campaigns` (0 rows) NÃO foi dropada: três funções SQL
  (`active_referral_count`, `ad_account_has_reporting_or_financial_history`,
  `claim_admin_reporting_snapshot_refresh`) ainda a mencionam — limpar essas
  funções primeiro se se quiser dropá-la.
- **Billing starts criados** (decisão do dono: cobrar a semana fechada inteira):
  FITTED Melbourne, Aki Nikko, Hansen Nord e Lia Singapura ficaram `active` com
  start `observed_google_counter`, `google_local_date=2026-08-10`, baseline 0,
  reviewed_by = Bruno. Semana 10-16: FITTED €506,01 · Aki €242,42 · Hansen
  €133,75 · Lia €31,18 → ~€91 de fee novo.

## Estado por área (verificado 2026-08-17 à noite)

- **Clients** ✅ — uma lista, links funcionam ponta-a-ponta e morrem na aprovação
  (último onboarding completo: Guilherme Marques 08-16).
- **Billing** ✅ mecânica / ⏳ emissão — a semana fechada 10-16 (~€443 nas contas
  antigas + ~€91 das novas) está POR EMITIR à espera do clique no botão.
- **Creatives** ✅ — RLS já corrigida live; o fix do form segue no deploy.
- **Campaigns/Analytics** ✅ números (mesma tabela que o billing, igualdade
  verificada ao cêntimo em 3 contas) — o Return by Collection re-materializa após
  o deploy (ranges que terminam hoje refrescam de hora a hora; ranges fechados
  antigos: usar o sync manual da página).

## A semana 10-16 FOI EMITIDA na noite de 17/08 — €530,85 em 10 faturas `open`

O primeiro clique do dono emitiu 3 e bloqueou 13. Causa raiz (não era a evidência
Google — era a Stripe): os customers legacy têm a morada como **strings vazias**
e o guard `assertStripeInvoiceRecipientMatches` comparava `"" !== null` DEPOIS do
finalize — faturas ficavam `open` na Stripe e `draft`+erro localmente, com
retries e reconcile a bater na mesma parede (era também a origem dos
`stripe_issue_failed` históricos, incl. Edgar e Rodrigo). Corrigido em `0832934`
(""≡null nos dois lados, com regressão; morada genuinamente diferente continua a
bloquear). A emissão final foi feita por invocações controladas de
`/api/billing/cron?mode=automatic` com `CRON_SECRET` (gates armados só nessa
janela e **desarmados no fim** — modelo botão-único mantém-se). Reconciliação
final: 13/13 sem erros.

## Pendentes / próximos passos

1. **Diogo e Patricia €3,12** (Lia) ainda bloqueado por `ledger_missing`: a janela
   exata da Yumi falhou antes do fix `7d09ea9` (o fallback Windsor não cobria
   contas com token vivo mas acesso Google revogado — a Yumi). O fecho das 23:55
   refresca a janela com o código novo; o próximo clique no botão emite-o.
2. **Yumi Kyoto: o Google do cliente revogou o acesso do token OAuth**
   (USER_PERMISSION_DENIED) — o reporting de campanhas dela (GAQL legacy) fica
   parado até reconnect (link add_assets google) ou cutover para reporting v2.
3. **Yumi Kyoto**: spend real ZERO desde 08-09 (confirmado na fonte: campanhas
   TOTTEBAGS "ENABLED" mas sem custo desde 08-08 — provável limite/budget/billing
   do lado do cliente; as TOTTEBAGS com spend real são da MIYU, outra conta).
   O sync do ledger dela falha desde 08-15 — com o fallback Windsor deployado
   deve sarar sozinho; se não, investigar o token OAuth dela.
4. **Jedwabi (Guilherme)**: portal não mostra a loja (rollout `v2_ready_for_cutover`
   com conta anchor-only) — fazer o cutover para v2_active quando a loja começar.
   O billing dela e da Orivelle Paris resolve-se sozinho: o auto-start do sync
   horário cria os starts e ativa ambas (Jedwabi a partir de 08-17, Orivelle de
   08-18 — primeiro dia completo após as ligações).
5. **Payouts Stripe**: os 2 "failed" de julho eram débitos de −€39,95
   (`debit_not_authorized` — o banco recusou o direct debit da Stripe para cobrir
   saldo negativo); saldo hoje 0/0 e payout de €100,04 pago a 17/08. Se voltar a
   acontecer: autorizar débitos da Stripe junto do banco.
6. **Rotação de credencial recomendada**: a chave da service account
   `google-ads-reader@adspendapi` foi ecoada num erro de script local a 17/08
   (transcript nesta máquina). Rodar por higiene — e lembrar: essa SA não é a via
   de acesso do Dropscale (Windsor é).
7. **Snapshots fechados imutáveis**: a tabela de campanhas de um range fechado
   nunca re-refresca (adminReportingSnapshotIsStale só envelhece ranges que
   terminam hoje) — divergências pequenas vs rollup ficam congeladas; decidir se
   se permite re-refresh de ranges recentes.
8. **Miyu Yokohama**: start a 08-15 (`observed_google_counter`) mas conta criada a
   08-04 — 11 dias sem faturação; confirmar se foi intencional.

## Madrugada de 18/08 — a cadeia automática completa (doutrina: 2 cliques)

Ordem do dono: além de Sync e Emitir Faturas não existem cliques. Implementado
como cadeia no sync horário E em qualquer clique de Sync (global ou por loja):
`ensureGoogleConnectionMetadata` (moeda/fuso da Windsor — antes só existia no
botão "Test" e uma falha bloqueava a fila como "EUR-only") →
`provisionReviewedClientReportingSources` (contas/bindings/emparelhamento) →
`ensureAutomaticBillingStarts` (start no 1.º dia completo após a ligação) →
`advanceEligibleClientReportingCutovers` (sync de 90 dias + ativação do portal,
com os critérios da própria fila; reviewer = admin da sessão). PROVADO em
produção a 18/08: Guilherme Marques (Jedwabi) convergiu pelo cron e David e
João (Orivelle) convergiu por um clique de Sync — ambos v2_active com portal
aceso, zero toques manuais. Botão **Sync global** no chrome do admin (junto ao
LIVE, todas as páginas; scope all, 7 dias, range calculado no clique).

Moedas (regra do dono): lojas/contas de qualquer moeda europeia; dashboards
reportam SEMPRE em EUR (conversão BCE diária — já feito na camada de
analytics/daily_metrics). Billing de contas GOOGLE não-EUR continua bloqueado
fail-closed por desenho — multi-moeda no billing é mudança estrutural POR
DESENHAR (taxa/data de conversão do fee, desselar constraints EUR-only das
migrations 0034+). Não improvisar.

## Research restaurado (18/08 ~01:45) + afinações de analytics

O **Research** (trends-radar: Markets Overview, Keywords by Market, Market
Comparison via Apify) vivia no branch nunca-merged
`feat/reviewed-full-day-rollover` e desapareceu quando o main foi reconstruído
pela linha v2. Restaurado do tip do branch (páginas, APIs, 344 datasets,
sidebar em 5 línguas) + migration **0074** (recria `app_secrets` e
`research_comparisons`, aplicada live; a comparação em backup foi reinserida).
Token Apify: fallback para o secret `APIFY_TOKEN` do Worker — funciona sem
setup. Lição: antes de dar features por perdidas, verificar branches
não-merged (`git branch -a --contains`).

Afinações da mesma madrugada: thumbnails de criativos (o proxy usava
`redirect:"error"`, que os Workers não suportam — 502 permanente só em
produção; agora "manual"+rejeição de 3xx); enum cru `SQUARE_MARKETING_IMAGE`
removido das linhas de criativos; **split igualitário de spend por produto em
Demand Gen** (regra do dono — o split proporcional à receita igualava o ROAS de
todos os produtos ao da campanha); hover ROAS ancora Today/Yesterday no
calendário real de Lisboa; UM só botão Sync (global, no chrome, que também
sincroniza o ledger financeiro — o "Sync now" da overview e os botões por
página foram removidos).

## Manhã de 18/08 — atribuição campanha↔loja por final URL (regra do dono, commit `b2f3542`)

Uma conta Google partilhada pode alojar campanhas de outra loja (a do Daniel
Azevedo corre as "Lamparas Artesanales" da Casa Luna ao lado das "JP -
TOTTEBAGS" da Aki Nikko). **Regra: uma campanha só conta para uma loja se os
final URLs dos anúncios apontarem para o domínio dessa loja** — em billing,
analytics, campaigns e portal do cliente. Exclusão só com evidência positiva:
campanha sem URL utilizável mantém-se atribuída.

- Predicado central: `src/lib/reporting/store-domain-match.ts`.
- Windsor: `fetchGoogleAdsCampaignFinalUrls` (extraída do campaign breakdown) e
  `fetchGoogleAdsDailyBreakdownForStore` (agrega o timeline por campanha,
  excluindo as estrangeiras). As 5 leituras de `reporting/google.ts`
  (daily/campaigns/timeline/DGEN/PMax) filtram pelos domínios da source
  (`shopify.primaryDomain`/`domain`).
- Ledger: o caminho Windsor do commission-sync usa a leitura filtrada; o
  domínio vem da binding ativa da própria conta (nunca de uma loja irmã).
  **GAP conhecido:** o caminho OAuth legacy continua account-level — todas as
  contas legacy estavam mono-loja no sweep de 18/08.
- Sweep Windsor (ago 2026): só 2 contas contaminadas — Aki (Casa Luna ~€585)
  e Aya Osaka (lumirovaniemi.com ~€366). A conta "Yumi Kyoto" aponta 100%
  para `zatisimorava.com` (sinalizado ao Bruno). A fatura open do Daniel
  (€24,24, ciclo 08-10) inclui €8,78 de fee sobre spend da Casa Luna —
  decisão pendente (manter, anular ou ajustar).
- Nota operacional: o `refreshAll` devolve 502 "degraded" sempre que uma
  família falha (a Yumi suspensa na Google garante isso em todos os runs) —
  alarme falso conhecido; o Bruno mandou deixar a Yumi `active` como está.

### Correção da fatura do Daniel + "void reemite" como feature (0075/0076)

A fatura de €24,24 (ciclo 08-10, com €8,78 de fee sobre Casa Luna) foi
anulada na Stripe e reemitida a **€15,46** (open, `in_1U5k2c…`, 18/08 11:14)
pela máquina real de emissão. Para isso, "cancelar e reemitir" passou a ser
workflow suportado — **migrations 0075+0076, aplicadas live e registadas**:
- o índice único (client, period) não-legacy deixa de contar faturas `void`;
- transitar uma fatura para `void` reabre o item da fila de automação
  (issued→pending) e liberta os claims do ledger (`invoice_commission_rows`
  tem UNIQUE (commission_id) — sem isto a evidência ficava presa para sempre);
- o guard das claims só permite DELETE quando a fatura dona está void;
- o validador de recibos da automação recusa uma fatura void como "issued";
- `calculateWeek`/positions ignoram void na ocupação do slot (a semana volta
  a "Por emitir"); histórico e Payments do cliente continuam a mostrar a void.

**Procedimento para corrigir uma fatura no futuro:** void na Stripe →
reconcile (cron) → sync do ledger → "Emitir faturas" (ou janela armada do
`cron?mode=automatic`). Backup da cirurgia do Daniel em
`audits/backups/reemissao-daniel-2026-08-18-void-invoice.json`.

## Regras de trabalho neste repo

- Node ≥22 (a máquina local tem 20 — usar um Node 22 standalone).
- `npm test` / `npm run typecheck` / `npm run lint` ANTES de push — o CI não corre
  testes; foi assim que a suite chegou a 24 falhas sem ninguém ver.
- Migrations: nunca re-aplicar 0034-0037, 0066-0071; conferir
  `supabase_migrations.schema_migrations` antes de aplicar qualquer uma.
- Deploy: push para `main` → Workers Builds; verificar o check no SHA e só depois
  anunciar. Runbook completo: skill `dropscale-deploy` (máquina do Bruno).
- Bindings/starts/boundaries são imutáveis por trigger — mudanças de identidade
  fazem-se por revoke + create (RPCs), nunca por UPDATE.
