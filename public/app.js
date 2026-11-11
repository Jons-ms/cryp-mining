'use strict';
/* CRYP Mining — клієнт. Усі гроші, курс і майнінг рахує сервер; тут лише показ і запити. */

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* приватний режим */ } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
};

let CFG = null;
let TOKEN = store.get('cryp_token');
let SESSION = null;
let S = null;            // стан гравця з сервера
let syncAt = 0;          // коли отримали S (клієнтський час, лише для плавного показу)
let rate = { rate: 1, prev: 1 };
let tab = 'farm';
let frame = 0;
let hbTimer = null;
let sse = null;
let moveFrom = null;     // режим переміщення карти
let chartRange = '1h';

// ---------- утиліти ----------
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const kop = (v) => `${(v / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₴`;
const cryp = (micro, digits = 6) => {
  const i = Math.floor(micro / 1e6);
  const f = String(Math.floor(micro % 1e6)).padStart(6, '0').slice(0, digits);
  return `${i.toLocaleString('uk-UA')}.${f}`;
};
const fmtRate = (r) => r.toFixed(4);
const fmtTime = (ms) => new Date(ms).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' });
const opId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

let toastTimer = null;
function toast(msg, kind = 'good') {
  $toast.textContent = msg;
  $toast.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = ''; }, 2600);
}
const errText = (code) => t(`errors.${code}`) === `errors.${code}` ? t('errors.server_error') : t(`errors.${code}`);

// ---------- мережа ----------
async function api(path, body, { method = 'POST' } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...(SESSION ? { 'X-Session': SESSION } : {}),
      },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
  } catch (_) {
    throw { code: 'network' };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data.error || 'server_error';
    if (code === 'unauthorized') logout(false);
    if (code === 'session_replaced') showReplaced();
    throw { code };
  }
  return data;
}

function applyState(state) {
  S = state;
  syncAt = Date.now();
  rate.rate = state.rate;
}

/** Дія з обробкою помилок: повертає відповідь або null. */
async function act(path, body) {
  try {
    const out = await api(path, { ...body, opId: opId() });
    applyState(out.state);
    return out;
  } catch (e) {
    toast(errText(e.code), 'bad');
    return null;
  }
}

// ---------- запуск ----------
async function boot() {
  try {
    CFG = await (await fetch('/api/config')).json();
  } catch (_) {
    $app.replaceChildren(el('div', { class: 'auth' }, el('p', { class: 'err' }, t('errors.network'))));
    return;
  }
  if (TOKEN) await enterGame();
  else renderAuth('login');
}

async function enterGame() {
  try {
    const out = await api('/api/session/start', {});
    SESSION = out.sessionId;
    applyState(out.state);
  } catch (_) {
    return renderAuth('login');
  }
  startLoops();
  if (!S.nickname) renderNickname();
  else renderShell();
}

function logout(callApi = true) {
  if (callApi && TOKEN) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }).catch(() => {});
  TOKEN = null; SESSION = null; S = null;
  store.del('cryp_token');
  stopLoops();
  renderAuth('login');
}

function startLoops() {
  stopLoops();
  hbTimer = setInterval(async () => {
    if (document.hidden) return; // у фоновій вкладці майнінг не нараховується, як і задумано правилом 60 с
    try { applyState((await api('/api/heartbeat', {})).state); } catch (_) { /* повторимо */ }
  }, CFG.heartbeatMs);
  animTimer = setInterval(tickUi, 400);
  sse = new EventSource('/api/stream');
  sse.onmessage = (m) => {
    const d = JSON.parse(m.data);
    rate = { rate: d.rate, prev: d.prev };
    updateHud();
    if (tab === 'exchange') updateExchangeLive();
    if (tab === 'podium') refreshPodium();
  };
}
let animTimer = null;
function stopLoops() {
  clearInterval(hbTimer); clearInterval(animTimer);
  if (sse) sse.close();
  hbTimer = animTimer = sse = null;
}

