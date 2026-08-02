# Dropscale IO — API de leitura para o relatório diário

Versão 2. Muda duas coisas em relação à primeira: existe um parâmetro
`?ao_vivo=1`, e está explicada a razão de os números não baterem certo com o
painel — que eram **duas** razões, não uma.

---

## O endpoint

```
GET https://dropscale.app/api/reports/daily?data=2026-07-30&ao_vivo=1
Authorization: Bearer <CHAVE>
```

| Parâmetro   | Obrigatório | Descrição                                                        |
|-------------|-------------|------------------------------------------------------------------|
| `data`      | não         | `AAAA-MM-DD`. Sem ele, devolve o **dia anterior** contado em Lisboa. |
| `cliente`   | não         | Restringe a um cliente (o `id` que vem na resposta).             |
| `campanhas` | não         | `0` devolve as lojas sem campanhas — bastante mais rápido.        |
| `ao_vivo`   | não         | `1` recalcula o dia a partir do Google e do Shopify antes de responder. **Uma vez por noite, nunca em polling.** |

Só leitura no que toca aos vossos dados — a chave não permite alterar nada.
`ao_vivo=1` escreve no nosso agregado interno, o que é justamente o que faz as
leituras baratas do resto do dia passarem a devolver os mesmos números.

### Custo do `ao_vivo=1`

Uma chamada por loja a cada API externa (Google Ads e Shopify). Com muitas lojas
demora dezenas de segundos. Se der timeout, dividam por cliente com
`?cliente=<id>` — a lista de ids vem numa chamada normal com `campanhas=0`.

### Códigos

| Código | Quando                                                           |
|--------|------------------------------------------------------------------|
| 200    | Relatório gerado.                                                |
| 400    | `data` não está em `AAAA-MM-DD`.                                 |
| 401    | Chave em falta ou errada.                                        |
| 404    | Não há clientes para o pedido.                                   |
| 503    | Configuração em falta do nosso lado.                             |

Dias sem actividade não são omitidos: o cliente e as lojas vêm com zeros. O que
distingue "não gastou" de "faltam dados" é o `atualizado_em` de cada loja.

### Resposta

Cada cliente traz **`totais`** (todas as lojas somadas — é a vista que o cliente
vê no Dashboard dele) e a lista de **`lojas`**, cada uma com o mesmo conjunto de
campos.

```json
{
  "data": "2026-07-23",
  "moeda": "EUR",
  "fuso_horario": "conta de anúncios / loja",
  "clientes": [
    {
      "id": "0f1c8f2a-…",
      "nome": "Tomás Santos",
      "email": "tomas@exemplo.com",
      "comissao_agencia": 0,
      "totais": {
        "receita_bruta": 317.84,
        "devolucoes": 0,
        "receita": 317.84,
        "encomendas": 5,
        "gasto": 61.99,
        "impressoes": 4231,
        "cliques": 149,
        "custo_produtos": 102.47,
        "taxas_pagamento": 9.45,
        "envio": 0,
        "taxa_dropscale": 0,
        "revenue_share": 0,
        "custos_totais": 173.90,
        "lucro_liquido": 143.94,
        "margem": 0.4529,
        "roas": 5.13,
        "mer": 5.13,
        "aov": 63.57,
        "custo_por_encomenda": 12.40,
        "taxa_conversao": 0.0336,
        "conversoes": 4,
        "receita_google": 254.30,
        "encomendas_google": 4,
        "roas_google": 4.10
      },
      "lojas": [
        {
          "id": "56a6157d-…",
          "nome": "Store teste",
          "dominio": "storeteste.com",
          "receita": 317.84,
          "gasto": 61.99,
          "encomendas": 5,
          "lucro_liquido": 143.94,
          "atualizado_em": "2026-07-24T02:14:07.881Z",
          "campanhas": [
            {
              "id": "gads-56a6157d-…-2213…",
              "nome": "PMax - PT",
              "plataforma": "google",
              "estado": "ativa",
              "inicio": "2026-07-12",
              "dias_a_rodar": 12,
              "gasto": 61.99,
              "conversoes": 2
            }
          ]
        }
      ]
    }
  ]
}
```

