import { MONTHS, seasonOf, rank, whereAmI, longWeekends, fmtRange, seasonStatus, roadEstimate, travelText, festivalMonth, haversineKm } from './engine.js';
import { CATEGORY_THEME, themeOf, cardBackground } from './themes.js';
import { CITIES, nearestCity } from './cities.js';
import { locate, inIndia } from './geo.js';
import { store } from './store.js';
import { initMap, updateMap, nudgeMap } from './map.js';

// ————— state —————
let DESTS = [];
let HOLIDAYS = [];
const now = new Date();
const S = {
  origin: store.origin,            // {name, lat, lng}
  month: now.getMonth() + 1,       // 1-12, defaults to "now"
  dist: store.dist,                // nearby | weekend | long | anywhere
  moods: new Set(store.moods),
  idx: 0,                          // position in ranked deck
  ranked: [],
  pinned: null,                    // destination tapped on the map / saved list
  seed: now.getDate() + (now.getMonth() + 1) * 31,
};
const DIST_KM = { nearby: 150, weekend: 450, long: 900, anywhere: Infinity };
const DIST_LABEL = [
  ['nearby', 'Quick hop', '≤150 km'],
  ['weekend', 'Weekend', '≤450 km'],
  ['long', 'Long weekend', '≤900 km'],
  ['anywhere', 'Anywhere', ''],
];

const $ = id => document.getElementById(id);

// ————— boot —————
init();
async function init() {
  buildMonthSel();
  buildDistChips();
  buildHeroStrip();
  wireEvents();

  try {
    const [d, h] = await Promise.all([
      fetch('data/destinations.json').then(r => { if (!r.ok) throw 0; return r.json(); }),
      fetch('data/holidays.json').then(r => r.json()).catch(() => []),
    ]);
    if (!Array.isArray(d) || !d.length) throw 0;
    DESTS = d;
    HOLIDAYS = h;
  } catch {
    // persistent error state — distinct from "no results for these filters"
    $('btnLocate').disabled = true;
    $('btnManual').disabled = true;
    $('heroNote').innerHTML =
      '⚠️ Couldn’t load the destination catalogue — check your connection. ' +
      '<button id="btnRetry" class="btn btn-ghost">Try again</button>';
    $('btnRetry').onclick = () => location.reload();
    $('screen-map').hidden = true;
    $('screen-home').hidden = false;
    return;
  }

  buildMoodChips();  // needs DESTS: chips reflect categories actually in the data

  if (S.origin) enterMap();
}

// ————— UI scaffolding —————
function buildMonthSel() {
  const sel = $('monthSel');
  for (let i = 0; i < 12; i++) {
    const m = ((now.getMonth() + i) % 12) + 1;
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = i === 0 ? `Now · ${MONTHS[m - 1]}` : MONTHS[m - 1];
    sel.appendChild(opt);
  }
  sel.value = S.month;
  sel.onchange = () => { S.month = +sel.value; S.idx = 0; S.pinned = null; render(true); };
}

function buildDistChips() {
  const row = $('distChips');
  for (const [key, label, sub] of DIST_LABEL) {
    const b = document.createElement('button');
    b.className = 'chip' + (S.dist === key ? ' is-on' : '');
    b.dataset.k = key;
    b.setAttribute('role', 'radio');
    b.innerHTML = sub ? `${label} <small>${sub}</small>` : label;
    b.onclick = () => {
      S.dist = key; store.dist = key; S.idx = 0; S.pinned = null;
      row.querySelectorAll('.chip').forEach(c => c.classList.toggle('is-on', c.dataset.k === key));
      render(true);
    };
    row.appendChild(b);
  }
}

function buildMoodChips() {
  const row = $('moodChips');
  const used = new Set(DESTS.flatMap(d => d.category || []));
  for (const c of used) if (!CATEGORY_THEME[c]) console.warn(`destination category "${c}" has no theme/chip — check data/destinations.json`);
  const all = document.createElement('button');
  all.className = 'chip' + (S.moods.size === 0 ? ' is-on' : '');
  all.dataset.k = '';
  all.textContent = '✨ Any mood';
  all.onclick = () => { S.moods.clear(); syncMoods(); };
  row.appendChild(all);
  for (const [key, t] of Object.entries(CATEGORY_THEME).filter(([k]) => used.has(k))) {
    const b = document.createElement('button');
    b.className = 'chip' + (S.moods.has(key) ? ' is-on' : '');
    b.dataset.k = key;
    b.textContent = `${t.e} ${t.label}`;
    b.onclick = () => {
      S.moods.has(key) ? S.moods.delete(key) : S.moods.add(key);
      syncMoods();
    };
    row.appendChild(b);
  }
  function syncMoods() {
    store.moods = [...S.moods];
    S.idx = 0; S.pinned = null;
    row.querySelectorAll('.chip').forEach(c =>
      c.classList.toggle('is-on', c.dataset.k === '' ? S.moods.size === 0 : S.moods.has(c.dataset.k)));
    render(true);
  }
}