// ---------- показ значень ----------
/** Плавна оцінка CRYP між відповідями сервера (лише візуально; баланс завжди бере сервер). */
function crypNow() {
  if (!S) return 0;
  if (!S.miningActive) return S.cryp;
  const gap = Date.now() - syncAt;
  if (gap > CFG.maxGapMs) return S.cryp;
  return S.cryp + Math.floor((S.power * gap) / 60000); // power — мікро-CRYP за хвилину
}

function tickUi() {
  frame++;
  updateHud();
  if (tab === 'farm') drawFarm();
}

// ---------- авторизація ----------
function renderAuth(mode) {
  const email = el('input', { class: 'field', id: 'email', type: 'email', autocomplete: 'email', placeholder: t('auth.email') });
  const pass = el('input', { class: 'field', id: 'pass', type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', placeholder: t('auth.password') });
  const err = el('div', { class: 'err' });
  const go = el('button', { class: 'btn primary wide', id: 'authgo' }, mode === 'login' ? t('auth.login') : t('auth.register'));
  const submit = async () => {
    err.textContent = '';
    go.disabled = true;
    try {
      const out = await api(`/api/auth/${mode}`, { email: email.value, password: pass.value });
      TOKEN = out.token;
      store.set('cryp_token', TOKEN);
      await enterGame();
    } catch (e) {
      err.textContent = errText(e.code);
      go.disabled = false;
    }
  };
  go.addEventListener('click', submit);
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  $app.replaceChildren(
    el('div', { class: 'auth' },
      el('h1', {}, t('appName')),
      email, pass, err, go,
      el('button', { class: 'btn wide', onclick: () => renderAuth(mode === 'login' ? 'register' : 'login') },
        mode === 'login' ? t('auth.toRegister') : t('auth.toLogin')),
      el('p', { class: 'muted' }, t('auth.hint')),
    ),
  );
}

function renderNickname(changing = false) {
  const input = el('input', { class: 'field', id: 'nick', maxlength: 20, placeholder: t('nick.placeholder'), autocomplete: 'off', autocapitalize: 'off' });
  const err = el('div', { class: 'err' });
  const save = el('button', { class: 'btn primary wide' }, t('nick.save'));
  save.addEventListener('click', async () => {
    err.textContent = '';
    try {
      const out = await api('/api/profile/nickname', { nickname: input.value.trim() });
      applyState(out.state);
      closeOverlay();
      renderShell();
    } catch (e) { err.textContent = errText(e.code); }
  });
  const body = el('div', { class: 'auth' }, el('h1', {}, t('nick.title')), el('p', { class: 'muted' }, t('nick.hint')), input, err, save);
  if (changing) {
    const sheet = el('div', { class: 'sheet' }, body, el('button', { class: 'btn wide', onclick: closeOverlay }, t('common.close')));
    openOverlay(sheet, true);
  } else {
    $app.replaceChildren(body);
  }
  input.focus();
}

// ---------- оболонка ----------
function renderShell() {
  const hud = el('div', { class: 'hud' },
    el('div', { class: 'cell' }, el('span', { class: 'lbl' }, '₴'), el('span', { class: 'val money num', id: 'h-money' })),
    el('div', { class: 'cell' }, el('span', { class: 'lbl' }, 'CRYP'), el('span', { class: 'val cryp num', id: 'h-cryp' })),
    el('div', { class: 'rate-pill num', id: 'h-rate' }),
  );
  const main = el('main', { id: 'main' });
  const nav = el('nav', {}, ...['farm', 'shop', 'exchange', 'podium', 'profile'].map((k) =>
    el('button', { 'data-tab': k, onclick: () => { moveFrom = null; tab = k; renderTab(); } }, t(`tabs.${k}`))));
  $app.replaceChildren(hud, main, nav);
  renderTab();
}

function updateHud() {
  const m = document.getElementById('h-money');
  if (!m || !S) return;
  m.textContent = kop(S.balance);
  document.getElementById('h-cryp').textContent = cryp(crypNow(), 4);
  const r = document.getElementById('h-rate');
  r.textContent = `1 CRYP = ${fmtRate(rate.rate)} ₴`;
  r.className = `rate-pill num ${rate.rate >= rate.prev ? 'up' : 'down'}`;
}

function renderTab() {
  document.querySelectorAll('nav button').forEach((b) => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const main = document.getElementById('main');
  const view = { farm: viewFarm, shop: viewShop, exchange: viewExchange, podium: viewPodium, profile: viewProfile }[tab]();
  main.replaceChildren(...(Array.isArray(view) ? view : [view]));
  updateHud();
  if (tab === 'farm') drawFarm();
  if (tab === 'exchange') loadChart();
}

function rerender() { if (S) renderTab(); }

// ---------- модальні ----------
function openOverlay(content, center = false) {
  closeOverlay();
  const o = el('div', { class: `overlay${center ? ' center' : ''}`, id: 'overlay' }, content);
  o.addEventListener('click', (e) => { if (e.target === o) closeOverlay(); });
  document.body.append(o);
}
function closeOverlay() { document.getElementById('overlay')?.remove(); }

function showReplaced() {
  stopLoops();
  const sheet = el('div', { class: 'sheet' },
    el('h2', {}, t('session.replacedTitle')), el('p', {}, t('session.replacedText')),
    el('button', { class: 'btn primary wide', onclick: () => { closeOverlay(); enterGame(); } }, t('session.resume')));
  openOverlay(sheet, true);
}

// ---------- ферма ----------
const MODEL = (id) => CFG.models.find((m) => m.id === id);
const modelName = (id) => MODEL(id).name;
const perMin = (micro) => String(micro / 1e6);

function viewFarm() {
  const grid = el('div', { class: 'farm-grid', id: 'farm' });
  S.farm.forEach((id, i) => {
    const c = el('canvas', { width: 96, height: 96 });
    const b = el('button', { class: `slot${id ? '' : ' empty'}${moveFrom !== null && moveFrom !== i ? ' target' : ''}${moveFrom === i ? ' selected' : ''}`, 'data-i': i, 'aria-label': `${t('farm.slot')} ${i + 1}`, onclick: () => onSlot(i) }, c, el('span', { class: 'idx' }, i + 1));
    grid.append(b);
  });

  const mining = S.miningActive;
  const toggle = el('button', {
    class: `btn wide ${S.mining ? 'stop' : 'go'}`,
    disabled: !S.mining && S.installed === 0,
    onclick: async () => { await act('/api/mining', { enabled: !S.mining }); rerender(); },
  }, S.mining ? t('farm.stop') : t('farm.start'));

  const inv = Object.entries(S.inventory).filter(([, n]) => n > 0);
  return [
    el('div', { class: 'panel' },
      el('div', { class: 'row between' },
        el('span', { class: `status ${mining ? 'on' : 'off'}` }, mining ? t('farm.running') : t('farm.stopped')),
        el('span', { class: 'num' }, `${t('farm.power')}: ${perMin(S.power)} ${t('farm.perMin')}`)),
      moveFrom !== null ? el('div', { class: 'row between' }, el('span', {}, t('farm.moveHint')), el('button', { class: 'btn', onclick: () => { moveFrom = null; rerender(); } }, t('farm.cancel'))) : null,
      grid,
      toggle,
      S.installed === 0 ? el('div', { class: 'muted' }, t('farm.noCards')) : null),
    el('div', { class: 'panel' }, el('h3', {}, t('farm.inventory')),
      inv.length === 0 ? el('div', { class: 'muted' }, t('farm.inventoryEmpty'))
        : el('div', { class: 'inv' }, inv.map(([id, n]) => el('div', { class: 'inv-item' }, cardIcon(id), el('div', {}, modelName(id)), el('div', { class: 'muted' }, `×${n}`))))),
  ];
}

function drawFarm() {
  document.querySelectorAll('#farm .slot').forEach((b) => {
    const i = Number(b.dataset.i);
    drawSlot(b.firstChild, S.farm[i], frame + i, S.miningActive);
  });
}

async function onSlot(i) {
  if (moveFrom !== null) {
    if (moveFrom === i) { moveFrom = null; return rerender(); }
    const from = moveFrom; moveFrom = null;
    await act('/api/farm/move', { from, to: i });
    return rerender();
  }
  const id = S.farm[i];
  const sheet = el('div', { class: 'sheet' }, el('h2', {}, `${t('farm.slot')} ${i + 1}${id ? ` · ${modelName(id)}` : ''}`));
  const invList = Object.entries(S.inventory).filter(([m, n]) => n > 0 && m !== id);
  const pickBlock = (label, replace) => {
    if (invList.length === 0) return null;
    return el('div', { class: 'panel' }, el('h3', {}, label),
      ...invList.map(([m, n]) => el('button', { class: 'btn', onclick: async () => {
        closeOverlay(); await act('/api/farm/install', { model: m, slot: i, replace }); rerender();
      } }, `${modelName(m)} ×${n}`)));
  };
  if (!id) {
    sheet.append(pickBlock(t('farm.chooseCard'), false) || el('p', { class: 'muted' }, t('farm.inventoryEmpty')));
  } else {
    sheet.append(
      pickBlock(t('farm.upgrade'), true),
      el('button', { class: 'btn', onclick: async () => { closeOverlay(); await act('/api/farm/uninstall', { slot: i }); rerender(); } }, t('farm.uninstall')),
      el('button', { class: 'btn', onclick: () => { closeOverlay(); moveFrom = i; rerender(); } }, t('farm.move')),
      el('button', { class: 'btn stop', onclick: () => confirmSell({ source: 'farm', slot: i }, id) }, `${t('farm.sell')} · ${kop(Math.floor(MODEL(id).priceKop * CFG.sellRatioPercent / 100))}`),
    );
  }
  sheet.append(el('button', { class: 'btn', onclick: closeOverlay }, t('common.close')));
  openOverlay(sheet);
}

function confirmSell(payload, modelId) {
  const gain = Math.floor(MODEL(modelId).priceKop * CFG.sellRatioPercent / 100);
  const sheet = el('div', { class: 'sheet' },
    el('h2', {}, t('shop.confirmSell')),
    el('p', {}, `${modelName(modelId)} → ${kop(gain)}`),
    el('button', { class: 'btn stop', onclick: async () => {
      closeOverlay();
      const out = await act('/api/shop/sell', payload);
      if (out) toast(`+${kop(out.gainedKop)}`);
      rerender();
    } }, t('farm.sell')),
    el('button', { class: 'btn', onclick: closeOverlay }, t('farm.cancel')));
  openOverlay(sheet, true);
}

// ---------- магазин ----------
function viewShop() {
  return [
    el('h2', {}, t('shop.title')),
    ...CFG.models.map((m) => {
      const inInv = S.inventory[m.id];
      const onFarm = S.farm.filter((x) => x === m.id).length;
      return el('div', { class: 'panel item' },
        cardIcon(m.id),
        el('div', {},
          el('div', { class: 'name' }, m.name),
          el('div', { class: 'meta num' }, `${perMin(m.power)} ${t('farm.perMin')}`),
          el('div', { class: 'num' }, `${t('shop.price')}: ${kop(m.priceKop)}`),
          el('div', { class: 'meta' }, `${t('shop.onFarm')}: ${onFarm} · ${t('shop.inInv')}: ${inInv}`)),
        el('div', { class: 'actions' },
          el('button', { class: 'btn primary', disabled: S.balance < m.priceKop, onclick: async () => {
            if (await act('/api/shop/buy', { model: m.id })) toast(`${m.name} ✓`);
            rerender();
          } }, t('shop.buy')),
          el('button', { class: 'btn', disabled: inInv < 1, onclick: () => confirmSell({ source: 'inventory', model: m.id }, m.id) },
            `${t('farm.sell')} ${kop(Math.floor(m.priceKop * CFG.sellRatioPercent / 100))}`)));
    }),
  ];
}

// ---------- біржа ----------
function viewExchange() {
  const input = el('input', { class: 'field num', id: 'sell-amt', inputmode: 'decimal', placeholder: t('ex.amount'), autocomplete: 'off' });
  const preview = el('div', { class: 'muted num', id: 'sell-prev' }, ' ');
  const updatePrev = () => {
    const v = parseFloat(String(input.value).replace(',', '.'));
    preview.textContent = isFinite(v) && v > 0 ? `${t('ex.youGet')} ${kop(Math.round(v * rate.rate * 100))}` : ' ';
  };
  input.addEventListener('input', updatePrev);
  const sell = async (all) => {
    const body = all ? { all: true } : { amount: input.value };
    const out = await act('/api/exchange/sell', body);
    if (out) { toast(`${t('ex.done')}: ${cryp(out.sale.micro)} → ${kop(out.sale.kop)}`); input.value = ''; updatePrev(); }
    rerender();
  };
  return [
    el('div', { class: 'panel' },
      el('div', { class: 'row between' }, el('h2', {}, t('ex.title')),
        el('div', { class: 'seg' }, ['1h', '24h'].map((r) => el('button', { class: 'btn', 'aria-pressed': String(chartRange === r), onclick: () => { chartRange = r; renderTab(); } }, t(`ex.range${r}`))))),
      el('div', { class: 'big-rate num', id: 'big-rate' }, `${fmtRate(rate.rate)} ₴`),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'chart' }))),
    el('div', { class: 'panel' },
      el('h3', {}, t('ex.sellTitle')),
      el('div', { class: 'num' }, `CRYP: ${cryp(S.cryp)}`),
      input, preview,
      el('div', { class: 'row' },
        el('button', { class: 'btn gold', style: 'flex:1', onclick: () => sell(false) }, t('ex.sell')),
        el('button', { class: 'btn', onclick: () => sell(true) }, t('ex.all'))),
      el('div', { class: 'muted' }, t('ex.note'))),
  ];
}