*(As lojas trazem os mesmos campos de `totais`; abreviado aqui só para o exemplo
não ficar do tamanho de uma página.)*

### Os campos numéricos, e a que card correspondem

Estes são exactamente os números do Dashboard do cliente. Podem abri-lo para o
mesmo dia e confrontar — se algum não bater, é um bug nosso e queremos saber.

| Campo                 | Card no painel        | Nota                                       |
|-----------------------|-----------------------|--------------------------------------------|
| `receita`             | REVENUE               | Líquida de devoluções.                     |
| `receita_bruta`       | —                     | Antes de devoluções.                        |
| `devolucoes`          | REFUNDS               |                                             |
| `encomendas`          | ORDERS                |                                             |
| `gasto`               | AD SPEND              |                                             |
| `impressoes`          | (hint do AD SPEND)    |                                             |
| `lucro_liquido`       | NET PROFIT            | `receita − custos − gasto`. **A nossa fee NÃO é descontada** — ver nota abaixo. |
| `margem`              | (hint do NET PROFIT)  | 0–1. `0.4529` = 45,29 %.                    |
| `roas` / `mer`        | ROAS / MER            | Receita ÷ gasto. **Não** é o ROAS do Google. |
| `aov`                 | AOV                   |                                             |
| `custo_por_encomenda` | COST / CONVERSION     | Gasto por encomenda da loja.                |
| `taxa_conversao`      | CONVERSION RATE       | 0–1. Encomendas por clique.                 |
| `custo_produtos`      | Cost breakdown → COGS |                                             |
| `taxas_pagamento`     | Cost breakdown        |                                             |
| `envio`               | Cost breakdown        |                                             |
| `taxa_dropscale`      | Cost breakdown        | Comissão de gestão sobre o gasto.           |
| `custos_totais`       | Cost breakdown        |                                             |
| `revenue_share`       | —                     | Não aparece no painel do cliente.           |
| `conversoes`          | —                     | Encomendas **menos** as vindas do Instagram/Facebook. `null` se ainda não foi calculado para esse dia. |
| `receita_google`      | GOOGLE REVENUE (card Share) | Receita **sem** referências do Instagram/Facebook. `null` enquanto o dia não tiver atribuição calculada. |
| `encomendas_google`   | (hint do GOOGLE REVENUE) | As encomendas dessa receita. Mesmo valor que `conversoes`. |
| `roas_google`         | ROAS (card Share)     | `receita_google ÷ gasto`. `null` acompanha `receita_google`; `0` se não houve gasto. |

Percentagens vêm como fracção (`0.4529`), não como `45.29` nem como texto.

### `receita_google` não é "atribuída pelo Google"

O nome vem do rótulo do painel, mas leia-se como **tudo menos Meta**: directo,
orgânico, email, TikTok e qualquer outro canal entram nesta receita. O que fica
de fora são apenas as encomendas que o Instagram ou o Facebook referenciaram.

A receita realmente atribuída pelo Google Ads é outra coisa e costuma andar perto
de zero, porque o conversion tracking raramente está configurado — é por isso que
não a usamos para nada que o cliente veja.

### `lucro_liquido` deixou de descontar a nossa fee

Mudança de comportamento num campo que já existia. Um cliente que negociou até
€50 de lucro fez €50, deva-nos €10 depois ou não — a fee é uma factura à parte,
não um custo de exploração. O painel passou a fazer o mesmo, e a API tinha de
acompanhar, senão os dois reportavam números diferentes para o mesmo dia.

`taxa_dropscale` continua a ser enviada, por isso quem quiser o valor depois da
fee subtrai-a: `lucro_liquido − taxa_dropscale`.

---

## Porque é que o painel e a API não davam o mesmo

Duas causas independentes. O `?ao_vivo=1` resolve a primeira e **não** resolve a
segunda — e isso é deliberado.

### 1. Frescura — resolvida