function buildHeroStrip() {
  $('heroStrip').innerHTML = [
    '🗺️ every place is a live season dot on one map',
    '🧭 your route is drawn before you decide',
    '🌧️ knows when monsoon closes mountain roads',
    '🗓️ spots your next long weekend',
    '🎒 ranks places by how solo-friendly they are',
  ].map(s => `<span>${s}</span>`).join('');
}

function wireEvents() {
  wireDlgFallback($('originDlg'));
  wireDlgFallback($('savedDlg'));
  $('btnLocate').onclick = doLocate;
  $('dlgLocate').onclick = () => { closeDlg($('originDlg')); doLocate(); };
  $('btnManual').onclick = openOriginDlg;
  $('originBtn').onclick = openOriginDlg;
  $('themeBtn').onclick = toggleTheme;
  $('savedBtn').onclick = openSavedDlg;
  $('originSearch').oninput = e => renderOriginResults(e.target.value);
  $('sheetHandle').onclick = () => toggleSheet();
  wireSheetDrag();
  document.querySelector('.brand').onclick = e => {
    e.preventDefault();
    $('screen-map').hidden = true;
    $('screen-home').hidden = false;
  };
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' && !$('screen-map').hidden && !dialogOpen()) nextPick();
  });
}

// <dialog> fallback for browsers without showModal (older iOS Safari, WebViews):
// toggle the open attribute manually and stop method="dialog" form submits
// from navigating.
function openDlg(dlg) {
  if (typeof dlg.showModal === 'function') { dlg.showModal(); return; }
  dlg.setAttribute('open', '');
}
function closeDlg(dlg) {
  if (typeof dlg.close === 'function') { dlg.close(); return; }
  dlg.removeAttribute('open');
}
function wireDlgFallback(dlg) {
  dlg.querySelector('form').addEventListener('submit', e => {
    if (typeof dlg.close !== 'function') { e.preventDefault(); closeDlg(dlg); }
  });
}
function dialogOpen() {
  return $('originDlg').hasAttribute('open') || $('savedDlg').hasAttribute('open');
}

// ————— screens —————
async function enterMap() {
  $('screen-home').hidden = true;
  $('screen-map').hidden = false;
  try {
    await initMap($('mapEl'), d => { S.pinned = d; S.idx = 0; render(true); });
  } catch {
    toast('Map failed to load — check your connection and refresh.');
    return;
  }
  nudgeMap();
  render(true);
}

