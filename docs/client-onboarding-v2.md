# Client Onboarding V2 — decisão técnica e plano de entrega

**Estado:** primeira implementação funcional; rollout e reporting continuam faseados

**Data:** 2026-08-12

**Âmbito:** coexistência entre `/admin/clients` (Legacy) e `/admin/client-onboarding` (V2), portal do cliente, ligações Shopify para reporting e ligações Google Ads através da Windsor.ai

> **Atualização operacional — 2026-08-14:** a coexistência visual descrita
> abaixo terminou. `/admin/clients` é agora apenas um redirect autenticado para
> `/admin/client-onboarding`; os controlos exclusivos de Google/billing foram
> movidos para `/admin/billing#financial-operations`. As tabelas `ad_accounts`,
> métricas, credenciais e todo o histórico financeiro legacy continuam
> preservados. A migration 0054 faz o cutover através de bindings explícitos e
> auditados, sem copiar nem reescrever esse histórico. O restante documento
> conserva o desenho e as invariantes da fase de coexistência como registo
> histórico, não como contrato atual de navegação.

Este documento fixa a arquitetura usada pela primeira implementação. O schema V2 foi revisto e materializado de forma aditiva; continua proibido qualquer corte destrutivo das ligações atuais ou alteração implícita de faturação.

## 1. Decisão resumida

A transição mantém **duas superfícies de clientes em paralelo**. A página operacional atual continua disponível como **Clients (Legacy)**, sem alteração dos seus dados, ligações ou processos. Uma nova página **Clients** reúne as identidades de portal existentes, as lojas Shopify ativas e os novos onboardings, visualmente inspirada em `/admin/audit/connections`, mas com uma finalidade diferente: gerir identidade de portal e assets permanentes de reporting de cada cliente.

- A nova lista projeta os `portal_clients` existentes e as lojas Shopify legacy ativas sem copiar credenciais, criar sessões ou alterar o estado operacional.
- A lista legacy, as identidades, os assets e todos os registos financeiros permanecem intactos e autoritativos até ao cutover final verificado.
- Durante a coexistência, `/admin/clients` continua a servir a implementação atual e aparece na navegação como **Clients (Legacy)**. A nova superfície usa `/admin/client-onboarding` e aparece como **Clients**, com um badge temporário `New`.
- Todos os clientes criados depois da ativação da V2 entram exclusivamente em **Clients**. Clientes atuais continuam em **Clients (Legacy)** até existir um cutover individual, explícito e aprovado.
- Não existe dual-write entre os dois sistemas. Em cada momento, um cliente tem uma única superfície operacional; dados V2 ainda em onboarding são staging e não alimentam reporting ou billing.
- O onboarding de um cliente novo começa sempre num link criado pela Dropscale sem PII pré-preenchida. O admin escolhe entre **Account only**, sem assets, e **Complete setup**, que pede Shopify e Google Ads e permite ligar todas as lojas e contas usadas pelo cliente. Assets parciais são pedidos mais tarde através de `Add Assets`.
- O wizard mostra entre um e três passos, conforme o link: **Account** é sempre obrigatório; **Shopify stores** e **Google Ads accounts** só aparecem quando foram pedidos.
- Shopify usa uma ligação segura gerida pela Dropscale, reutilizando o padrão técnico já provado em Audit Connections, mas com credenciais, finalidade e scopes mínimos de reporting separados.
- Google Ads usa um co-user authorization link da Windsor.ai restrito a `google_ads`. Como não foi encontrado um contrato público de callback/webhook para a Dropscale, a confirmação é feita por polling server-side dos linked accounts.
- Lojas Shopify e contas Google Ads tornam-se assets independentes. Uma relação explícita entre os dois permite reporting combinado sem voltar a juntá-los numa única linha híbrida.
- A faturação nunca é ativada, alterada ou inferida automaticamente a partir de uma nova ligação. O binding financeiro é uma ação posterior, explícita e auditável.
- `Test Connection` é read-only e dá feedback transitório com fade-out em poucos segundos. `Revoke…` abre uma escolha explícita do alvo; não existe uma revogação genérica com cascata.

## 2. Objetivos

1. Criar `/admin/client-onboarding` como a nova superfície de onboarding e saúde das ligações, preservando `/admin/clients` como Clients (Legacy) durante a transição.
2. Permitir que a Dropscale gere um link e que o cliente forneça o próprio primeiro nome, último nome, email e password.
3. Permitir várias lojas Shopify e várias contas Google Ads por cliente.
4. Distinguir três intenções administrativas:
   - `new_client`;
   - `reconnect`;
   - `add_assets`.
