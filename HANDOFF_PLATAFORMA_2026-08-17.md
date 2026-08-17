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

## Pendentes / próximos passos

1. **Emitir a semana 10-16** (botão). Daphne Rhodes + Trad Glod (€149,11) tinham
   `ledger_missing` por falha transitória do pre-sync — o próprio botão re-tenta;
   se bloquear, repetir o clique. As 4 contas novas emitem depois do deploy do
   fallback Windsor (sem ele ficam blocked, nunca sub-faturadas).
2. **Edgar e Rodrigo €42,14** preso em `stripe_issue_failed` desde 08-11 — re-tenta
   no próximo batch (sem invoice órfã na Stripe, sem risco de duplicação).
3. **Yumi Kyoto**: spend real ZERO desde 08-09 (confirmado na fonte: campanhas
   TOTTEBAGS "ENABLED" mas sem custo desde 08-08 — provável limite/budget/billing
   do lado do cliente; as TOTTEBAGS com spend real são da MIYU, outra conta).
   O sync do ledger dela falha desde 08-15 — com o fallback Windsor deployado
   deve sarar sozinho; se não, investigar o token OAuth dela.
4. **Jedwabi (Guilherme)**: portal não mostra a loja (rollout `v2_ready_for_cutover`
   com conta anchor-only) — fazer o cutover para v2_active quando a loja começar;
   mesmo padrão para Orivelle Paris quando gastar (ambas ficaram `pending`, sem
   billing start — criar start quando ativarem, senão repete-se o buraco do fee).
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
