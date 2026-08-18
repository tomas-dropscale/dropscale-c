/* trends-radar hub — duas vistas sobre a mesma base de dados.
 *
 * Markets Overview  : um mercado de cada vez, todas as keywords por volume desc.
 * Keywords by Market: um conceito por linha, os mercados onde tem volume; ao clicar,
 *                     compara os 5 anos de todos os mercados no mesmo gráfico.
 *
 * REGRA DOS NÚMEROS (a mesma disciplina do drop-hub/docs/NUMEROS.md):
 *  - O índice do Google Trends é normalizado POR KEYWORD e POR MERCADO. O nível bruto
 *    NÃO é comparável entre keywords nem entre mercados. O que se compara é a FORMA.
 *  - "Volume" é um PROXY de procura sustentada (piso da série + mediana, penalizado por
 *    semanas a zero), não pesquisas absolutas. Está declarado na UI, não presumido.
 *  - Ausência de dado é "—", nunca zero.
 */
const S = { idx: null, page: 'markets', geo: null, q: '', sortM: 'volume', dirM: -1,
            sortK: 'avgVolume', dirK: -1, market: null, concept: null, on: new Set(),
            colq: { markets: '', keywords: '' },     // filtro da coluna Keyword, por vista
            cmp: { id: null, geos: new Set(), q: '', busy: false } };
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
const MAXSERIES = 6;   // seis cores validadas; acima disso as séries deixam de se distinguir
const ST = {
  disparado:   { l: 'Disparado', s: 'tri' },
  a_aquecer:   { l: 'A aquecer', s: 'tri-o' },
  em_janela:   { l: 'Em janela', s: 'circ' },
  verao_ativo: { l: 'Verão', s: 'sun' },
  neutro:      { l: 'Neutro', s: 'dash' },
  sem_dados:   { l: 'Sem dados', s: 'x' },
};

const PERFIL = {
  'sazonal':    { l: 'Sazonal',    c: 'var(--c3)' },
  'bi-sazonal': { l: 'Bi-sazonal', c: 'var(--c4)' },
  'permanente': { l: 'Permanente', c: 'var(--c1)' },
  'erratico':   { l: 'Errático',   c: 'var(--muted)' },
};
const TEND = { cresce: '↗ cresce', cai: '↘ cai', estavel: '→ estável' };
const seta = (d) => d === 'sobe' ? '↑' : d === 'desce' ? '↓' : '→';
function celEpoca(r) {
  if (r.janelaAtual) return `<span class="ep on">${esc(r.janelaAtual.label)}<b>${r.janelaAtual.dur}m</b></span>` +
    ((r.janelas || []).length > 1 ? `<span class="ep-mais" title="tem ${r.janelas.length} janelas">+${r.janelas.length - 1}</span>` : '');
  if (r.proxima) return `<span class="ep">${esc(r.proxima.label)}<b>${r.proxima.dur}m</b></span>` +
    `<span class="ep-falta">faltam ${r.mesesAte}m</span>` +
    ((r.janelas || []).length > 1 ? `<span class="ep-mais" title="tem ${r.janelas.length} janelas">+${r.janelas.length - 1}</span>` : '');
  return '<span style="color:var(--muted)">—</span>';
}
const fmtN = (n) => n == null ? '—' : (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + 'M'
                    : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)));
const fmtCpc = (lo, hi) => (lo == null && hi == null) ? '—'
  : `$${(lo ?? hi).toFixed(2)}–${(hi ?? lo).toFixed(2)}`;
const MES2N = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const mesData = (s) => { const [m, y] = String(s).split(' '); return `${y}-${String(MES2N[m] || 1).padStart(2, '0')}-01`; };
// Topo de eixo "bonito": 201k lê-se mal, 250k lê-se de relance.
const nice = (v) => { if (!v || v <= 0) return 100;
  const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; };
const $ = (s) => document.querySelector(s);
// Dados vindos de scraping: uma keyword com < ou & parte a linha inteira. Escapa-se sempre.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tip = $('#tip');

function icon(shape, n = 9) {
  const h = n / 2, g = { 'tri': `<polygon points="${h},1 ${n - 1},${n - 1} 1,${n - 1}"/>`,
    'tri-o': `<polygon points="${h},1.5 ${n - 1.5},${n - 1.5} 1.5,${n - 1.5}" fill="none" stroke="currentColor" stroke-width="1.6"/>`,
    'circ': `<circle cx="${h}" cy="${h}" r="${h - 1.4}" fill="none" stroke="currentColor" stroke-width="1.6"/>`,
    'sun': `<circle cx="${h}" cy="${h}" r="${h - 2.6}"/>`,
    'dash': `<rect x="1" y="${h - 1}" width="${n - 2}" height="2" rx="1"/>`,
    'x': `<path d="M2 2 L${n - 2} ${n - 2} M${n - 2} 2 L2 ${n - 2}" stroke="currentColor" stroke-width="1.6" fill="none"/>` };
  return `<svg width="${n}" height="${n}" viewBox="0 0 ${n} ${n}" fill="currentColor" aria-hidden="true">${g[shape] || g.dash}</svg>`;
}
const pill = (st) => { const m = ST[st] || ST.neutro; return `<span class="pill p-${st}">${icon(m.s)}${m.l}</span>`; };
const num = (v, d = 0) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
const T = (d) => new Date(d + 'T00:00:00Z').getTime();
const fmtD = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