5. Reutilizar o padrão seguro de autorização Shopify já existente sem reutilizar scopes ou tokens de auditoria.
6. Usar a Windsor.ai para autorização e leitura de Google Ads, mantendo a API key apenas no servidor.
7. Tornar os testes, falhas, reconexões e revogações observáveis e idempotentes.
8. Migrar os clientes um a um, com reconciliação explícita de identidade, assets e billing.
9. Preservar integralmente o histórico e as relações atuais até existir prova de paridade por cliente.
10. Manter **Clients (Legacy)** e **Clients** lado a lado durante toda a transição, permitindo criar clientes novos na V2 sem forçar a migração dos clientes atuais.

## 3. Não objetivos da primeira entrega

- Apagar, limpar ou reescrever automaticamente os dados legacy.
- Copiar credenciais legacy para as tabelas novas, fabricar sessões de onboarding ou alterar rollout/billing apenas para preencher o roster.
- Alterar imediatamente Stripe, invoices, commissions, referrals ou datas de início/fim de billing.
- Transformar a ligação de Audit Connections numa ligação permanente de reporting.
- Pedir scopes Shopify de escrita ou scopes que não sejam necessários aos relatórios aprovados.
- Criar, ativar, editar ou remover campanhas como parte do onboarding V2.
- Dar ao cliente operações de escrita em Google Ads através do link de onboarding.
- Assumir que uma loja e uma conta Google Ads com nomes semelhantes pertencem uma à outra.
- Fazer cutover global. A unidade de migração é um cliente revisto e aprovado pelo admin.
- Remover, esconder ou reduzir a capacidade operacional de **Clients (Legacy)** antes de todos os clientes ainda dependentes dela terem sido reconciliados.
- Sincronizar writes automaticamente entre Legacy e V2 ou permitir que as duas superfícies sejam simultaneamente autoritativas para o mesmo cliente.

## 4. Estado atual e fronteiras que não podem ser confundidas

O sistema atual tem três conceitos diferentes:

| Conceito | Fonte atual | Responsabilidade | Invariante |
| --- | --- | --- | --- |
| CRM client | `public.clients` | Registo comercial/financeiro; pode não ter login | Não representa autenticação |
| Portal client | `public.portal_clients` | Identidade de login; `id` corresponde a `auth.users.id` | Não pode ser recriado para “arrumar” dados |
| Ad account/store row | `public.ad_accounts` | Linha legacy que atualmente pode agregar dados da loja e da conta Google Ads e participa em reporting/billing | Não apagar nem reatribuir implicitamente |

O snapshot privado confirmou que nem todo o portal client tem um CRM client correspondente. Portanto, a reconexão não pode assumir essa relação: a identidade canónica para escolher um cliente legacy deve ser o `portal_clients.id`; `crm_client_id` continua opcional.

`ad_accounts` está ligado a campanhas, métricas, billing e histórico financeiro. A V2 deve deixar de o usar como modelo conceptual de “uma loja mais uma conta de anúncios”, mas deve preservá-lo como origem legacy e, quando aplicável, como alvo de um binding financeiro explícito durante o cutover.

### Separação em relação a Audit Connections

Audit Connections concede acesso temporário ou purpose-bound a websites específicos e a scopes de auditoria. Client Onboarding V2 cria relações duradouras para dashboard e reporting. Pode reutilizar componentes, estados e a mecânica segura de links, mas não pode:

- partilhar tokens entre audit e reporting;
- herdar automaticamente os scopes de audit;
- revogar uma ligação de audit ao revogar reporting, ou o inverso;
- considerar uma store auditada como automaticamente onboarded.

## 5. Snapshot privado pré-Windsor

Antes do rollout foi criado um snapshot privado, fora do repositório e com modo `0600`. O path, timestamp, checksum, contagens e dados dos clientes permanecem exclusivamente na memória operacional privada. Não devem ser abertos por UI, enviados ao browser, commitados, anexados a logs ou copiados para documentação pública.

O checksum privado deve ser verificado antes e depois de qualquer exercício de recuperação. Nunca se deve usar o snapshot como seed automático da V2; serve para memória, reconciliação e rollback investigativo.

## 6. Experiência de admin durante a coexistência

### 6.1 Duas superfícies, uma única fonte operacional por cliente

Durante a transição, a navegação de Growth apresenta duas entradas adjacentes:

| Navegação | Rota durante a transição | Responsabilidade |
| --- | --- | --- |
| **Clients** `New` | `/admin/client-onboarding` | Novos clientes, reconexões deliberadas e assets V2 |
| **Clients (Legacy)** | `/admin/clients` | Página operacional atual, clientes existentes e ligações ainda não migradas |

Esta escolha preserva a rota, os bookmarks e os processos atuais. A nova página não substitui `/admin/clients` durante a coexistência. Depois de todos os clientes serem migrados e o período de rollback terminar, a V2 pode assumir `/admin/clients`; nessa altura a rota temporária é redirecionada e a superfície legacy passa para arquivo read-only ou é retirada numa decisão separada.

