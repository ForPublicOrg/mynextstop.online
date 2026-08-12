import { MONTHS, seasonOf, rank, whereAmI, longWeekends, fmtRange, seasonStatus, roadEstimate, travelText, festivalMonth, haversineKm } from './engine.js';
import { CATEGORY_THEME, themeOf, cardBackground, catIcon, catBadge } from './themes.js';
import { icon } from './icons.js';
import { CITIES, nearestCity } from './cities.js';
import { locate, inIndia } from './geo.js';
import { store } from './store.js';
import { initMap, updateMap, nudgeMap, setMapTheme } from './map.js';

// ————— state —————
let DESTS = [];
let HOLIDAYS = [];
// IST "today", regardless of device timezone — the whole product (season
// windows, holidays.json dates) is defined in Indian time.
const now = (() => { const d = new Date(); return new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000); })();
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

  // CTAs stay disabled until the catalogue is in memory — a cached GPS fix
  // can resolve faster than the fetch and would rank an empty list
  $('btnLocate').disabled = false;
  $('btnManual').disabled = false;

  // keep the origin dialog's input above the iOS keyboard: the keyboard
  // shrinks only the visual viewport, not the layout viewport fixed
  // elements use, so nudge the dialog up by the difference
  const vv = window.visualViewport;
  if (vv) {
    const dlg = $('originDlg');
    const adjust = () => {
      if (!dlg.hasAttribute('open')) return;
      dlg.style.bottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + 'px';
    };
    vv.addEventListener('resize', adjust);
    vv.addEventListener('scroll', adjust);
    dlg.addEventListener('close', () => { dlg.style.bottom = ''; });
  }

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
  all.textContent = 'All';
  all.onclick = () => { S.moods.clear(); syncMoods(); };
  row.appendChild(all);
  for (const [key, t] of Object.entries(CATEGORY_THEME).filter(([k]) => used.has(k))) {
    const b = document.createElement('button');
    b.className = 'chip' + (S.moods.has(key) ? ' is-on' : '');
    b.dataset.k = key;
    b.innerHTML = `${icon(key)}${t.label}`;
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
    'every place is a live season dot on one map',
    'your route is drawn before you decide',
    'knows when monsoon closes mountain roads',
    'spots your next long weekend',
    'ranks places by how solo-friendly they are',
  ].map(s => `<span>${s}</span>`).join('');
}