/* ── gráfico: N séries, 5 anos completos, divisórias de ano, crosshair com todos os valores ── */
function chart(el, series, opts = {}) {
  el.innerHTML = '';
  const live = series.filter((s) => s.points && s.points.length > 1);
  if (!live.length) { el.innerHTML = '<p class="empty">sem série para mostrar</p>'; return; }
  const W = 1200, H = opts.h || 250, ml = opts.ml || 44, mr = opts.mr || 200, mt = 30, mb = 22;
  const iw = W - ml - mr, ih = H - mt - mb;
  let t0 = Infinity, t1 = -Infinity;
  for (const s of live) { t0 = Math.min(t0, T(s.points[0][0])); t1 = Math.max(t1, T(s.points[s.points.length - 1][0])); }
  const yMax = opts.yMax || 100;   // já vem arredondado por nice() quando é escala real
  const X = (t) => ml + iw * (t - t0) / (t1 - t0), Y = (v) => mt + ih * (1 - v / yMax);
  const fmtV = opts.fmt || ((v) => v);
  tip.style.display = 'none';                     // nunca sobreviver a um redesenho
  let sv = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'série')}">`;
  for (const g of [0, yMax / 2, yMax])
    sv += `<line x1="${ml}" y1="${Y(g)}" x2="${W - mr}" y2="${Y(g)}" stroke="var(--border)"/>` +
          `<text x="${ml - 6}" y="${Y(g) + 4}" fill="var(--muted)" font-size="var(--fs-svg)" font-family="var(--mono)" text-anchor="end">${fmtV(g)}</text>`;
  sv += `<text x="0" y="10" fill="var(--muted)" font-size="var(--fs-svg)" font-family="var(--mono)">${esc(opts.yTitle || 'índice Google Trends · 100 = pico da própria série')}</text>`;
  // divisórias de ano: dão a noção temporal sem legenda por baixo
  for (let y = new Date(t0).getUTCFullYear() + 1; y <= new Date(t1).getUTCFullYear(); y++) {
    const t = Date.UTC(y, 0, 1); if (t <= t0 || t >= t1) continue;
    sv += `<line x1="${X(t)}" y1="${mt}" x2="${X(t)}" y2="${mt + ih}" stroke="var(--border)" stroke-dasharray="2,4"/>` +
          `<text x="${X(t) + 4}" y="${H - 7}" fill="var(--muted)" font-size="var(--fs-svg)" font-family="var(--mono)">${y}</text>`;
  }
  live.forEach((s, i) => {
    const c = s.color || COLORS[i % COLORS.length];
    sv += `<path d="${s.points.map((p, j) => `${j ? 'L' : 'M'}${X(T(p[0])).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>`;
  });
  // etiquetas diretas à direita: a identidade nunca depende só da cor
  const fit = (t) => (t.length > 30 ? t.slice(0, 29) + '…' : t);
  const labs = live.map((s, i) => ({ t: fit(s.label), c: s.color || COLORS[i % COLORS.length], y: Y(s.points[s.points.length - 1][1]) + 4 }))
                   .sort((a, b) => a.y - b.y);
  // Duas passagens presas ao plot: só empurrar para baixo fazia as 6 séries que acabam
  // perto de zero sairem do viewBox e serem cortadas.
  const GAP = 13, lo0 = mt + 8, hi0 = mt + ih;
  for (let i = 0; i < labs.length; i++) labs[i].y = Math.max(lo0, Math.min(hi0, labs[i].y));
  for (let i = 1; i < labs.length; i++) if (labs[i].y - labs[i - 1].y < GAP) labs[i].y = labs[i - 1].y + GAP;
  for (let i = labs.length - 1; i > 0; i--) if (labs[i].y > hi0) { labs[i].y = hi0 - (labs.length - 1 - i) * GAP; }
  for (let i = labs.length - 1; i > 0; i--) if (labs[i].y - labs[i - 1].y < GAP) labs[i - 1].y = labs[i].y - GAP;
  for (const l of labs) sv += `<text x="${W - mr + 8}" y="${l.y.toFixed(1)}" fill="${l.c}" font-size="var(--fs-meta)" font-family="var(--mono)">${esc(l.t)}</text>`;
  sv += `<line class="xh" x1="0" y1="${mt}" x2="0" y2="${mt + ih}" stroke="var(--control-border)" stroke-dasharray="3,3" visibility="hidden"/>`;
  sv += `<rect class="hit" x="${ml}" y="${mt}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
  el.innerHTML = sv;
  const svg = el.querySelector('svg'), xh = svg.querySelector('.xh');
  // Eixo temporal = UNIÃO das datas de todas as séries. Usar a série [0] como base dava
  // valores da semana errada quando os mercados têm comprimentos diferentes.
  const dates = [...new Set(live.flatMap((s) => s.points.map((p) => p[0])))].sort();
  const at = live.map((s) => Object.fromEntries(s.points));
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect(), mx = (e.clientX - r.left) * W / r.width;
    if (mx < ml || mx > W - mr) { xh.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; return; }
    const t = t0 + (mx - ml) / iw * (t1 - t0);
    let lo = 0, hi = dates.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; T(dates[m]) < t ? lo = m : hi = m; }
    const date = (t - T(dates[lo])) < (T(dates[hi]) - t) ? dates[lo] : dates[hi];
    xh.setAttribute('x1', X(T(date))); xh.setAttribute('x2', X(T(date))); xh.setAttribute('visibility', 'visible');
    const rows = live.map((s, i) => ({
      l: s.label, c: s.color || COLORS[i % COLORS.length],
      v: at[i][date] !== undefined ? at[i][date] : null,   // ausência é "—", nunca zero
    })).sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
    tip.innerHTML = `<div class="t-d">${fmtD(date)}</div>` + rows.map((r) =>
      `<div class="t-r"><span class="sw" style="background:${r.c}"></span>${esc(r.l)}<b>${r.v == null ? '—' : fmtV(r.v)}</b></div>`).join('');
    tip.style.display = 'block';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(e.clientX + 16, innerWidth - tw - 10) + 'px';
    tip.style.top = Math.max(8, Math.min(e.clientY - th - 14, innerHeight - th - 10)) + 'px';
  });
  svg.addEventListener('mouseleave', () => { xh.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });
}