Regras de routing operacional:

- **Novo cliente:** nasce apenas em **Clients** e nunca recebe uma linha legacy por conveniência.
- **Cliente legacy não iniciado:** continua totalmente operacional em **Clients (Legacy)**.
- **Cliente em migração:** Legacy continua a fonte operacional; os assets V2 permanecem em staging e não alimentam reporting, automações ou billing.
- **Cliente pronto para cutover:** aguarda aprovação explícita depois de reconciliar tudo o que a sessão efetivamente pediu. Num onboarding Account only, identidade confirmada e revisão administrativa bastam; assets, mappings e billing continuam ausentes e separados por definição.
- **Cliente V2 ativo:** **Clients** torna-se a única superfície de writes; a representação legacy fica read-only para histórico e rollback controlado.
- **Rollback:** antes do fecho do período de segurança, o cliente pode regressar a Legacy sem recriar identidades, tokens históricos, invoices ou relações financeiras.

O estado por cliente é explícito e auditável:

1. `legacy_only`;
2. `v2_onboarding`;
3. `v2_ready_for_cutover`;
4. `v2_active`;
5. `rollback_legacy`, apenas quando necessário.

Não há estado em que Legacy e V2 possam executar simultaneamente writes de ligação, reporting ou billing para o mesmo asset. Para clientes ainda em Legacy, novos assets continuam no processo legacy, salvo quando a adição faz parte de uma sessão V2 de migração explicitamente aberta. Depois de `v2_active`, **Add Assets** existe apenas em Clients.

### 6.2 Roster de transição

O roster principal combina sessões/onboardings com uma projeção read-only de clientes existentes. A identidade continua a ser `portal_clients.id`; perfis admin, identidades rejeitadas e utilizadores que são apenas membros de outro workspace não criam cartões próprios. Clientes pendentes aparecem sem assets. Para clientes aprovados, apenas lojas `ad_accounts` ativas, marcadas como Shopify connected e com domínio válido são mostradas. Nenhuma credencial ou ligação Google Ads legacy é enviada ao browser ou importada para as tabelas novas.

As lojas projetadas aceitam os scopes que já têm. O teste de conexão confirma a credencial e a identidade da loja em modo read-only, sem exigir igualdade com o novo profile de scopes. O admin pode gerar uma reconexão Shopify manual quando necessário. Assim que uma ligação nova existe para o mesmo domínio normalizado, ela substitui a representação legacy no roster; o registo legacy permanece por baixo até ao cutover final para preservar reporting, billing e rollback.

O ecrã deve conter:

- resumo de `Connected`, `Onboarding` e `Waiting on review`;
- botão principal **Add client** alinhado à esquerda;
- lista única por cliente, com contagens independentes de Shopify e Google Ads;
- estados de atenção orientados a ações concretas, não uma categoria ambígua;
- atualizações ao vivo ou refresh explícito sem banners persistentes de sucesso;
- acesso secundário a **Reconnect existing**, com pesquisa interna, e ação **Reconnect Shopify** nos cartões com lojas existentes.

Cada cliente tem as ações:

- **Test Connection** — prova read-only de todos os assets ativos, ou escolha de um asset; sem assets, devolve `Not applicable · No assets yet`, nunca um falso sucesso;
- **Add Assets** — gera um link para Shopify, Google Ads ou ambos;
- **Revoke…** — abre um seletor de alvo e mostra exatamente o efeito antes da confirmação.

### 6.3 Modos internos

#### `new_client`

- O admin escolhe Account only ou Complete setup (Shopify & Google Ads) e emite um link sem nome ou email pré-preenchidos.
- A abertura do link inicia o passo Account.
- O cliente cria a própria identidade; só depois liga os assets pedidos.
- A criação de conta é idempotente por sessão e email normalizado. Uma colisão com identidade existente exige login/recovery, nunca a criação silenciosa de uma segunda identidade.

#### `reconnect`

- O admin seleciona internamente um `portal_client` legacy.
- O link público não revela PII no URL nem permite mudar o cliente-alvo.
- No passo Account, o cliente autentica ou prova controlo do email/conta existente; não é criado um novo `auth.users` nem um novo `portal_clients`.
- Os assets reconectados ficam pendentes de mapping e revisão. Não substituem automaticamente tokens, IDs ou bindings financeiros atuais.

#### `add_assets`

- O admin seleciona um cliente já reconciliado e escolhe `shopify`, `google_ads` ou ambos.
- O cliente confirma a identidade e vê apenas os passos pedidos.
- Assets existentes são apresentados como contexto, mas não podem ser reatribuídos por nome. Duplicados estáveis são tratados como retry idempotente; conflitos de owner vão para revisão.