// ————— origin —————
async function doLocate() {
  const btn = $('btnLocate');
  const old = btn.textContent;
  btn.textContent = '📡 Finding you…';
  btn.disabled = true;
  try {
    const pos = await locate();
    if (!inIndia(pos)) {
      toast("You seem to be outside India — type where you'll start instead.");
      openOriginDlg();
      return;
    }
    const here = whereAmI(DESTS, pos) || nearestCity(pos.lat, pos.lng);
    const label = here.near ? `near ${here.name}` : here.name;
    setOrigin({ name: label, lat: pos.lat, lng: pos.lng });
  } catch {
    toast("Couldn't get your location — type where you are instead.");
    openOriginDlg();
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

function setOrigin(o) {
  S.origin = o;
  store.origin = o;
  S.idx = 0; S.pinned = null;
  enterMap();
}

function openOriginDlg() {
  $('originSearch').value = '';
  renderOriginResults('');
  openDlg($('originDlg'));
  setTimeout(() => $('originSearch').focus(), 60);
}

function renderOriginResults(q) {
  const box = $('originResults');
  q = q.trim().toLowerCase();
  const pool = [
    ...CITIES.map(([name, lat, lng]) => ({ name, lat, lng, type: 'city' })),
    ...DESTS.map(d => ({ name: d.name, lat: d.lat, lng: d.lng, type: d.state })),
  ];
  let hits;
  if (!q) {
    hits = pool.slice(0, 10);
  } else {
    const starts = pool.filter(p => p.name.toLowerCase().startsWith(q));
    const incl = pool.filter(p => !p.name.toLowerCase().startsWith(q) && p.name.toLowerCase().includes(q));
    hits = [...starts, ...incl].slice(0, 12);
  }
  box.innerHTML = '';
  for (const h of hits) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'origin-item';
    b.innerHTML = `<span>${h.type === 'city' ? '🏙️' : '📍'}</span> ${h.name} <span class="oi-type">${h.type === 'city' ? 'city' : h.type}</span>`;
    b.onclick = () => { closeDlg($('originDlg')); setOrigin({ name: h.name, lat: h.lat, lng: h.lng }); };
    box.appendChild(b);
  }
  if (!hits.length) box.innerHTML = '<p class="saved-empty">No match — try a bigger city nearby.</p>';
}

// ————— the answer —————
function currentItem() {
  if (S.pinned) {
    const d = S.pinned;
    const km = haversineKm(S.origin.lat, S.origin.lng, d.lat, d.lng);
    const { roadKm, hours } = roadEstimate(km, d.alt);
    return { d, km: Math.round(km), roadKm, hours, status: seasonStatus(d, S.month), score: 0 };
  }
  return S.ranked.length ? S.ranked[S.idx % S.ranked.length] : null;
}

// Where would you go next FROM the pick — the dashed onward arcs.
function onwardHops(d) {
  return rank(DESTS, { lat: d.lat, lng: d.lng }, S.month, {
    maxKm: 500,
    excludeIds: new Set([...store.been, d.id]),
    seed: S.seed,
  }).filter(it => haversineKm(S.origin.lat, S.origin.lng, it.d.lat, it.d.lng) > 25)
    .slice(0, 2);
}

function render(fit = false) {
  if (!S.origin) return;
  $('originLabel').textContent = `From ${S.origin.name} · ${MONTHS[S.month - 1]}`;

  S.ranked = rank(DESTS, S.origin, S.month, {
    maxKm: DIST_KM[S.dist],
    moods: [...S.moods],
    excludeIds: new Set(store.been),
    seed: S.seed,
  });

  const item = currentItem();
  renderSheet(item);
  updateMap({
    dests: DESTS,
    month: S.month,
    origin: S.origin,
    selected: item,
    onward: item ? onwardHops(item.d) : [],
    fit,
  });
}

function renderSheet(item) {
  const body = $('sheetBody');
  const sheet = $('sheet');

  if (!item) {
    sheet.classList.remove('is-expanded');
    body.innerHTML = `
      <div class="sheet-empty">
        <b>🌵 Nothing honest to suggest in this range.</b>
        Every place within reach is off-limits in ${MONTHS[S.month - 1]} or filtered out.
        Widen the distance, drop a mood, or tap any dot on the map to inspect it.
      </div>`;
    return;
  }

  const { d, roadKm, hours, status } = item;
  const t = themeOf(d);
  const season = seasonOf(S.month);
  const why = (d.why && d.why[season]) || d.tagline;
  const pos = S.pinned ? null : S.idx % S.ranked.length;

  const statusBadge = {
    peak: '<span class="badge badge-season-peak">● In season now</span>',
    shoulder: '<span class="badge badge-season-shoulder">◐ Shoulder — fewer crowds</span>',
    off: '<span class="badge badge-season-off">○ Off-season</span>',
    avoid: '<span class="badge badge-season-avoid">✕ Not the time</span>',
  }[status];

  const fm = festivalMonth(d);
  const festBadge = fm && (fm === S.month || fm === (S.month % 12) + 1)
    ? `<span class="badge badge-festival">🎪 ${d.festival}</span>` : '';

  const lwRun = matchingLongWeekend(d);
  const lwBadge = lwRun ? `<span class="badge badge-lw">🗓️ Fits ${fmtRange(lwRun.start, lwRun.end)}</span>` : '';

  const onward = onwardHops(d);
  const rupee = '₹'.repeat(d.budget || 2);

  body.innerHTML = `
    <div class="sheet-card" style="background:${cardBackground(d)}">
      <div class="sheet-kicker">${S.pinned
        ? 'from the map'
        : `<span class="rank-pill">#${pos + 1}</span> your next stop`}</div>
      <div class="sheet-headline">
        <span class="sheet-emoji">${t.e}</span>
        <div>
          <h2 class="card-name">${d.name}</h2>
          <div class="card-state">${d.state} · ${d.tagline}</div>
        </div>
      </div>
      <div class="card-dist">📍 ${travelText(roadKm, hours)}</div>
      <div class="why-now"><b>Why now —</b> ${why}</div>
      <div class="badge-row">${statusBadge}${festBadge}${lwBadge}</div>

      <div class="sheet-more">
        <div class="card-meta">
          <span>🗓️ <b>${d.days}${d.days === 1 ? ' day' : '+ days'}</b></span>
          <span>💰 <b>${rupee}</b></span>
          <span>🎒 solo <b>${d.solo}/5</b></span>
          ${d.crowd ? `<span>👥 <b>${['quiet', 'moderate', 'packed'][d.crowd - 1] || 'moderate'}</b> in peak</span>` : ''}
          ${d.alt > 500 ? `<span>⛰️ <b>${d.alt.toLocaleString('en-IN')} m</b></span>` : ''}
        </div>
        <div class="card-meta"><span>🧳 ${d.vibe}</span></div>
        <div class="card-meta"><span>🚌 ${d.hub}</span></div>
        ${onward.length ? `<div class="card-meta onward-meta"><span>↪️ from here, next: ${onward.map(o => `<b>${o.d.name}</b> (${o.roadKm} km)`).join(' or ')}</span></div>` : ''}
      </div>
    </div>

    <div class="sheet-actions">
      <button class="btn btn-primary sheet-next" id="btnAnother">${S.pinned ? 'Back to my picks →' : 'Show me another →'}</button>
      <div class="sheet-acts">
        <a class="card-act" target="_blank" rel="noopener"
           href="https://www.google.com/maps/dir/?api=1&origin=${S.origin.lat},${S.origin.lng}&destination=${encodeURIComponent(d.name + ', ' + d.state)}">
          <span class="ico">🧭</span>Directions</a>
        <button class="card-act" id="actShare"><span class="ico">📤</span>Share</button>
        <button class="card-act ${store.isSaved(d.id) ? 'is-done' : ''}" id="actSave">
          <span class="ico">${store.isSaved(d.id) ? '♥' : '♡'}</span>Save</button>
        <button class="card-act" id="actBeen"><span class="ico">✓</span>Been there</button>
      </div>
    </div>

    <div class="sheet-alts">
      <div class="alt-head"><h3>Also in reach</h3><span class="alt-count">${S.ranked.length} place${S.ranked.length === 1 ? '' : 's'} in range</span></div>
      <div class="alt-grid" id="altGrid"></div>
    </div>`;

  $('btnAnother').onclick = nextPick;
  $('actShare').onclick = () => shareDest(d, item);
  $('actSave').onclick = () => {
    const on = store.toggleSaved(d.id);
    toast(on ? `Saved ${d.name} for later` : `Removed ${d.name} from saved`);
    renderSheet(item);
  };
  $('actBeen').onclick = () => {
    store.toggleBeen(d.id);
    toast(`Nice ✓ — ${d.name} won't be suggested again`);
    S.pinned = null;
    render(true);
  };

  // alternates inside the expanded sheet
  const grid = $('altGrid');
  const start = S.pinned ? 0 : (S.idx % Math.max(S.ranked.length, 1)) + 1;
  for (let j = start; j < S.ranked.length && grid.children.length < 6; j++) {
    const it = S.ranked[j];
    const tt = themeOf(it.d);
    const b = document.createElement('button');
    b.className = 'alt-card';
    b.innerHTML = `
      <div class="card-bg" style="background:${cardBackground(it.d)}"></div>
      <span class="alt-status" style="background:${{ peak: 'var(--peak)', shoulder: 'var(--shoulder)', off: 'var(--off)' }[it.status] || 'var(--off)'}"></span>
      <span class="alt-emoji">${tt.e}</span>
      <span class="alt-name">${it.d.name}</span>
      <span class="alt-sub">${it.roadKm} km · ${it.d.state}</span>`;
    b.onclick = () => { S.pinned = null; S.idx = j; toggleSheet(false); render(true); };
    grid.appendChild(b);
  }
  if (!grid.children.length) grid.innerHTML = '<p class="saved-empty">Nothing else in this range — widen it or change the month.</p>';
}