let chartPoints = [];
function updateExchangeLive() {
  const b = document.getElementById('big-rate');
  if (b) b.textContent = `${fmtRate(rate.rate)} ₴`;
  chartPoints.push([Date.now(), rate.rate]);
  drawChart();
}

async function loadChart() {
  try {
    const r = await fetch(`/api/rate/history?range=${chartRange}`);
    chartPoints = (await r.json()).points;
  } catch (_) { chartPoints = []; }
  drawChart();
}

function drawChart() {
  const c = document.getElementById('chart');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const span = chartRange === '24h' ? 24 * 3600e3 : 3600e3;
  const now = Date.now();
  const pts = chartPoints.filter((p) => p[0] >= now - span);
  if (pts.length < 2) return;
  let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  const pad = (hi - lo) * 0.1 || 0.05; lo -= pad; hi += pad;
  const padL = 44, padB = 6, padT = 8;
  const X = (tm) => padL + ((tm - (now - span)) / span) * (w - padL - 6);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  ctx.font = '14px VT323, monospace';
  ctx.fillStyle = '#8a9aab'; ctx.strokeStyle = '#1f2a36'; ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3, y = Y(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillText(v.toFixed(2), 2, y + 4);
  }
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
  ctx.strokeStyle = '#4ad0ff'; ctx.lineWidth = 2; ctx.stroke();
  const last = pts[pts.length - 1];
  ctx.fillStyle = '#ffd04a'; ctx.fillRect(X(last[0]) - 3, Y(last[1]) - 3, 6, 6);
}
window.addEventListener('resize', () => { if (tab === 'exchange') drawChart(); });