/* ── lupa de coluna: popover com uma caixa de pesquisa ancorada ao cabeçalho ── */
const LUPA = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>';
function openColFilter(btn, page) {
  const box = $('#colfilter'), inp = $('#colfilter-input');
  const r = btn.getBoundingClientRect();
  box.style.left = Math.min(r.left, innerWidth - 250) + 'px';
  box.style.top = (r.bottom + 6) + 'px';
  box.dataset.page = page;
  box.classList.add('on');
  inp.value = S.colq[page];
  inp.focus(); inp.select();
}
function closeColFilter() { $('#colfilter').classList.remove('on'); }

/* Barras do intervalo de CPC por mercado. O Planner dá UM intervalo por keyword/mercado
   (não uma série), por isso aqui não há eixo temporal — é uma comparação de níveis. */
function barrasCpc(el, linhas) {
  const vivos = linhas.filter((l) => l.cpcHigh != null);   // já vem ordenado por volume
  if (!vivos.length) { el.innerHTML = '<p class="empty">sem CPC para este conceito</p>'; return; }
  const max = Math.max(...vivos.map((l) => l.cpcHigh));
  el.innerHTML = '<div class="bars">' + vivos.map((l) => {
    const lo = ((l.cpcLow ?? 0) / max) * 100, hi = (l.cpcHigh / max) * 100;
    return `<div class="bar"><span class="bl">${esc(l.geo)}</span>` +
      `<span class="bt"><i style="left:${lo}%;width:${Math.max(hi - lo, 1.5)}%;background:${l.color}"></i></span>` +
      `<span class="bv">${fmtCpc(l.cpcLow, l.cpcHigh)}</span>` +
      `<span class="bx">${l.vol ? fmtN(l.vol) + '/mês' : ''}${l.comp ? ' · ' + esc(l.comp) : ''}</span></div>`;
  }).join('') + '</div>';
}