## 7. Wizard do cliente

### Passo 1 — Account

Para `new_client`, recolher no cliente:

- primeiro nome;
- último nome;
- email;
- password.

A password é enviada diretamente ao serviço de autenticação através do fluxo aprovado; não entra em tabelas de onboarding, analytics, telemetry ou logs. O admin nunca vê nem define a password. A sessão de onboarding guarda apenas o identificador da identidade criada/confirmada e timestamps de progresso.

Para `reconnect` e `add_assets`, este passo torna-se confirmação de identidade: login existente e confirmação da sessão autenticada associada. O link de admin deixa de ser prova suficiente assim que a identidade é reclamada.

### Passo 2 — Shopify stores

- Mostrar **Connect store** e, após sucesso, **Add another store**.
- Cada tentativa tem estado próprio: `pending`, `authorizing`, `verifying`, `connected`, `failed` ou `revoked`.
- Validar e guardar o domínio canónico da store; nomes apresentados não são identidade técnica.
- A conexão é criada pela Dropscale para reporting, com scopes mínimos determinados pelos campos de relatório efetivamente aprovados.
- Tokens permanecem server-side e cifrados; nunca atravessam props de Client Components, query strings, logs ou analytics.
- O transporte e os controlos podem seguir o padrão de Audit Connections, mas o registo, purpose e credenciais são separados.
- O passo fica completo quando todas as tentativas obrigatórias estão verificadas e existe pelo menos uma store se Shopify foi marcado como obrigatório. Caso contrário, o cliente pode continuar de acordo com a configuração da sessão.