// ---------- подіум ----------
function viewPodium() {
  const box = el('div', { class: 'table', id: 'podium-box' }, el('div', { class: 'muted' }, t('common.loading')));
  setTimeout(refreshPodium, 0); // блок ще не в DOM: запускаємо після вставки
  return [el('h2', {}, t('podium.title')), box];
}

let podiumBusy = false;
async function refreshPodium() {
  const box = document.getElementById('podium-box');
  if (!box || podiumBusy) return;
  podiumBusy = true;
  try {
    const d = await api('/api/podium', null, { method: 'GET' });
    const row = (r, me) => el('button', { class: `tr r${r.rank}${me ? ' me' : ''}`, onclick: () => openProfile(r.playerId) },
      el('span', { class: 'rk num' }, `#${r.rank}`),
      el('div', {}, el('div', { class: 'nm' }, r.nickname), el('div', { class: 'sub num' }, kop(r.balanceKop))),
      el('div', { class: 'num' }, kop(r.capitalKop)));
    box.replaceChildren(
      el('div', { class: 'muted' }, t('podium.top')),
      ...(d.top10.length ? d.top10.map((r) => row(r, r.playerId === S.playerId)) : [el('div', { class: 'muted' }, t('podium.empty'))]),
      d.me ? el('div', { class: 'panel' }, el('h3', {}, t('podium.me')), row(d.me, true)) : null,
      el('div', { class: 'muted' }, t('podium.rule')));
  } catch (e) {
    box.textContent = errText(e.code);
  } finally {
    podiumBusy = false;
  }
}