O caso **Tomas e Tomas**: 11,75 € no painel, 0 € na API.

Não havia linha nenhuma no agregado para aquele dia: a loja nunca tinha sido
sincronizada. O zero não queria dizer "não gastou", queria dizer "nunca foi
calculado" — e era o `atualizado_em: null` a assinalá-lo.

A vossa leitura estava certa: abrir o `/admin/campaigns` não actualiza o
agregado, porque essa página não escreve nada, só consulta o Google ao vivo.
Com `ao_vivo=1` o dia é recalculado na hora e este caso desaparece.

### 2. Método de cálculo — não resolvida, e não deve ser

O caso **Diogo Barbosa**: 43,71 € no painel, 51,83 € na API — a API *acima*.

Desactualização só explica ficar abaixo, nunca acima. A diferença é outra:

- O painel pergunta ao Google `FROM campaign` e **soma campanha a campanha**.
- O agregado, e portanto a API, pergunta `FROM customer` — o **total da conta**.

O total da conta inclui gasto que a listagem por campanha não devolve (campanhas
removidas, sobretudo). Por isso o número da API tende a ser igual ou maior, e é
o mais próximo do que o Google efectivamente cobrou.

Ou seja: se depois do `ao_vivo=1` ainda virem uma diferença deste tipo, **é o
painel que está a sub-reportar, não a API**. Não alinhámos os dois escolhendo o
número mais baixo, que seria a forma fácil de fazer a discrepância desaparecer
sem a resolver.

---

## As duas ressalvas que se mantêm

### O dia não fecha à meia-noite de Lisboa

O `data=` é interpretado em Lisboa e, sem parâmetro, devolvemos o dia anterior
contado em Lisboa. Mas os números por dia vêm agregados no fuso da **conta de
anúncios** (gasto) e no da **loja** (receita e encomendas). Para contas e lojas
portuguesas coincide; para uma loja noutro fuso, não. O campo `fuso_horario`
diz-vos isso na própria resposta.

### `conversoes` e o ROAS do Google

`roas` é receita líquida ÷ gasto, calculado da receita real do Shopify — não é o
ROAS atribuído pelo Google, que é quase sempre 0 porque poucas lojas têm
conversion tracking configurado. Pela mesma razão, `conversoes` por campanha
costuma vir 0. **As vendas reais estão em `encomendas`, ao nível da loja.**

---

## Campos

| Campo pedido            | Estado | Nota                                                        |
|-------------------------|--------|-------------------------------------------------------------|
| `id` / `email` cliente  | ✅     | `id` é um UUID estável. É por aí que devem ligar às salas.  |
| loja `nome`             | ✅     |                                                             |
| loja `dominio`          | ⚠️     | `null` se a loja ainda não foi ligada ao Shopify.           |
| loja `gasto`            | ✅     | Total da conta Google. Ver secção acima.                    |
| loja `receita`          | ✅     | Shopify, líquida de devoluções.                             |
| loja `encomendas`       | ✅     | Encomendas reais (exclui testes e canceladas).              |
| loja `roas`             | ✅     | Receita líquida ÷ gasto.                                    |
| campanha `nome`         | ✅     |                                                             |
| campanha `plataforma`   | ⚠️     | Sempre `"google"` — não há Meta nem TikTok neste produto.   |
| campanha `estado`       | ✅     | `ativa` / `pausada` / `terminada`.                          |
| campanha `gasto`        | ✅     |                                                             |
| campanha `inicio`       | ✅     | Acrescentado para isto; não existia no painel.              |
| campanha `dias_a_rodar` | ✅     | Do `inicio` até ao dia do relatório, inclusive.             |
| campanha `conversoes`   | ⚠️     | Atribuídas pelo Google; costuma ser 0.                      |
| `comissao_agencia`      | ✅     | Por cliente e por dia: taxa sobre o gasto + revenue share.  |

Uma loja cujo Google Ads falhe traz um campo extra `aviso` com o motivo e
`campanhas: []`. Não inventamos zeros. Lojas de contas internas da agência não
entram no relatório.