function wireEvents() {
  wireDlgFallback($('originDlg'));
  wireDlgFallback($('savedDlg'));
  wireDlgFallback($('filterDlg'));
  $('filterBtn').onclick = () => openDlg($('filterDlg'));
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
    await initMap($('mapEl'), d => { S.pinned = d; S.idx = 0; render(true); }, effectiveTheme());
  } catch {
    // don't strand the user on a blank map screen — back to home, retryable
    $('screen-map').hidden = true;
    $('screen-home').hidden = false;
    toast('Map failed to load — check your connection and tap Find again.');
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
    b.innerHTML = `${icon(h.type === 'city' ? 'city' : 'pin')} ${h.name} <span class="oi-type">${h.type === 'city' ? 'city' : h.type}</span>`;
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

// Practical arrival modes → icon row. d.modes ⊆ ["flight","train","road"].
const MODE_META = { flight: ['plane', 'flight'], train: ['train', 'train'], road: ['car', 'road'] };
function modesHtml(d, withLabels = false) {
  if (!Array.isArray(d.modes) || !d.modes.length) return '';
  return d.modes.filter(m => MODE_META[m]).map(m => {
    const [ic, label] = MODE_META[m];
    return withLabels ? `<span class="mode">${icon(ic)}${label}</span>` : icon(ic);
  }).join('');
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

function syncFilterBadge() {
  const n = S.moods.size + (S.dist !== 'weekend' ? 1 : 0);
  const el = $('filterCount');
  el.hidden = n === 0;
  el.textContent = n;
}

function render(fit = false) {
  if (!S.origin) return;
  $('originLabel').textContent = `From ${S.origin.name}`;
  syncFilterBadge();

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
        <b>Nothing honest to suggest in this range.</b>
        Everything within reach is off-limits in ${MONTHS[S.month - 1]} or filtered out —
        open <b>Filters</b> to widen the range, or tap any dot to inspect it.
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
  const statusDot = { peak: 'var(--peak)', shoulder: 'var(--shoulder)', off: 'var(--off)', avoid: 'var(--avoid)' }[status];
  const statusWord = { peak: 'in season', shoulder: 'shoulder', off: 'off-season', avoid: 'avoid now' }[status];

  body.innerHTML = `
    <div class="sheet-peek" id="sheetPeek" role="button" aria-label="Expand details">
      <div class="peek-row1">
        ${catBadge(d)}
        <span class="peek-name">${d.name}</span>
        <i class="peek-dot" style="background:${statusDot}" title="${statusWord}"></i>
        <button class="btn btn-primary peek-next" id="btnAnotherPeek">${S.pinned ? 'My picks' : `Next ${icon('arrowRight')}`}</button>
      </div>
      <div class="peek-row2">${S.pinned ? '' : `<b>#${pos + 1}</b> · `}${travelText(roadKm, hours)} · <span class="peek-season">${statusWord}</span>${modesHtml(d) ? `<span class="peek-modes">${modesHtml(d)}</span>` : ''}</div>
      <div class="peek-why">${why}</div>
    </div>

    <div class="sheet-full">
      <div class="sheet-card" style="background:${cardBackground(d)}">
        <div class="sheet-kicker">${S.pinned
          ? 'from the map'
          : `<span class="rank-pill">#${pos + 1}</span> your next stop`}</div>
        <div class="sheet-headline">
          <span class="card-glyph">${catIcon(d)}</span>
          <div>
            <h2 class="card-name">${d.name}</h2>
            <div class="card-state">${d.state} · ${d.tagline}</div>
          </div>
        </div>
        <div class="card-dist">${icon('pin')} ${travelText(roadKm, hours)} from ${S.origin.name}</div>
        <div class="why-now"><b>Why now —</b> ${why}</div>
        <div class="badge-row">${statusBadge}${festBadge}${lwBadge}</div>
        <div class="card-meta">
          <span>${icon('calendar')} <b>${d.days}${d.days === 1 ? ' day' : '+ days'}</b></span>
          <span class="rupee"><b>${rupee}</b></span>
          <span>${icon('backpack')} solo <b>${d.solo}/5</b></span>
          ${d.crowd ? `<span>${icon('users')} <b>${['quiet', 'moderate', 'packed'][d.crowd - 1] || 'moderate'}</b> in peak</span>` : ''}
          ${d.alt > 500 ? `<span>${icon('peak')} <b>${d.alt.toLocaleString('en-IN')} m</b></span>` : ''}
        </div>
        ${modesHtml(d, true) ? `<div class="card-meta modes-meta">${modesHtml(d, true)}</div>` : ''}
        <div class="card-meta"><span class="vibe-line">${d.vibe}</span></div>
        <div class="card-meta"><span>${icon('bus')} ${d.hub}</span></div>
        ${onward.length ? `<div class="card-meta onward-meta"><span>${icon('route')} from here, next: ${onward.map(o => `<b>${o.d.name}</b> (${o.roadKm} km)`).join(' or ')}</span></div>` : ''}
      </div>

      <div class="sheet-actions">
        <button class="btn btn-primary sheet-next" id="btnAnother">${S.pinned ? 'Back to my picks' : `Show me another ${icon('arrowRight')}`}</button>
        <div class="sheet-acts">
          <a class="card-act" target="_blank" rel="noopener"
             href="https://www.google.com/maps/dir/?api=1&origin=${S.origin.lat},${S.origin.lng}&destination=${encodeURIComponent(d.name + ', ' + d.state)}">
            ${icon('navigation')}Directions</a>
          <button class="card-act" id="actShare">${icon('share')}Share</button>
          <button class="card-act ${store.isSaved(d.id) ? 'is-done' : ''}" id="actSave">
            ${icon(store.isSaved(d.id) ? 'heartFill' : 'heart')}Save</button>
          <button class="card-act" id="actBeen">${icon('check')}Been there</button>
        </div>
      </div>

      <div class="sheet-alts">
        <div class="alt-head"><h3>Also in reach</h3><span class="alt-count">${S.ranked.length} place${S.ranked.length === 1 ? '' : 's'} in range</span></div>
        <div class="alt-grid" id="altGrid"></div>
      </div>
    </div>`;

  $('sheetPeek').onclick = e => { if (!e.target.closest('.btn')) toggleSheet(true); };
  $('btnAnotherPeek').onclick = nextPick;
  $('btnAnother').onclick = nextPick;
  $('actShare').onclick = () => shareDest(d, item);
  $('actSave').onclick = () => {
    const on = store.toggleSaved(d.id);
    toast(on ? `Saved ${d.name} for later` : `Removed ${d.name} from saved`);
    renderSheet(item);
  };
  $('actBeen').onclick = () => {
    store.toggleBeen(d.id);
    toast(`Done — ${d.name} won't be suggested again`);
    S.pinned = null;
    S.idx = 0;  // ranked list just shrank; restart from the top pick
    render(true);
  };

  // alternates inside the expanded sheet
  const grid = $('altGrid');
  const start = S.pinned ? 0 : (S.idx % Math.max(S.ranked.length, 1)) + 1;
  for (let j = start; j < S.ranked.length && grid.children.length < 6; j++) {
    const it = S.ranked[j];
    const b = document.createElement('button');
    b.className = 'alt-card';
    b.innerHTML = `
      <div class="card-bg" style="background:${cardBackground(it.d)}"></div>
      <span class="alt-status" style="background:${{ peak: 'var(--peak)', shoulder: 'var(--shoulder)', off: 'var(--off)' }[it.status] || 'var(--off)'}"></span>
      <span class="alt-glyph">${catIcon(it.d)}</span>
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
    // drag ONLY from the handle or the collapsed peek — the expanded body
    // scrolls, and a drag gesture there must scroll, not collapse the sheet
    if (!e.target.closest('#sheetHandle, .sheet-peek')) return;
    if (e.target.closest('.btn, a')) return;
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
    const row = document.createElement('div');
    row.className = 'saved-item';
    row.innerHTML = `
      ${catBadge(d)}
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
function effectiveTheme() {
  return document.documentElement.getAttribute('data-theme') ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function applyTheme(next) {
  setMapTheme(next);                       // basemap + India-border colour
  if (S.origin && !$('screen-map').hidden) render(false);  // arcs pick up themed colours
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  document.documentElement.style.colorScheme = next;
  store.theme = next;
  applyTheme(next);
}

// follow OS theme flips while the user hasn't made an explicit choice
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
  if (document.documentElement.getAttribute('data-theme')) return;
  applyTheme(e.matches ? 'dark' : 'light');
});

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-show'), 2600);
}