async function openProfile(id) {
  let p;
  try { p = await api(`/api/profile/${id}`, null, { method: 'GET' }); } catch (e) { return toast(errText(e.code), 'bad'); }
  const grid = el('div', { class: 'farm-grid' }, p.farm.map((m) => {
    const c = el('canvas', { width: 96, height: 96 });
    drawSlot(c, m, 0, false);
    return el('div', { class: 'slot' }, c);
  }));
  const line = (k, v) => el('div', { class: 'row between' }, el('span', { class: 'muted' }, k), el('span', { class: 'num' }, v));
  openOverlay(el('div', { class: 'sheet' },
    el('h2', {}, p.nickname),
    line(t('podium.capital'), `${kop(p.capitalKop)}${p.rank ? ` · #${p.rank}` : ''}`),
    line('₴', kop(p.balanceKop)),
    line('CRYP', cryp(p.cryp)),
    line(t('podium.cards'), String(p.installed)),
    line(t('farm.power'), `${perMin(p.power)} ${t('farm.perMin')}`),
    grid,
    el('button', { class: 'btn', onclick: closeOverlay }, t('common.close'))));
}

// ---------- особисті дані ----------
function viewProfile() {
  const next = S.nicknameNextChangeAt;
  const canChange = !next || Date.now() >= next;
  return [
    el('h2', {}, t('profile.title')),
    el('div', { class: 'panel' },
      el('div', { class: 'row between' }, el('span', {}, `${t('profile.nickname')}: ${S.nickname}`),
        el('button', { class: 'btn', disabled: !canChange, onclick: () => renderNickname(true) }, t('profile.change'))),
      !canChange ? el('div', { class: 'muted' }, `${t('profile.changeAt')}: ${fmtTime(next)}`) : null,
      el('div', { class: 'muted num' }, `${t('profile.id')}: ${S.playerId}`),
      el('div', { class: 'muted' }, `${t('profile.email')}: ${S.email}`)),
    el('button', { class: 'btn wide', onclick: () => logout(true) }, t('profile.logout')),
  ];
}

boot();