function nextPick() {
  if (S.pinned) { S.pinned = null; render(true); return; }
  if (!S.ranked.length) return;
  S.idx++;
  if (S.idx % S.ranked.length === 0) toast('That was everything in range — back to the top pick');
  render(true);
}

// ————— bottom sheet expand/collapse —————
function toggleSheet(force) {
  const sheet = $('sheet');
  const on = force !== undefined ? force : !sheet.classList.contains('is-expanded');
  sheet.classList.toggle('is-expanded', on);
  $('sheetHandle').setAttribute('aria-label', on ? 'Collapse details' : 'Expand details');
}

function wireSheetDrag() {
  const sheet = $('sheet');
  let startY = null, startExpanded = false;
  const onDown = e => {
    // only drag from the handle / card header area, never from buttons or the scrolling alt grid
    if (e.target.closest('.sheet-acts, .alt-grid, a, .btn')) return;
    startY = (e.touches ? e.touches[0] : e).clientY;
    startExpanded = sheet.classList.contains('is-expanded');
  };
  const onMove = e => {
    if (startY === null) return;
    const y = (e.touches ? e.touches[0] : e).clientY;
    const dy = y - startY;
    if (Math.abs(dy) > 46) {
      toggleSheet(dy < 0);
      startY = null;
    }
  };
  const onUp = () => { startY = null; };
  sheet.addEventListener('touchstart', onDown, { passive: true });
  sheet.addEventListener('touchmove', onMove, { passive: true });
  sheet.addEventListener('touchend', onUp);
  sheet.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ————— long weekends —————
let lwRuns = null;
function getLongWeekends() {
  if (!lwRuns) lwRuns = longWeekends(HOLIDAYS, now);
  return lwRuns;
}
function matchingLongWeekend(d) {
  const runs = getLongWeekends().filter(r => r.days >= (d.days || 2));
  // browsing "now": the next upcoming run is relevant; browsing a future month:
  // only tag runs that actually fall in that month
  if (S.month === now.getMonth() + 1) return runs[0] || null;
  return runs.find(r => r.start.getMonth() + 1 === S.month || r.end.getMonth() + 1 === S.month) || null;
}

// ————— share —————
async function shareDest(d, item) {
  const seasonLine = { peak: 'peak season right now', shoulder: 'shoulder season — fewer crowds', off: 'off-season', avoid: 'not the season' }[item.status];
  const text = `My next stop: ${d.name}, ${d.state} 🧭 ${item.roadKm} km away — ${seasonLine}. Find yours at mynextstop.online`;
  try {
    if (navigator.share) { await navigator.share({ title: 'my next stop', text, url: 'https://mynextstop.online' }); return; }
    throw 0;
  } catch {
    try { await navigator.clipboard.writeText(text); toast('Copied — paste it anywhere'); }
    catch { toast(text); }
  }
}

// ————— saved dialog —————
function openSavedDlg() {
  renderSaved();
  openDlg($('savedDlg'));
}
function renderSaved() {
  fillList($('savedList'), store.saved, 'Nothing saved yet — tap ♡ Save on any pick.', id => {
    store.toggleSaved(id); renderSaved();
  });
  fillList($('beenList'), store.been, 'Nothing here yet — tap ✓ Been there on a pick and it stops being suggested.', id => {
    store.toggleBeen(id); renderSaved(); if (S.origin) render();
  });
}
function fillList(el, ids, emptyMsg, onRemove) {
  el.innerHTML = '';
  if (!ids.length) { el.innerHTML = `<p class="saved-empty">${emptyMsg}</p>`; return; }
  for (const id of ids) {
    const d = DESTS.find(x => x.id === id);
    if (!d) continue;
    const t = themeOf(d);
    const row = document.createElement('div');
    row.className = 'saved-item';
    row.innerHTML = `
      <span class="s-emoji">${t.e}</span>
      <button type="button" class="s-main">
        <div class="s-name">${d.name} · ${d.state}</div>
        <div class="s-sub">${d.tagline}</div>
      </button>
      <button type="button" class="s-remove" aria-label="Remove">✕</button>`;
    row.querySelector('.s-main').onclick = () => {
      closeDlg($('savedDlg'));
      if (!S.origin) { openOriginDlg(); return; }
      S.pinned = d;
      render(true);
    };
    row.querySelector('.s-remove').onclick = () => onRemove(id);
    el.appendChild(row);
  }
}

// ————— theme / toast —————
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  document.documentElement.style.colorScheme = next;
  store.theme = next;
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-show'), 2600);
}