A Windsor também documenta um [conector Shopify](https://windsor.ai/shopify-configuration-guide/) e os respetivos [campos de dados](https://windsor.ai/data-field/shopify/), mas a decisão inicial é manter Shopify na ligação segura da Dropscale. Isto reduz dependência no fornecedor e reaproveita a implementação já validada sem alargar os scopes de audit.

### Passo 3 — Google Ads accounts

- A Dropscale pede server-side à Windsor um co-user link restrito a `google_ads`.
- O browser recebe apenas o `connect_url` temporário; nunca recebe a API key Windsor.
- O cliente completa o OAuth Google na Windsor e pode selecionar uma ou mais contas.
- Ao regressar ao wizard, **Check connection** inicia polling server-side; o backend também pode continuar polling com backoff limitado.
- As contas encontradas são apresentadas para confirmação e é possível ligar mais do que uma.
- O passo termina quando existe pelo menos uma conta confirmada, se Google Ads era obrigatório, e todos os conflitos foram resolvidos.

A Windsor documenta a geração de [authorization links para utilizadores externos](https://windsor.ai/documentation/authorize-via-link-in-windsor/) e a listagem de co-user linked accounts na [API oficial](https://windsor.ai/api-documentation/). A documentação pública consultada não define um callback/webhook para notificar a Dropscale da conclusão. Por isso, a primeira versão usa polling em vez de simular um callback.

Para links novos, a resposta de linked accounts pode ser filtrada pelo `access_token` emitido para aquele authorization link. Esse token é um segredo de correlação: guardar cifrado, usar apenas no servidor e redigir de logs. Links legacy sem token visível exigem reconciliação manual por `datasource` e account ID.

## 8. Modelo conceptual de dados

A migration aditiva implementa o núcleo desta separação. O binding financeiro Legacy continua deliberadamente fora da primeira migration:

### `client_rollout_states`

- um registo único por `client_id`, criado apenas para clientes novos V2 ou clientes cuja migração foi deliberadamente iniciada;
- `operational_surface`: `legacy_only | v2_onboarding | v2_ready_for_cutover | v2_active | rollback_legacy`;
- referência opcional à sessão de onboarding/migração em curso;
- `updated_by` e `updated_at` para a última transição;
- nenhuma credencial, payload Windsor/Shopify ou dado financeiro duplicado;
- transições validadas numa função/transaction administrativa, não por updates livres no browser.

Clientes legacy que nunca iniciaram migração podem ser tratados como `legacy_only` por defeito sem backfill. Um cliente novo criado diretamente na V2 passa por `v2_onboarding` e só chega a `v2_active` após review; não recebe uma representação operacional Legacy.

### `client_onboarding_sessions`

- ID opaco e token público armazenado apenas como hash;
- `mode`: `new_client | reconnect | add_assets`;
- `target_portal_client_id`, nulo apenas antes da criação no modo novo;
- tipos de asset pedidos; `new_client` aceita apenas a lista vazia (Account only) ou ambos os tipos (Complete setup), enquanto `add_assets` e `reconnect` exigem Shopify, Google Ads ou ambos;
- estado, expiração, consumo e revogação;
- criador admin e timestamps;
- nenhuma PII no token/URL.

### `client_shopify_connections`

- owner `portal_client_id`;
- domínio canónico e nome de apresentação;
- referência à credencial cifrada, scopes concedidos e purpose `reporting`;
- estado, `last_tested_at`, erro redigido e timestamps de revoke;
- identidade única pelo identificador técnico Shopify, não pelo nome.

### `client_google_ads_connections`

- owner `portal_client_id`;
- `datasource` Windsor e account ID estável;
- nome de apresentação, moeda/timezone quando disponíveis;
- referência à autorização/co-user link, sem guardar a API key por linha;
- estado, `last_tested_at`, erro redigido e timestamps de revoke;
- unicidade por workspace Windsor + datasource + account ID.

### `client_asset_mappings`

- relação explícita entre uma Shopify store e uma Google Ads account;
- no primeiro release, cada Google Ads account tem no máximo uma Shopify store selecionada no mapping; uma store pode receber várias contas;
- finalidade (`reporting`, e futuramente outras), validade temporal e autor da confirmação;
- nunca criado apenas por igualdade de nome.

### `legacy_ad_account_bindings`

- modelo planeado para a fase de cutover; **não existe na primeira migration**;
- binding explícito de um asset/mapping V2 a uma linha `ad_accounts` legacy;
- só é criado depois de comparação e aprovação administrativa;
- unicidade e idempotency key impedem ligar duas identidades V2 à mesma linha financeira por acidente;
- não altera retroativamente invoices, ledger windows ou datas de billing.

## 9. Integração Windsor Google Ads

### 9.1 Contrato da integração

- Todas as chamadas autenticadas são server-to-server.
- A API key vive no secret store já aprovado e nunca é serializada para o browser, DB de aplicação, erros ou logs.
- Gerar co-user URL com `allowed_sources=google_ads`.
- Correlacionar as contas retornadas com a sessão, usando o access token de links novos quando disponível.
- Fazer upsert idempotente pelo identificador estável da conta.
- Se uma conta já estiver atribuída a outro cliente, bloquear e pedir revisão; nunca “mover” automaticamente.
- Respeitar `429` com backoff e não manter polling infinito.
- Não usar forced hourly refresh no plano Basic.

Fontes de implementação:

- [Windsor Connectors API](https://windsor.ai/api-documentation/)
- [Authorize via Link](https://windsor.ai/documentation/authorize-via-link-in-windsor/)
- [Google Ads connector installation](https://windsor.ai/documentation/connector-setup-guides/google-ads-installation/)
- [Google Ads field reference](https://windsor.ai/data-field/google_ads/)
- [Google Ads actions discovery endpoint](https://connectors.windsor.ai/google_ads/actions)

### 9.2 Resultados da investigação de 2026-08-12

Os testes foram feitos sem copiar a API key para o repositório ou para este documento.

- A workspace Windsor devolveu múltiplas contas Google Ads ligadas, confirmando que a credencial e a leitura multi-account funcionam.
- O catálogo `GET /google_ads/actions` devolveu **31 actions**.
- Uma leitura normal a uma conta piloto autorizada funcionou.
- Uma tentativa de leitura com `refresh_since=3d&refresh_interval=1h` devolveu HTTP `403`: `Hourly data is not available for BASIC subscription plan.`
- A leitura normal, sem forced hourly refresh, continuou a funcionar. A API documenta `6h` como `refresh_interval` por defeito; a V2 deve aceitar os dados normalmente disponibilizados pelo plano Basic e mostrar a frescura observada em vez de prometer realtime.
- A action `create_campaign` funcionou na conta piloto e criou uma campanha de teste com estado **PAUSED**.
- O catálogo atual não expõe `remove_campaign`. Não se deve inventar um endpoint de remoção: a campanha deve permanecer pausada até ser removida no Google Ads por um processo suportado.

Este resultado prova capacidade de leitura e prova que write actions podem estar habilitadas nesta workspace. Não torna a escrita de campanhas parte do onboarding, nem garante que todas as contas/roles tenham autorização de escrita. O [guia de instalação Google Ads](https://windsor.ai/documentation/connector-setup-guides/google-ads-installation/) distingue a conexão OAuth de leitura das permissões de conta necessárias para write-back.

### 9.3 Escrita de campanhas: fase opcional

Antes de qualquer feature de lançamento são obrigatórios:

- capability discovery em runtime; nunca assumir uma action;
- permissão admin separada de onboarding/reporting;
- allowlist explícita de contas de teste;
- criação sempre `PAUSED` por defeito;
- confirmação humana com resumo de account, budget, channel e bidding;
- idempotency key para impedir duplicação por retry;
- audit log imutável de request redigido, resultado e autor;
- limites de budget e bloqueio de enable automático;
- runbook de cleanup que não dependa de `remove_campaign`, enquanto essa action não existir.

Até estes controlos existirem, a UI de clientes não apresenta botões de lançamento de campanhas.

## 10. Test Connection

`Test Connection` é um health check, não uma sincronização destrutiva nem um teste de escrita.

### Shopify

- Obter identidade básica da shop e executar a menor query de reporting aprovada.
- Confirmar domínio, scopes mínimos e resposta autenticada.
- Nunca pedir scopes adicionais durante um teste.

### Google Ads

- Fazer uma leitura mínima pela Windsor para a conta exata, sem forced hourly refresh.
- Confirmar que a resposta pertence ao datasource/account ID guardado.
- Não criar, pausar, ativar ou editar campanhas.

### UX

- Mostrar `Testing…` no botão/asset.
- Em sucesso, mostrar toast/alert verde com fade-in e fade-out automático em aproximadamente 4 segundos.
- Em falha, mostrar uma mensagem redigida e acionável; a saúde do asset pode ficar marcada como `Needs reconnection`, mas não manter um banner verde stale.
- Guardar server-side apenas `last_tested_at`, resultado normalizado e código de diagnóstico seguro. Nunca guardar payload bruto ou tokens.
- No teste agregado de cliente, devolver um resultado por asset; sucesso parcial não aparece como sucesso total.
- Num cliente sem assets, o resultado agregado é `not_applicable`; `Promise.all([])`/`every([])` nunca é apresentado como ligação saudável.

## 11. Revogação: semânticas separadas

O botão do cartão deve chamar-se **Revoke…** e abrir uma confirmação com o alvo. As operações possíveis não são equivalentes:

1. **Revoke onboarding link**
   - invalida apenas a sessão/link ainda não concluído;
   - preserva a identidade Auth/auditável; invalida e revoga apenas os assets criados por essa sessão ainda aberta.
2. **Disconnect Shopify reporting asset**
   - revoga/invalida a credencial de reporting da Dropscale para aquela store;
   - não toca numa ligação de audit, noutras stores ou em billing/history.
3. **Disconnect Google Ads asset from Dropscale**
   - desativa a utilização do asset na Dropscale e preserva histórico/mapping para auditoria;
   - não altera campanhas.
4. **Unlink Google Ads account in Windsor — fase posterior**
   - não é exposto pela primeira implementação; o primeiro release remove apenas a ligação guardada pela Dropscale e diz explicitamente que não remove a autorização na Windsor/Google;
   - quando for implementado, deve usar o contrato Windsor documentado para o datasource/account ID e permanecer uma ação separada, com confirmação e resultado verificável;
   - não pode ser inferido a partir de um `Revoke asset` da Dropscale nem afetar outras contas do mesmo authorization link.
5. **Disable portal access**
   - operação de identidade separada, apenas quando explicitamente escolhida;
   - nunca é consequência de revogar um asset.

Nenhuma destas ações faz `DELETE` de `portal_clients`, `ad_accounts`, invoices ou ledger rows. Uma futura eliminação legal de dados exige um processo próprio e não deve reutilizar este botão.

## 12. Invariantes de segurança e billing

1. **Zero destruição no rollout:** a V2 pode começar vazia, mas nenhum registo legacy é apagado, ocultado da recuperação ou reescrito.
2. **Identidade estável:** preservar `auth.users.id`, `portal_clients.id`, memberships e invites. Reconectar não é registar novamente.
3. **Billing identity estável:** preservar `stripe_customer_id`, billing profiles e qualquer identidade fiscal/Stripe associada.
4. **Histórico imutável:** invoices, commission ledger, billing starts/ends, referrals e termos históricos não são recalculados pela reconexão.
5. **Sem billing automático:** concluir OAuth ou ligar uma store não inicia faturação, não cria invoice e não muda datas de serviço.
6. **Binding explícito:** só um admin pode aprovar o binding de assets V2 a uma linha financeira legacy, depois de comparar IDs e contexto.
7. **Sem cascatas de revoke:** a revogação atua apenas no alvo selecionado e preserva o histórico necessário para billing e auditoria.
8. **Least privilege:** Shopify recebe apenas scopes de reporting; Windsor fica restrita a Google Ads no link; write actions não são expostas ao cliente.
9. **Segredos server-side:** API keys, access tokens, Shopify tokens e URLs temporários não entram em logs, analytics, erros ou props hidratadas.
10. **Links limitados:** tokens opacos de alta entropia, hash em repouso, expiração, single-purpose e revogação. O contador de tentativas fica reservado para um rate limit purpose-bound posterior e não é apresentado como proteção ativa nesta entrega.
11. **Idempotência:** retries não criam utilizadores, assets, mappings, campanhas ou bindings duplicados.
12. **Conflitos param:** um asset já associado a outro owner nunca é reatribuído automaticamente.
13. **Observabilidade redigida:** estados e códigos são visíveis; PII e credenciais não são.
14. **Rollout reversível:** a nova rota pode ser retirada da navegação sem tocar nos dados; Clients (Legacy) continua disponível sem restauração de dados.
15. **Coexistência sem dual-write:** Legacy e V2 podem estar visíveis ao mesmo tempo, mas só uma superfície é operacional para cada cliente/asset.
16. **Novos clientes só na V2:** depois da ativação da nova superfície, o processo legacy deixa de criar novos clientes; permanece apenas para operar e migrar os atuais.
17. **Legacy sempre recuperável:** enquanto existir qualquer cliente em `legacy_only`, `v2_onboarding`, `v2_ready_for_cutover` ou `rollback_legacy`, a página e os handlers necessários de Clients (Legacy) não podem ser removidos.

## 13. Fases de entrega

### Fase 0 — baseline e desenho — concluída

- Snapshot privado preservado, arquitetura documentada, scopes Shopify definidos e `/admin/clients` mantido como Legacy.

### Fase 1 — protótipo local da página — concluída

- A experiência foi revista localmente em `/preview/admin/clients`, sem autenticação, dados reais ou writes.
- O preview continua exclusivamente read-only e devolve `404` em produção.
- Os adapters reais ficaram ligados apenas à rota admin autenticada `/admin/client-onboarding`; o preview não partilha writes com essa rota.

### Fase 1.5 — coexistência das duas páginas — implementada

- Restaurar/manter a implementação operacional atual em `/admin/clients` com a label **Clients (Legacy)**.
- Montar o roster V2 em `/admin/client-onboarding` com a label **Clients** e badge temporário `New`.
- Colocar as duas entradas lado a lado na navegação de Growth.
- Mostrar na página Legacy o estado de migração, sem alterar o comportamento dos clientes ainda `legacy_only`.
- Projetar de forma read-only os clientes existentes e as lojas Shopify ativas, sem copiar credenciais, criar sessões ou mudar rollout.
- Manter a nova rota dentro do gate de admin; retirar a entrada de navegação esconde apenas Clients V2 e deixa Clients (Legacy) inalterado.

### Fase 2 — sessões e identidade — implementada

- Rever e aprovar migrations e tipos separadamente.
- Implementar emissão/expiração/revogação de links.
- Implementar Account para novo cliente e confirmação segura para clientes existentes.
- Garantir que colisões de email entram em login/recovery.
- Direcionar todo o onboarding de novos clientes para Clients V2; o botão/processo legacy de criação de cliente deixa de ser a entrada normal, sem afetar manutenção dos clientes existentes.

### Fase 3 — Shopify reporting — ligação e staging implementados

- Criar a conexão purpose-bound e multi-store.
- Validar scopes mínimos e armazenamento cifrado.
- Implementar health check e revoke isolado.

### Fase 4 — Windsor Google Ads — ligação e staging implementados

- Integrar geração de co-user URL restrita a Google Ads.
- Implementar polling, correlação por link, seleção multi-account e conflitos.
- Implementar leitura normal compatível com Basic e health check. O unlink Windsor permanece uma ação futura separada.

### Fase 5 — reconexão controlada — em curso

- Mostrar os clientes existentes e validar as lojas Shopify já ligadas.
- Ligar Google Ads novamente através da Windsor; nunca projetar a ligação Google legacy como concluída.
- Reconciliar identidade, stores, contas Google Ads, mappings e billing binding.
- Comparar dashboards/relatórios e passar os critérios abaixo.
- Marcar `v2_active` apenas numa transação administrativa explícita; nesse momento Legacy torna-se read-only para esse cliente.
- Só depois repetir cliente a cliente. Não existe bulk cutover.

### Fase 5.5 — conclusão da coexistência

- Confirmar que não existem clientes dependentes de `legacy_only`, `v2_onboarding`, `v2_ready_for_cutover` ou `rollback_legacy`.
- Manter uma janela de rollback aprovada após o último cutover.
- Só depois promover Clients V2 para `/admin/clients` e decidir se Clients (Legacy) permanece como arquivo read-only.
- Criar redirects e atualizar bookmarks apenas nesta fase; nunca durante a primeira ativação da V2.

### Fase 6 — campaign actions opcional

- Desenhar autorização, approvals, budgets, audit log e cleanup.
- Testar apenas em contas allowlisted e sempre com criação pausada.
- Não disponibilizar a clientes até existir revisão de segurança e produto separada.

## 14. Critérios de aceitação

### Dados e rollout

- Com os dados legacy preservados, a nova lista mostra as contas existentes e as lojas Shopify ativas sem criar novos logins nem alterar registos operacionais.
- A navegação mostra simultaneamente **Clients** e **Clients (Legacy)** durante a coexistência.
- `/admin/clients` continua a abrir a página operacional Legacy, com os handlers e ligações atuais funcionais.
- `/admin/client-onboarding` combina clientes existentes, lojas Shopify válidas e sessões novas, sem importar ligações Google Ads legacy.
- Um cliente novo aparece apenas na V2 e não cria automaticamente um cliente/asset legacy.
- Um cliente em migração tem um único estado explícito e nunca é writable nas duas superfícies ao mesmo tempo.
- Um cliente `v2_active` fica read-only na superfície Legacy; um cliente `legacy_only` não é afetado pela V2.
- O checksum do snapshot continua igual.
- A entrada V2 pode ser escondida sem restaurar dados nem alterar a página Legacy.
- Nenhuma migração faz delete/cascade ou backfill automático de billing.

### Link e identidade

- Um admin consegue gerar um link de novo cliente para Account only ou Complete setup (Shopify & Google Ads). Links `add_assets` e `reconnect` permitem Shopify, Google Ads ou ambos.
- O registo público legacy deixa de criar novos clientes; `/register` explica que o acesso é por convite e mantém login/recovery de utilizadores atuais.
- O link de novo cliente não contém nome, email, client ID legível, API key ou outro PII/segredo.
- Um novo cliente fornece primeiro nome, último nome, email e password e consegue entrar na dashboard após o fluxo aprovado.
- Um novo utilizador sem assets consegue submeter e ser aprovado numa única ação administrativa, que ativa imediatamente o acesso à dashboard; `Add assets` continua disponível no cartão sem badges redundantes.
- Reconexão e Add Assets usam a identidade existente; não criam um segundo auth user/portal client.
- Links expirados, usados ou revogados falham de forma segura.

### Assets

- Um cliente pode ligar várias Shopify stores e várias Google Ads accounts na mesma sessão.
- Cada asset tem owner e identificador técnico estável; retry é idempotente.
- Uma conta já pertencente a outro cliente gera conflito e não é movida.
- Store e Google Ads account só ficam associadas por mapping explícito.
- A conclusão do onboarding não inicia billing.

### Windsor

- A API key nunca aparece no browser, logs, DB de onboarding ou exceptions.
- O co-user link permite apenas Google Ads.
- A Dropscale deteta conclusão por polling e suporta mais do que uma conta.
- O health check funciona no plano Basic sem `refresh_interval=1h`.
- Nenhuma write action é executada por Test Connection ou pelo wizard.

### Test e revoke

- O teste devolve estado por asset e não mascara sucesso parcial.
- O aviso verde faz fade-out automático em poucos segundos e não fica stale.
- `Revoke…` indica o alvo e o efeito antes de executar.
- Revogar uma store não revoga Google Ads, Audit Connections, portal access ou billing.
- Revogar uma conta Google Ads não apaga campanhas, invoices ou histórico.

### Billing e regressão

- `stripe_customer_id`, billing profiles, memberships, invoices, ledger e datas de billing do cliente piloto permanecem inalterados até aprovação explícita.
- O binding V2 → legacy é único, auditável e repetível sem duplicar dados.
- O cliente piloto mantém login e acesso à informação histórica.
- Typecheck, lint, testes de integração/RLS e build passam antes de qualquer push.
- O deploy só é aceite depois de Workers Builds concluir para o SHA esperado e a página live ser verificada.

## 15. Decisões de rollout ainda abertas

1. Quais campos exatos entram no primeiro adapter de reporting do portal, dentro dos scopes Shopify read-only já aprovados?
2. Decisão aprovada: no onboarding de cliente novo, assets são configuráveis por link e podem ser zero; `add_assets` e `reconnect` continuam a exigir pelo menos um tipo.
3. Quem aprova o mapping store ↔ Google Ads account quando existe mais do que um asset de cada lado?
4. Qual é a unidade financeira futura: store, Google Ads account, mapping ou um billable group separado?
5. Por quanto tempo ficam disponíveis links Dropscale e co-user links Windsor, e qual é o processo de regeneração?
6. O unlink Windsor deve estar no primeiro release ou só o disconnect lógico da Dropscale?
7. Que cliente interno será o piloto antes da reconexão individual dos restantes?
8. Qual é a duração da janela de rollback após cada cliente passar a `v2_active`?

As decisões ainda abertas devem ser resolvidas antes das fases que delas dependem. A implementação V2 inicial, migration, commit, push e deploy foram autorizados explicitamente pelo owner, mantendo as invariantes deste documento: nada destrutivo, billing separado, rollout cliente a cliente e Clients (Legacy) preservado. A ativação de sessões com assets permanece bloqueada até o adapter de reporting V2 alimentar o portal; apenas Account only pode ser ativado nesta entrega.