/* ── tabela genérica com ordenação por coluna ── */
function renderTable(tbl, cols, rows, sortKey, dir, onSort, onClick, selId) {
  const page = tbl.id === 'tbl-markets' ? 'markets' : 'keywords';
  tbl.tHead.innerHTML = '<tr>' + cols.map((c) =>
    `<th data-k="${c.k}" class="${c.num ? 'num' : ''}" tabindex="0" role="columnheader" aria-sort="${sortKey === c.k ? (dir < 0 ? 'descending' : 'ascending') : 'none'}" title="${esc(c.title || '')}">${c.t}` +
    (c.find ? `<button type="button" class="lupa${S.colq[page] ? ' on' : ''}" data-page="${page}" ` +
              `aria-label="Filtrar por ${c.t}" title="${S.colq[page] ? 'a filtrar: ' + esc(S.colq[page]) : 'filtrar esta coluna'}">${LUPA}</button>` : '') +
    (sortKey === c.k ? `<span class="arw">${dir < 0 ? '▼' : '▲'}</span>` : '') + '</th>').join('') + '</tr>';
  tbl.tHead.querySelectorAll('.lupa').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); openColFilter(b, b.dataset.page); });
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
  });
  tbl.tHead.querySelectorAll('th').forEach((th) => {
    th.addEventListener('click', () => onSort(th.dataset.k));
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(th.dataset.k); } });
  });
  const body = rows.map((r) => `<tr data-id="${esc(r._id)}" tabindex="0" role="button" aria-label="${esc(r._label || r._id)}"${r._id === selId ? ' class="sel"' : ''}>` +
    cols.map((c) => `<td class="${c.cls || ''}${c.num ? ' num' : ''}">${c.f(r)}</td>`).join('') + '</tr>').join('');
  tbl.tBodies[0].innerHTML = body || '<tr><td colspan="9"><div class="empty">nada corresponde ao filtro</div></td></tr>';
  tbl.tBodies[0].querySelectorAll('tr[data-id]').forEach((tr) => {
    const go = () => onClick(tr.dataset.id, tr);
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

/* ── vista 1: Markets Overview ── */
const cacheM = new Map(), cacheC = new Map();
let reqSeq = 0;   // conceitos/detalhe
let mktSeq = 0;   // mercados — contador próprio, para um não cancelar o outro
async function loadMarket(geo) {
  const seq = ++mktSeq;                       // só a última troca pedida ganha
  $('#fresh').dataset.busy = '1';
  document.querySelector('#page-markets .tblwrap').setAttribute('aria-busy', 'true');
  let m = cacheM.get(geo);                    // 1.4MB por mercado: não se volta a pedir
  if (!m) { m = await getJSON(`/research/data/market/${geo}.json`); cacheM.set(geo, m); }
  if (seq !== mktSeq) return;                 // chegou tarde — outra troca já mandou
  S.market = m;
  S.geo = m.geo;      // só AGORA: o rótulo tem de vir dos dados, nunca do pedido pendente
  delete $('#fresh').dataset.busy;
  document.querySelector('#page-markets .tblwrap').removeAttribute('aria-busy');
  renderMarkets();
}
function renderMarkets() {
  const m = S.market; if (!m) return;
  const q = S.q.toLowerCase(), cq = S.colq.markets.toLowerCase();
  const rows = m.keywords
    .filter((k) => !cq || k.kw.toLowerCase().includes(cq) || (k.en || '').toLowerCase().includes(cq))
    .filter((k) => !q || k.kw.toLowerCase().includes(q) || (k.en || '').toLowerCase().includes(q) || (k.category || '').toLowerCase().includes(q))
    .map((k) => ({ ...k, _id: k.kw, _label: `${k.kw}, volume ${k.volume}, ${k.status}` }))
    .sort((a, b) => {
      const va = a[S.sortM], vb = b[S.sortM];
      if (typeof va === 'string') return S.dirM * va.localeCompare(vb, 'pt');
      return S.dirM * ((va ?? -1) - (vb ?? -1));
    });
  const K = m.keywords;
  const dentro = K.filter((k) => k.janelaAtual);
  const entra2 = K.filter((k) => !k.janelaAtual && k.mesesAte != null && k.mesesAte <= 2);
  const perfil = (p) => K.filter((k) => k.perfil === p).length;
  $('#kpis').innerHTML = [
    [K.length, 'keywords no mercado', ''],
    [dentro.length, 'em época AGORA', 'good'],
    [entra2.length, 'entram em época ≤ 2 meses', 'warn'],
    [perfil('sazonal') + perfil('bi-sazonal'), 'com época a sério', 'sky'],
    [perfil('permanente'), 'procura permanente (sem época)', ''],
    [K.filter((k) => k.tendencia === 'cresce').length, 'a crescer ano após ano', 'good'],
  ].map(([v, l, cls]) => `<div class="kpi ${cls}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
  $('#note-markets').innerHTML = `<strong style="color:var(--muted-bright)">${esc(m.name)}</strong> · idioma <code>${esc(m.lang)}</code> · dados de ${esc(m.generated)}. ` +
    `Cada coluna responde a UMA pergunta, e nunca se fundem: <strong style="color:var(--muted-bright)">Persistência</strong> — há procura fiável o ano todo? · ` +
    `<strong style="color:var(--muted-bright)">Perfil + Época</strong> — tem época a sério, quando e quantos meses dura? · ` +
    `<strong style="color:var(--muted-bright)">Posição</strong> — estamos dentro dela agora, a entrar ou a sair? · ` +
    `<strong style="color:var(--muted-bright)">Tendência</strong> — ao longo dos 5 anos, cresce ou morre? ` +
    `Nenhum destes números é volume de pesquisas: o Trends normaliza cada keyword à sua própria escala.`;
  renderTable($('#tbl-markets'), [
    { k: 'volume', t: 'Persistência', num: true, find: false,
      title: 'procura sustentada relativa ao pico da própria keyword — NÃO compara dimensão de procura entre keywords',
      f: (r) => `<div class="volcell"><span class="volbar"><i style="width:${Math.min(100, r.volume)}%"></i></span><span class="volnum">${num(r.volume)}</span></div>` },
    { k: 'kw', t: 'Keyword', cls: 'kw', find: true, f: (r) => esc(r.kw) + (r.flags.includes('baixo_volume') ? '<span class="flagbv">bv</span>' : '') },
    { k: 'en', t: 'Conceito (EN)', cls: 'en', f: (r) => esc(r.en) || '—' },
    { k: 'perfil', t: 'Perfil', title: 'duas portas: o padrão repete-se (SNR) E a oscilação importa (amplitude ≥40%)',
      f: (r) => { const p = PERFIL[r.perfil] || PERFIL.erratico;
        return `<span class="pill" style="color:${p.c};border-color:${p.c}55">${p.l}</span>` +
               (r.amplitude != null ? `<span class="amp" title="amplitude: quanto a época move a procura">${Math.round(r.amplitude * 100)}%</span>` : ''); } },
    { k: 'mesesAte', t: 'Época', title: 'janela de época (meses contíguos acima do limiar, mínimo 2)', f: celEpoca },
    { k: 'posicao', t: 'Posição', num: true, title: '0-100: onde estamos entre o mês mais fraco e o mais forte desta keyword',
      f: (r) => r.posicao == null ? '—' : `${num(r.posicao)} <span class="dir d-${r.direcao}">${seta(r.direcao)}</span>` },
    { k: 'tendencia', t: 'Tendência', title: 'estrutural, ao longo dos 5 anos, já sem sazonalidade',
      f: (r) => !r.tendencia ? '—' : `<span class="tend t-${r.tendencia}">${TEND[r.tendencia] || r.tendencia}</span>` +
        (r.tendenciaPct != null ? `<span class="amp">${r.tendenciaPct > 0 ? '+' : ''}${r.tendenciaPct}%/ano</span>` : '') },
    { k: 'median52', t: 'Mediana 52s', num: true, f: (r) => num(r.median52) },
  ], rows, S.sortM, S.dirM,
    (k) => { S.dirM = (S.sortM === k) ? -S.dirM : -1; S.sortM = k; renderMarkets(); },
    (id, tr) => openKeyword(id, tr));
}

function openKeyword(kw, tr) {
  const k = S.market.keywords.find((x) => x.kw === kw); if (!k) return;
  document.querySelectorAll('#tbl-markets tbody tr').forEach((t) => t.classList.remove('sel'));
  tr && tr.classList.add('sel');
  $('#detail').classList.add('on');
  $('#d-title').textContent = k.kw;   // textContent: nunca innerHTML com dados
  $('#d-sub').innerHTML = `${k.en || ''} · ${k.category} · ${pill(k.status)} · volume ${num(k.volume)} · ` +
    `mediana 52s ${num(k.median52)} · sazonalidade ${k.season}${k.consec ? ` · rampa há ${k.consec} semana(s)` : ''}`;
  $('#d-legend').innerHTML = `<span class="lg" data-on="1"><span class="sw" style="background:var(--c1)"></span>${S.market.name} — 5 anos</span>`;
  chart($('#d-chart'), [{ label: S.market.geo, points: k.series, color: 'var(--c1)' }], { h: 230, label: k.kw });
  $('#d-rising').innerHTML = (k.rising || []).length
    ? '<span style="font:400 var(--fs-meta)/1 var(--sans);color:var(--muted);align-self:center">em subida:</span>' +
      k.rising.map((r) => `<span class="rq">${esc(r.query)} <b>${esc(r.formattedValue)}</b></span>`).join('')
    : '';
}

/* ── vista 2: Keywords by Market ── */
function renderKeywords() {
  const q = S.q.toLowerCase(), cq = S.colq.keywords.toLowerCase();
  const rows = S.idx.concepts
    .filter((c) => !cq || c.en.toLowerCase().includes(cq))
    .filter((c) => !q || c.en.toLowerCase().includes(q) || (c.category || '').toLowerCase().includes(q))
    .map((c) => ({ ...c, _id: c.id, _label: `${c.en}, volume ${c.volTotal ?? '—'}` }))
    .sort((a, b) => {
      const va = a[S.sortK], vb = b[S.sortK];
      if (typeof va === 'string') return S.dirK * va.localeCompare(vb, 'pt');
      return S.dirK * ((va ?? -1) - (vb ?? -1));
    });
  const tot = S.idx.concepts.length;
  $('#kpis-kw').innerHTML = [
    [tot, 'conceitos no universo', ''],
    [S.idx.totals.markets, 'mercados', ''],
    [S.idx.concepts.filter((c) => c.nActive >= 10).length, 'com volume em 10+ mercados', 'good'],
    [S.idx.concepts.filter((c) => c.hot.length).length, 'a disparar/aquecer nalgum mercado', 'warn'],
  ].map(([v, l, cls]) => `<div class="kpi ${cls}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
  $('#note-keywords').innerHTML = 'Volume e CPC vêm do <strong style="color:var(--muted-bright)">Keyword Planner</strong> — são pesquisas por mês reais e o lance no topo da página, em USD. ' +
    'As etiquetas são os 3 maiores mercados: <strong style="color:var(--muted-bright)">passa o rato</strong> para veres volume, CPC e concorrência. ' +
    '<strong style="color:var(--muted-bright)">Clica na linha</strong> e o gráfico abre com duas tabs: <em>Tendência</em> (5 anos do Trends, para ver a forma e a sazonalidade de cada país) e <em>Volume real</em> (12 meses em pesquisas absolutas, a única escala verdadeiramente comparável entre mercados).';
  renderTable($('#tbl-keywords'), [
    { k: 'en', t: 'Keyword (EN)', cls: 'kw', find: true, f: (r) => esc(r.en) + (r.core ? ' <span class="flagbv">core</span>' : '') },
    { k: 'category', t: 'Categoria', cls: 'cat', f: (r) => esc(r.category) },
    { k: 'volTotal', t: 'Volume total', num: true, title: 'pesquisas/mês somadas nos mercados com dados (Keyword Planner)',
      f: (r) => r.volTotal == null ? '—' : `<b style="color:var(--text)">${fmtN(r.volTotal)}</b>` },
    { k: 'cpcMed', t: 'CPC mediano', num: true, title: 'mediana do lance no topo da página (limite alto), em USD',
      f: (r) => r.cpcMed == null ? '—' : `$${r.cpcMed.toFixed(2)}` },
    { k: 'nActive', t: 'Mercados', num: true, title: 'mercados com procura medida', f: (r) => `${r.nActive}/${r.nMarkets}` },
    { k: 'bestVol', t: 'Top 3 mercados', title: 'os 3 maiores por volume — passa o rato para ver volume e CPC',
      f: (r) => (r.top3 || []).length
        ? r.top3.map((t) => `<span class="tag t3" title="${esc(t.geo)} · ${fmtN(t.vol)} pesquisas/mês · CPC ${fmtCpc(t.cpcLow, t.cpcHigh)}${t.comp ? ' · concorrência ' + esc(t.comp) : ''}">${esc(t.geo)}<b>${fmtN(t.vol)}</b></span>`).join('')
        : '<span style="color:var(--muted)">—</span>' },
  ], rows, S.sortK, S.dirK,
    (k) => { S.dirK = (S.sortK === k) ? -S.dirK : -1; S.sortK = k; renderKeywords(); },
    (id, tr) => openConcept(id, tr));
}

async function openConcept(id, tr) {
  history.replaceState(null, '', '#keywords/' + id);
  const seq = ++reqSeq;
  let c = cacheC.get(id);
  if (!c) { c = await getJSON(`/research/data/concept/${id}.json`); cacheC.set(id, c); }
  if (seq !== reqSeq) return;
  S.concept = c;
  document.querySelectorAll('#tbl-keywords tbody tr').forEach((t) => t.classList.remove('sel'));
  tr && tr.classList.add('sel');
  S.on = new Set(c.markets.filter((m) => m.volume >= 8).slice(0, MAXSERIES).map((m) => m.geo));
  if (!S.on.size) S.on = new Set(c.markets.slice(0, MAXSERIES).map((m) => m.geo));
  $('#detail').classList.add('on');
  $('#d-title').textContent = c.en;
  $('#d-sub').innerHTML = `${esc(c.category)} · ${c.markets.length} mercados com dados · máx ${MAXSERIES} séries visíveis` +
    (c.volTotal ? ` · <strong style="color:var(--muted-bright)">${fmtN(c.volTotal)}</strong> pesquisas/mês no total` : '') +
    (c.cpcMed ? ` · CPC mediano $${c.cpcMed.toFixed(2)}` : '');
  $('#d-rising').innerHTML = '';
  S.tab = S.tab || 'trend';
  drawConcept();
}
const TABS = [
  ['trend', 'Tendência', '5 anos · forma e sazonalidade (índice do Trends, cada série normalizada a si própria)'],
  ['vol', 'Volume', '12 meses · pesquisas por mês reais — a única escala comparável entre mercados'],
  ['cpc', 'CPC', 'intervalo do lance no topo da página, por mercado (USD)'],
  ['ratio', 'Volume por $', 'pesquisas por mês ÷ CPC — procura alcançável por dólar gasto'],
];
function drawConcept() {
  const c = S.concept; if (!c) return;
  const colorOf = {}; [...S.on].forEach((g, i) => colorOf[g] = COLORS[i % COLORS.length]);
  // Uma só ordem em todas as tabs — volume real, com a persistência como desempate
  // para os mercados sem dados do Planner. A posição de um mercado não muda ao trocar de
  // tab: só muda o que a barra/linha mostra.
  c.markets.sort((a, b) => (b.vol ?? -1) - (a.vol ?? -1) || (b.volume ?? -1) - (a.volume ?? -1));
  // A pastilha mostra a métrica da TAB aberta — mostrar persistência enquanto o gráfico
  // fala de volume era o caminho mais curto para uma leitura errada.
  const metrica = (m) => S.tab === 'cpc' ? (m.cpcHigh ? `$${m.cpcHigh.toFixed(2)}` : '—')
    : S.tab === 'trend' ? num(m.volume)
    : (m.vol ? fmtN(m.vol) : '—');
  $('#d-legend').innerHTML = c.markets.map((m) => {
    const on = S.on.has(m.geo);
    return `<button type="button" class="lg" data-geo="${esc(m.geo)}" data-on="${on}" ` +
      `aria-pressed="${on}" title="${esc(m.kw)}${m.vol ? ` · ${fmtN(m.vol)}/mês` : ''}${m.cpcHigh ? ` · CPC ${fmtCpc(m.cpcLow, m.cpcHigh)}` : ''}">` +
      `<span class="sw" style="background:${on ? colorOf[m.geo] : 'var(--idle)'}"></span>${esc(m.geo)}` +
      `<span class="vol">${metrica(m)}</span></button>`;
  }).join('');
  $('#d-legend').querySelectorAll('.lg').forEach((el) => el.addEventListener('click', () => {
    const g = el.dataset.geo;
    if (S.on.has(g)) S.on.delete(g);
    else { if (S.on.size >= MAXSERIES) { el.animate([{ opacity: .3 }, { opacity: 1 }], 260); return; } S.on.add(g); }
    drawConcept();
  }));
  const sel = c.markets.filter((m) => S.on.has(m.geo));
  const rot = (m) => S.tab === 'trend'
    ? `${m.geo} · ${m.kw}${m.vol ? ` · ${fmtN(m.vol)}` : ''}`
    : `${m.geo} · ${fmtN(m.vol)}${m.cpcHigh ? ` · $${m.cpcHigh.toFixed(2)}` : ''}`;
  const el = $('#d-chart');
  el.innerHTML = `<div class="ctabs">${TABS.map(([k, t, d]) =>
    `<button type="button" class="ctab" data-t="${k}" aria-pressed="${S.tab === k}" title="${esc(d)}">${t}</button>`).join('')}` +
    `<span class="ctab-help">${esc((TABS.find((x) => x[0] === S.tab) || TABS[0])[2])}</span></div><div id="d-canvas"></div>`;
  el.querySelectorAll('.ctab').forEach((b) => b.addEventListener('click', () => {
    S.tab = b.dataset.t;
    history.replaceState(null, '', `#keywords/${S.concept.id}/${S.tab}`);
    drawConcept();
  }));
  const cv = $('#d-canvas');

  if (S.tab === 'cpc') {
    barrasCpc(cv, sel.map((m) => ({ geo: m.geo, vol: m.vol, cpcLow: m.cpcLow, cpcHigh: m.cpcHigh,
                                    comp: m.comp, color: colorOf[m.geo] })));
    return;
  }
  if (S.tab === 'trend') {
    chart(cv, sel.map((m) => ({ label: rot(m), points: m.series, color: colorOf[m.geo] })),
      { h: 250, label: c.en, ml: 34 });
    return;
  }
  // Volume e Volume por $: os 12 meses do Planner, em pesquisas ABSOLUTAS
  const ratio = S.tab === 'ratio';
  const series = sel.map((m) => ({
    label: rot(m), color: colorOf[m.geo],
    points: (m.meses || []).filter((x) => x.n != null)
      .map((x) => [mesData(x.m), ratio ? (m.cpcHigh ? x.n / m.cpcHigh : null) : x.n])
      .filter((p) => p[1] != null),
  })).filter((x) => x.points.length > 1);
  if (!series.length) { cv.innerHTML = '<p class="empty">sem dados do Keyword Planner para estes mercados</p>'; return; }
  const max = Math.max(...series.flatMap((x) => x.points.map((p) => p[1])));
  chart(cv, series, { h: 250, label: c.en, yMax: nice(max),
    fmt: (v) => ratio ? Math.round(v).toLocaleString('pt-PT') : fmtN(v),
    yTitle: ratio ? 'pesquisas/mês ÷ CPC — procura por dólar (o CPC é anual, logo a forma é a do volume; o que muda é a ORDEM entre mercados)'
                  : 'pesquisas por mês (Keyword Planner) — absolutas e comparáveis entre mercados' });
}

/* ── vista 3: Market Comparison ──
   A ÚNICA parte da ferramenta que compra dados novos. Existe porque os dados guardados
   são normalizados por keyword e por mercado: só o modo de comparação do Trends põe
   várias séries na MESMA escala, e é essa a única resposta honesta a "qual é maior".
   Custa ~$0.05 por consulta, corre só ao clique, e o resultado fica em cache. */
function renderCompare() {
  const q = S.cmp.q.toLowerCase();
  // Só conceitos comparáveis: o modo de comparação do Trends devolve vazio com termos de
  // várias palavras (medido em 5 runs), portanto não se oferece o que não pode funcionar.
  // Duas condições: o CONCEITO é de uma palavra (senão a lista mente ao prometer
  // "uma só palavra") E há pelo menos 2 mercados cujo termo local também é.
  const list = S.idx.concepts
    .filter((c) => (c.cmp || []).length >= 2)
    .filter((c) => !q || c.en.toLowerCase().includes(q) || (c.category || '').toLowerCase().includes(q))
    .slice(0, 300);
  $('#cmp-concepts').innerHTML = list.map((c) =>
    `<div class="cmp-opt" role="option" data-id="${esc(c.id)}" tabindex="0" aria-selected="${c.id === S.cmp.id}">` +
    `${esc(c.en)}<span class="n">${c.cmp.length} mercados</span></div>`).join('') ||
    '<div class="cmp-opt" style="cursor:default">nada corresponde</div>';
  $('#cmp-concepts').querySelectorAll('.cmp-opt[data-id]').forEach((el) => {
    const pick = async () => {
      S.cmp.id = el.dataset.id; S.cmp.geos = new Set(); S.cmp.kws = null; renderCompare();
      try { S.cmp.kws = (await getJSON(`/research/data/concept/${el.dataset.id}.json`)).markets.map((m) => ({ geo: m.geo, kw: m.kw })); }
      catch { S.cmp.kws = []; }
      renderCompare();
    };
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });

  const c = S.cmp.id ? S.idx.concepts.find((x) => x.id === S.cmp.id) : null;
  const volOf = Object.fromEntries((c ? c.active : []).map((a) => [a.geo, a.volume]));
  const geos = (c ? c.cmp : []).slice().sort((a, b) => (volOf[b] ?? -1) - (volOf[a] ?? -1));
  const fora = c ? Object.keys(S.idx.markets).filter((g) => !c.cmp.includes(g)) : [];
  $('#cmp-geos').innerHTML = !c
    ? '<span style="color:var(--muted);font:400 var(--fs-meta)/24px var(--mono)">escolhe primeiro uma keyword</span>'
    : geos.map((g) => {
        const on = S.cmp.geos.has(g);
        const full = !on && S.cmp.geos.size >= 5;
        return `<button type="button" class="cmp-geo" data-geo="${esc(g)}" aria-pressed="${on}"` +
          `${full ? ' disabled title="máximo 5 mercados — o limite é do próprio Google Trends"' : ''}>` +
          `${esc(g)}<span class="v">${volOf[g] !== undefined ? num(volOf[g]) : '·'}</span></button>`;
      }).join('') +
      (fora.length ? `<div class="cmp-fora">fora: ${fora.join(' ')} — o termo local tem várias palavras e o Google devolve vazio nesses casos</div>` : '');
  $('#cmp-geos').querySelectorAll('.cmp-geo').forEach((b) => b.addEventListener('click', () => {
    const g = b.dataset.geo;
    S.cmp.geos.has(g) ? S.cmp.geos.delete(g) : (S.cmp.geos.size < 5 && S.cmp.geos.add(g));
    renderCompare();
  }));

  const n = S.cmp.geos.size, ok = !!c && n >= 2 && n <= 5 && !S.cmp.busy;
  $('#cmp-go').disabled = !ok;
  $('#cmp-go').textContent = S.cmp.busy ? 'a correr no Google Trends…' : `Correr comparação${n ? ` (${n} mercados)` : ''}`;
  $('#cmp-cost').textContent = !c ? '' : n < 2 ? 'escolhe pelo menos 2 mercados'
    : 'compra dados novos ao Google · ~$0.05 · fica em cache';
  $('#note-compare').innerHTML = 'A comparação usa a <strong style="color:var(--muted-bright)">forma curta</strong> de cada termo local (<em>gabardina</em>, não <em>gabardina mujer</em>): é a única que o modo de comparação do Trends aceita — com várias palavras devolve vazio e cobra à mesma. ' +
    'Sem o modificador de género mede-se procura <strong style="color:var(--muted-bright)">unissexo</strong>, o que aqui é até mais consistente entre países. ' +
    'As outras vistas usam dados guardados, em que <strong style="color:var(--muted-bright)">cada série é normalizada à sua própria escala</strong> — por isso mostram forma e timing, nunca qual é maior. ' +
    'Aqui corre-se uma pesquisa nova no modo de <strong style="color:var(--muted-bright)">comparação</strong> do Google Trends, que devolve até 5 mercados na <strong style="color:var(--muted-bright)">mesma escala</strong>: o resultado é comparável de verdade. ' +
    'É a única parte da ferramenta que gasta dinheiro (~$0.05 por consulta) e cada combinação fica guardada — repetir é grátis.';
}

async function runCompare() {
  const c = S.idx.concepts.find((x) => x.id === S.cmp.id);
  const geos = [...S.cmp.geos];
  const res = $('#cmp-result');
  S.cmp.busy = true; renderCompare();
  res.innerHTML = `<div class="cmp-card"><h3>${esc(c.en)}</h3><div class="cmp-meta">a pedir ${geos.join(', ')} ao Google Trends… demora 1-3 minutos</div></div>`;
  try {
    const conc = await getJSON(`/research/data/concept/${c.id}.json`);
    // forma curta (uma palavra): é a única que o modo de comparação do Trends aceita
    const kws = Object.fromEntries(conc.markets.filter((m) => geos.includes(m.geo)).map((m) => [m.geo, m.cmpKw || m.kw]));
    const r = await fetch('/api/admin/research/compare/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: c.id, geos, kws }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    if (j.cached) return showCompare(c, j.result, true);
    for (;;) {                                  // poll: o run leva 1-3 min
      await new Promise((k) => setTimeout(k, 5000));
      const st = await (await fetch(`/api/admin/research/compare/state?runId=${encodeURIComponent(j.runId)}`)).json();
      if (st.state === 'done') return showCompare(c, st.result, false);
      if (st.state === 'error') throw new Error(st.error || 'o run falhou');
    }
  } catch (e) {
    res.innerHTML = `<div class="cmp-card"><h3>${esc(c.en)}</h3><div class="cmp-meta" style="color:var(--bad)">falhou: ${esc(e.message)}</div></div>`;
  } finally { S.cmp.busy = false; renderCompare(); }
}

function showCompare(c, r, cached) {
  const ord = [...r.series].sort((a, b) => b.mean - a.mean);
  const top = ord[0];
  $('#cmp-result').innerHTML =
    `<div class="cmp-card"><h3>${esc(c.en)} — escala conjunta${cached ? '<span class="cmp-badge">em cache</span>' : ''}</h3>` +
    `<div class="cmp-meta">Estes ${r.series.length} mercados estão na <strong style="color:var(--muted-bright)">mesma escala</strong>: aqui os níveis SÃO comparáveis. ` +
    `Maior procura: <strong style="color:var(--live)">${esc(top.geo)}</strong> (média ${top.mean}) · 5 anos · categoria Apparel` +
    `${r.costUsd ? ` · custou $${r.costUsd.toFixed(3)}` : ''}</div>` +
    `<div class="legend">${ord.map((s, i) => `<span class="lg" data-on="true"><span class="sw" style="background:${COLORS[r.series.indexOf(s) % COLORS.length]}"></span>${esc(s.geo)} · ${esc(s.kw)}<span class="vol">média ${s.mean}</span></span>`).join('')}</div>` +
    `<div id="cmp-chart"></div></div>`;
  chart($('#cmp-chart'), r.series.map((s, i) => ({ label: `${s.geo} · ${s.kw}`, points: s.points, color: COLORS[i % COLORS.length] })),
    { h: 260, label: c.en + ' — comparação entre mercados' });
}

/* ── casca ── */
function setPage(p) {
  S.page = p;
  document.querySelectorAll('.hub-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.page === p)));
  $('#page-markets').hidden = p !== 'markets';
  $('#page-keywords').hidden = p !== 'keywords';
  $('#page-compare').hidden = p !== 'compare';
  $('#market').style.display = p === 'markets' ? '' : 'none';
  $('#search').style.display = p === 'compare' ? 'none' : '';
  reqSeq++; $('#detail').classList.remove('on'); tip.style.display = 'none';
  $('#search').placeholder = p === 'markets' ? 'filtrar keywords…' : 'filtrar conceitos…';
  if (p === 'markets') renderMarkets();
  else if (p === 'keywords') renderKeywords();
  else renderCompare();
  history.replaceState(null, '', '#' + p + (p === 'markets' && S.geo ? '/' + S.geo : ''));
}

const getJSON = async (u) => {   // falhar alto: um 404 silencioso deixava a casca inerte
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u} → ${r.status}`);
  return r.json();
};
(async function init() {
  // Listeners ANTES de qualquer dado: se o índice falhar, a casca continua a responder.
  const closeDetail = () => { reqSeq++; $('#detail').classList.remove('on'); tip.style.display = 'none'; };
  document.querySelectorAll('.hub-tab').forEach((t) => t.addEventListener('click', () => setPage(t.dataset.page)));
  $('#market').addEventListener('change', (e) => loadMarket(e.target.value));
  $('#search').addEventListener('input', (e) => { S.q = e.target.value.trim(); S.page === 'markets' ? renderMarkets() : renderKeywords(); });
  $('#d-close').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
  addEventListener('blur', () => { tip.style.display = 'none'; });
  $('#cmp-search').addEventListener('input', (e) => { S.cmp.q = e.target.value.trim(); renderCompare(); });
  $('#cmp-go').addEventListener('click', runCompare);
  $('#colfilter-input').addEventListener('input', (e) => {
    S.colq[$('#colfilter').dataset.page] = e.target.value.trim();
    S.page === 'markets' ? renderMarkets() : renderKeywords();
    $('#colfilter-input').focus();                       // o re-render não pode roubar o cursor
  });
  $('#colfilter-clear').addEventListener('click', () => {
    S.colq[$('#colfilter').dataset.page] = '';
    $('#colfilter-input').value = '';
    S.page === 'markets' ? renderMarkets() : renderKeywords();
    closeColFilter();
  });
  $('#colfilter-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); closeColFilter(); }
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#colfilter') && !e.target.closest('.lupa')) closeColFilter();
  });

  const hash = (location.hash || '').slice(1).split('/');
  try {
    S.idx = await getJSON('/research/data/index.json');
  } catch (e) {
    $('#fresh').textContent = 'erro a carregar dados: ' + e.message;
    console.error(e); return;                       // falhar alto, com a casca viva
  }
  const geos = Object.keys(S.idx.markets).sort((a, b) => S.idx.markets[b].n - S.idx.markets[a].n);
  $('#market').innerHTML = geos.map((g) => `<option value="${esc(g)}">${esc(g)} · ${esc(S.idx.markets[g].name)}</option>`).join('');
  $('#fresh').textContent = `${S.idx.totals.keywords.toLocaleString('pt-PT')} keywords · ${S.idx.totals.markets} mercados · ${S.idx.generated}`;
  const geo0 = (hash[0] === 'markets' && hash[1] && geos.includes(hash[1])) ? hash[1] : (geos.includes('GB') ? 'GB' : geos[0]);
  $('#market').value = geo0;
  renderKeywords();
  setPage(['keywords', 'compare'].includes(hash[0]) ? hash[0] : 'markets');

  // Deep-link de conceito primeiro (não espera pelos 1.4MB do mercado); o mercado
  // carrega a seguir e não pode invalidar o conceito — daí o loadMarket ficar no fim.
  loadMarket(geo0);   // arranca ANTES do await: assim não pode ultrapassar uma escolha
  if (hash[0] === 'keywords' && hash[1]) {              // de mercado feita entretanto
    if (hash[2]) S.tab = hash[2];    // #keywords/<id>/<tab> abre logo na vista pedida
    await openConcept(hash[1], document.querySelector(`#tbl-keywords tbody tr[data-id="${CSS.escape(hash[1])}"]`));
  }
})();
