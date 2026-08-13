import { MONTHS, seasonOf, rank, whereAmI, longWeekends, fmtRange, seasonStatus, roadEstimate, travelText, festivalMonth, haversineKm } from './engine.js';
import { CATEGORY_LABEL, catBadge, catIcon, cardBackground } from './themes.js';
import { icon } from './icons.js';
import { CITIES, nearestCity } from './cities.js';
import { locate, inIndia } from './geo.js';
import { store } from './store.js';
import { initMap, updateMap, nudgeMap, setMapTheme } from './map.js';

// ----- state -----
let DESTS = [];
let HOLIDAYS = [];
// IST "today", regardless of device timezone: the whole product (season
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

// The curated data is written elsewhere; keep its em-dashes out of the UI
// at render time instead of editing the catalogue.
const deDash = s => typeof s === 'string' ? s.replace(/\s*—\s*/g, ', ') : s;
function cleanDest(d) {
  for (const k of ['name', 'tagline', 'vibe', 'festival', 'hub']) if (d[k]) d[k] = deDash(d[k]);
  if (d.why) for (const k of Object.keys(d.why)) d.why[k] = deDash(d.why[k]);
  return d;
}

// ----- boot -----
init();
async function init() {
  paintThemeBtns();
  buildMonthSel();
  buildDistChips();
  wireEvents();

  try {
    const [d, h] = await Promise.all([
      fetch('data/destinations.json').then(r => { if (!r.ok) throw 0; return r.json(); }),
      fetch('data/holidays.json').then(r => r.json()).catch(() => []),
    ]);
    if (!Array.isArray(d) || !d.length) throw 0;
    DESTS = d.map(cleanDest);
    HOLIDAYS = h;
  } catch {
    // persistent error state, distinct from "no results for these filters"
    $('btnLocate').disabled = true;
    $('homeSearch').disabled = true;
    $('heroNote').innerHTML =
      'Couldn’t load destinations. Check your connection. ' +
      '<button id="btnRetry" class="btn-link">Retry</button>';
    $('btnRetry').onclick = () => location.reload();
    $('screen-map').hidden = true;
    $('screen-home').hidden = false;
    return;
  }

  buildMoodChips();  // needs DESTS: chips reflect categories actually in the data

  // CTAs stay disabled until the catalogue is in memory: a cached GPS fix
  // can resolve faster than the fetch and would rank an empty list
  $('btnLocate').disabled = false;
  $('homeSearch').disabled = false;

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

// ----- UI scaffolding -----
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
    b.type = 'button';
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
  for (const c of used) if (!CATEGORY_LABEL[c]) console.warn(`destination category "${c}" has no label/chip, check data/destinations.json`);
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'chip' + (S.moods.size === 0 ? ' is-on' : '');
  all.dataset.k = '';
  all.textContent = 'All';
  all.onclick = () => { S.moods.clear(); syncMoods(); };
  row.appendChild(all);
  for (const [key, label] of Object.entries(CATEGORY_LABEL).filter(([k]) => used.has(k))) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (S.moods.has(key) ? ' is-on' : '');
    b.dataset.k = key;
    b.innerHTML = `${icon(key)}${label}`;
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

function wireEvents() {
  wireDlgFallback($('originDlg'));
  wireDlgFallback($('savedDlg'));
  wireDlgFallback($('filterDlg'));
  $('filterBtn').onclick = () => openDlg($('filterDlg'));
  $('btnLocate').onclick = doLocate;
  $('dlgLocate').onclick = () => { closeDlg($('originDlg')); doLocate(); };
  $('originBtn').onclick = openOriginDlg;
  $('themeBtn').onclick = toggleTheme;
  $('themeBtnMap').onclick = toggleTheme;
  $('savedBtn').onclick = openSavedDlg;
  $('originSearch').oninput = e => renderResults(e.target.value, $('originResults'));
  $('sheetHandle').onclick = () => toggleSheet();
  wireSheetDrag();
  wireHomeSearch();
  const goHome = e => {
    e.preventDefault();
    $('screen-map').hidden = true;
    $('screen-home').hidden = false;
  };
  $('homeBtn').onclick = goHome;
  document.querySelector('.brand').onclick = goHome;
  document.addEventListener('keydown', e => {
    if ($('screen-map').hidden || dialogOpen()) return;
    if (e.key === 'ArrowRight') nextPick();
    if (e.key === 'ArrowLeft') prevPick();
  });
}

function wireHomeSearch() {
  const input = $('homeSearch');
  const box = $('homeResults');
  const show = () => {
    renderResults(input.value, box);
    box.hidden = false;
  };
  input.addEventListener('focus', show);
  input.addEventListener('input', show);
  // hide when tapping anywhere outside the search area
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('.home-search-wrap')) box.hidden = true;
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
  return $('originDlg').hasAttribute('open') || $('savedDlg').hasAttribute('open') || $('filterDlg').hasAttribute('open');
}

// ----- screens -----
async function enterMap() {
  $('screen-home').hidden = true;
  $('screen-map').hidden = false;
  try {
    await initMap($('mapEl'), d => { S.pinned = d; S.idx = 0; render(true); }, effectiveTheme());
  } catch {
    // don't strand the user on a blank map screen: back to home, retryable
    $('screen-map').hidden = true;
    $('screen-home').hidden = false;
    toast('Map failed to load. Check your connection and try again.');
    return;
  }
  nudgeMap();
  render(true);
}

// ----- origin -----
async function doLocate() {
  const btn = $('btnLocate');
  const old = btn.innerHTML;
  btn.textContent = 'Finding you…';
  btn.disabled = true;
  try {
    const pos = await locate();
    if (!inIndia(pos)) {
      toast('You seem to be outside India. Type where you’ll start instead.');
      openOriginDlg();
      return;
    }
    const here = whereAmI(DESTS, pos) || nearestCity(pos.lat, pos.lng);
    const label = here.near ? `near ${here.name}` : here.name;
    setOrigin({ name: label, lat: pos.lat, lng: pos.lng });
  } catch {
    toast('Couldn’t get your location. Type where you are instead.');
    openOriginDlg();
  } finally {
    btn.innerHTML = old;
    btn.disabled = false;
  }
}

function setOrigin(o) {
  S.origin = o;
  store.origin = o;
  S.idx = 0; S.pinned = null;
  $('homeResults').hidden = true;
  enterMap();
}

function openOriginDlg() {
  $('originSearch').value = '';
  renderResults('', $('originResults'));
  openDlg($('originDlg'));
  setTimeout(() => $('originSearch').focus(), 60);
}

// "Indore" is both a city in the origin list and a destination in the
// catalogue. Same place, so the search must not offer it twice. Matched on
// the name before any bracketed alias: "Visakhapatnam (Vizag)" === "Visakhapatnam".
const originKey = name => name.split('(')[0].trim().toLowerCase();

// shared search over cities + destinations; fills any results container
function renderResults(q, box) {
  q = q.trim().toLowerCase();
  const cityNames = new Set(CITIES.map(([name]) => originKey(name)));
  const pool = [
    ...CITIES.map(([name, lat, lng]) => ({ name, lat, lng, type: 'city' })),
    ...DESTS.filter(d => !cityNames.has(originKey(d.name)))
      .map(d => ({ name: d.name, lat: d.lat, lng: d.lng, type: d.state })),
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
  if (!hits.length) box.innerHTML = '<p class="search-empty">No match. Try a bigger city nearby.</p>';
}

// ----- the answer -----
function currentItem() {
  if (S.pinned) {
    const d = S.pinned;
    const km = haversineKm(S.origin.lat, S.origin.lng, d.lat, d.lng);
    const { roadKm, hours } = roadEstimate(km, d.alt);
    return { d, km: Math.round(km), roadKm, hours, status: seasonStatus(d, S.month), score: 0 };
  }
  return S.ranked.length ? S.ranked[S.idx % S.ranked.length] : null;
}

// Practical arrival modes as compact fact pills. d.modes ⊆ ["flight","train","road"].
const MODE_META = { flight: ['plane', 'flight'], train: ['train', 'train'], road: ['car', 'road'] };
function modeFacts(d) {
  if (!Array.isArray(d.modes) || !d.modes.length) return '';
  return d.modes.filter(m => MODE_META[m]).map(m => {
    const [ic, label] = MODE_META[m];
    return `<span class="fact">${icon(ic)} ${label}</span>`;
  }).join('');
}

// Where would you go next FROM the pick: the dashed onward arcs.
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

const STATUS_WORD = { peak: 'in season', shoulder: 'shoulder', off: 'off-season', avoid: 'avoid now' };
const STATUS_VAR = { peak: 'var(--peak)', shoulder: 'var(--shoulder)', off: 'var(--off)', avoid: 'var(--avoid)' };

function renderSheet(item) {
  const body = $('sheetBody');

  if (!item) {
    body.innerHTML = `
      <div class="sheet-empty">
        <b>Nothing in range for ${MONTHS[S.month - 1]}.</b>
        Widen the filters, pick another month, or tap any dot.
      </div>`;
    setSheetState(false, true);
    measurePeek();
    return;
  }

  const { d, roadKm, hours, status } = item;
  const season = seasonOf(S.month);
  const why = (d.why && d.why[season]) || d.tagline;
  const pos = S.pinned ? null : S.idx % S.ranked.length;

  const statusBadge = {
    peak: '<span class="badge badge-season-peak">In season now</span>',
    shoulder: '<span class="badge badge-season-shoulder">Shoulder season</span>',
    off: '<span class="badge badge-season-off">Off-season</span>',
    avoid: '<span class="badge badge-season-avoid">Not the time</span>',
  }[status];

  const fm = festivalMonth(d);
  const festBadge = fm && (fm === S.month || fm === (S.month % 12) + 1)
    ? `<span class="badge badge-festival">${d.festival}</span>` : '';

  const lwRun = matchingLongWeekend(d);
  const lwBadge = lwRun ? `<span class="badge badge-lw">Fits ${fmtRange(lwRun.start, lwRun.end)}</span>` : '';

  const statusDot = STATUS_VAR[status];
  const statusWord = STATUS_WORD[status];

  body.innerHTML = `
    <div class="sheet-peek" id="sheetPeek" role="button" aria-label="Expand details">
      <div class="peek-row1">
        <span class="peek-name">${d.name}</span>
        <i class="peek-dot" style="background:${statusDot}" title="${statusWord}"></i>
        <span class="peek-btns">
          ${!S.pinned && pos > 0 ? `<button class="btn-back" id="btnPrevPeek" aria-label="Previous pick">${icon('chevronLeft')}</button>` : ''}
          <button class="btn btn-primary peek-next" id="btnAnotherPeek">${S.pinned ? 'My picks' : `Next ${icon('arrowRight')}`}</button>
        </span>
      </div>
      <div class="peek-row2">${S.pinned ? '' : `<b>#${pos + 1}</b> · `}${travelText(roadKm, hours)} · <span class="peek-season" style="color:${statusDot}">${statusWord}</span></div>
    </div>

    <div class="sheet-full">
      <div class="sheet-card" style="background:${cardBackground(d)}">
        <div class="card-head">
          <span class="card-glyph">${catIcon(d)}</span>
          <div class="card-head-main">
            <h2 class="card-name">${d.name}</h2>
            <div class="card-state">${d.state} · ${d.tagline}</div>
          </div>
        </div>
        <div class="badge-row">${statusBadge}${festBadge}${lwBadge}</div>
        <div class="card-dist">${icon('pin')} ${travelText(roadKm, hours)} from ${S.origin.name}</div>
        <div class="why">${why}</div>
        <div class="facts">
          <span class="fact">${icon('calendar')} ${d.days}${d.days === 1 ? ' day' : '+ days'}</span>
          <span class="fact">${'₹'.repeat(d.budget || 2)}</span>
          <span class="fact">${icon('backpack')} solo ${d.solo}/5</span>
          ${d.crowd ? `<span class="fact">${icon('users')} ${['quiet', 'moderate', 'packed'][d.crowd - 1] || 'moderate'}</span>` : ''}
          ${d.alt > 500 ? `<span class="fact">${icon('peak')} ${d.alt.toLocaleString('en-IN')} m</span>` : ''}
          ${modeFacts(d)}
        </div>
      </div>

      <div class="sheet-actions">
        <div class="sheet-next-row">
          ${!S.pinned && pos > 0 ? `<button class="btn-back btn-back-lg" id="btnPrev" aria-label="Previous pick">${icon('chevronLeft')}</button>` : ''}
          <button class="btn btn-primary sheet-next" id="btnAnother">${S.pinned ? 'Back to my picks' : `Show me another ${icon('arrowRight')}`}</button>
        </div>
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
        <div class="alt-head"><h3>Also in reach</h3><span class="alt-count">${S.ranked.length} in range</span></div>
        <div class="alt-grid" id="altList"></div>
      </div>
    </div>`;

  $('sheetPeek').onclick = e => { if (!e.target.closest('.btn, .btn-back')) toggleSheet(true); };
  $('btnAnotherPeek').onclick = nextPick;
  $('btnAnother').onclick = nextPick;
  const bp = $('btnPrevPeek'); if (bp) bp.onclick = prevPick;
  const bp2 = $('btnPrev'); if (bp2) bp2.onclick = prevPick;
  $('actShare').onclick = () => shareDest(d, item);
  $('actSave').onclick = () => {
    const on = store.toggleSaved(d.id);
    toast(on ? `Saved ${d.name}` : `Removed ${d.name} from saved`);
    renderSheet(item);
  };
  $('actBeen').onclick = () => {
    store.toggleBeen(d.id);
    toast(`${d.name} won’t be suggested again`);
    S.pinned = null;
    S.idx = 0;  // ranked list just shrank; restart from the top pick
    render(true);
  };

  // alternates inside the expanded sheet
  const list = $('altList');
  const start = S.pinned ? 0 : (S.idx % Math.max(S.ranked.length, 1)) + 1;
  for (let j = start; j < S.ranked.length && list.children.length < 6; j++) {
    const it = S.ranked[j];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'alt-card';
    b.style.background = cardBackground(it.d);
    b.innerHTML = `
      <i class="alt-status" style="background:${STATUS_VAR[it.status] || 'var(--off)'}"></i>
      <span class="alt-glyph">${catIcon(it.d)}</span>
      <span class="alt-name">${it.d.name}</span>
      <span class="alt-sub">${it.roadKm} km · ${it.d.state}</span>`;
    b.onclick = () => { S.pinned = null; S.idx = j; toggleSheet(false); render(true); };
    list.appendChild(b);
  }
  if (!list.children.length) list.innerHTML = '<p class="saved-empty">Nothing else in range. Widen it or change the month.</p>';

  measurePeek();
}

function nextPick() {
  if (S.pinned) { S.pinned = null; render(true); return; }
  if (!S.ranked.length) return;
  S.idx++;
  if (S.idx % S.ranked.length === 0) { S.idx = 0; toast('That was everything in range. Back to the top pick.'); }
  render(true);
}

function prevPick() {
  if (S.pinned) { S.pinned = null; render(true); return; }
  if (!S.ranked.length || S.idx === 0) return;
  S.idx--;
  render(true);
}

// ----- bottom sheet: transform-only, finger-driven -----
// The sheet is a fixed-height panel slid via translateY, so every frame of a
// toggle or drag is compositor work only. Two classes with different lifetimes:
// .is-expanded is the target position; .show-full is the content, kept on
// through a collapse so the card is still visible while it slides away.
let sheetSettleTimer = null;
let sheetCollapsedY = 0;  // px the sheet sits below translateY(0) when collapsed

// Collapsed offset = sheet height minus peek height. Measured after each
// render (content-dependent). The resting transform is applied inline in px;
// the CSS transition animates it. A calc(var()) transform is not reliably
// re-resolved by Chrome when the variable changes.
function measurePeek() {
  const sheet = $('sheet'), body = $('sheetBody');
  if (!sheet.clientHeight) return;  // map screen hidden, keep last value
  const hadFull = sheet.classList.contains('show-full');
  if (hadFull) sheet.classList.remove('show-full');
  const ref = $('sheetPeek') || body.firstElementChild;
  if (ref) {
    const pad = parseFloat(getComputedStyle(body).paddingBottom) || 12;
    let h = ref.getBoundingClientRect().bottom - sheet.getBoundingClientRect().top + pad;
    h = Math.min(Math.round(h), Math.round(sheet.clientHeight * 0.45));
    sheetCollapsedY = Math.max(0, sheet.offsetHeight - h);
  }
  if (hadFull) sheet.classList.add('show-full');
  // apply immediately: retargeting an in-flight snap keeps it one smooth
  // motion; only an active finger drag owns the transform exclusively
  if (!sheet.classList.contains('is-dragging')) applySheetTransform();
}

function applySheetTransform() {
  const sheet = $('sheet');
  sheet.style.transform = sheet.classList.contains('is-expanded')
    ? 'translateY(0px)' : `translateY(${sheetCollapsedY}px)`;
}

function setSheetState(expand, instant = false) {
  const sheet = $('sheet');
  clearTimeout(sheetSettleTimer);
  if (expand) sheet.classList.add('show-full');
  sheet.classList.toggle('is-expanded', expand);
  applySheetTransform();
  $('sheetHandle').setAttribute('aria-label', expand ? 'Collapse details' : 'Expand details');
  // reduced motion kills the transition, so the move IS instant: settle now
  // rather than leaving the full card cropped in the peek strip for 400ms
  if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) { settleSheet(); return; }
  sheet.classList.add('is-moving');
  // transitionend is the normal path; the timer is a safety net
  sheetSettleTimer = setTimeout(settleSheet, 400);
}
function settleSheet() {
  const sheet = $('sheet');
  sheet.classList.remove('is-moving');
  if (!sheet.classList.contains('is-expanded')) sheet.classList.remove('show-full');
  applySheetTransform();  // pick up any re-measure that happened mid-flight
}

function toggleSheet(force) {
  const sheet = $('sheet');
  setSheetState(force !== undefined ? force : !sheet.classList.contains('is-expanded'));
}

function wireSheetDrag() {
  // Real bottom-sheet physics: the sheet follows the finger 1:1 and snaps on
  // release by position + velocity. The first ~9px decide whether the gesture
  // is a sheet drag or a content scroll; scrolls are left entirely native.
  const sheet = $('sheet');
  const body = $('sheetBody');
  const pt = e => (e.touches && e.touches.length ? e.touches[0] : e);
  let sy = 0, sx = 0, mode = null;            // null | 'drag' | 'scroll'
  let base = 0, range = 0, cur = 0;
  let lastY = 0, lastT = 0, vel = 0, raf = 0, mouseOn = false;

  sheet.addEventListener('transitionend', e => {
    if (e.target === sheet && e.propertyName === 'transform') { clearTimeout(sheetSettleTimer); settleSheet(); }
  });

  const start = e => {
    const p = pt(e);
    sy = p.clientY; sx = p.clientX;
    lastY = sy; lastT = e.timeStamp; vel = 0; mode = null;
  };
  const move = e => {
    if (mode === 'scroll') return;
    const p = pt(e);
    const dy = p.clientY - sy, dx = p.clientX - sx;
    if (mode === null) {
      if (Math.abs(dy) < 9 && Math.abs(dx) < 9) return;
      const expanded = sheet.classList.contains('is-expanded');
      const vertical = Math.abs(dy) > Math.abs(dx) * 1.2;
      // expanded + content scrolled (or an upward pull) = a scroll, not a drag
      if (!vertical || (expanded && !(dy > 0 && body.scrollTop <= 0))) { mode = 'scroll'; return; }
      mode = 'drag';
      range = Math.max(1, sheetCollapsedY);
      base = expanded ? 0 : range;
      // if grabbed mid-animation, pick up from the actual current position
      const t = getComputedStyle(sheet).transform;
      if (t && t !== 'none') { try { base = new DOMMatrixReadOnly(t).m42; } catch { /* keep class-based base */ } }
      clearTimeout(sheetSettleTimer);
      sheet.classList.add('is-dragging', 'is-moving', 'show-full');
      sy = p.clientY;  // re-anchor so the sheet doesn't jump to the slop distance
    }
    if (e.cancelable) e.preventDefault();
    cur = Math.min(range, Math.max(0, base + (p.clientY - sy)));
    const dt = e.timeStamp - lastT;
    if (dt > 0) { vel = (p.clientY - lastY) / dt; lastY = p.clientY; lastT = e.timeStamp; }
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; sheet.style.transform = `translateY(${cur}px)`; });
  };
  const swallowClick = ev => { ev.stopPropagation(); ev.preventDefault(); };
  const end = () => {
    const wasDrag = mode === 'drag';
    mode = null;
    if (!wasDrag) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; sheet.style.transform = `translateY(${cur}px)`; }
    sheet.classList.remove('is-dragging');
    // a mouse drag released over a button must not count as a click on it
    sheet.addEventListener('click', swallowClick, { capture: true, once: true });
    setTimeout(() => sheet.removeEventListener('click', swallowClick, { capture: true }), 120);
    // a flick wins over position; otherwise snap to the nearer state
    setSheetState(Math.abs(vel) > 0.35 ? vel < 0 : cur < range / 2);
  };

  sheet.addEventListener('touchstart', start, { passive: true });
  sheet.addEventListener('touchmove', move, { passive: false });
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
  sheet.addEventListener('mousedown', e => { if (e.button === 0) { mouseOn = true; start(e); } });
  window.addEventListener('mousemove', e => { if (mouseOn) move(e); });
  window.addEventListener('mouseup', () => { if (mouseOn) { mouseOn = false; end(); } });

  let rsTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(rsTimer);
    rsTimer = setTimeout(() => { if (!$('screen-map').hidden) measurePeek(); }, 150);
  });
}

// ----- long weekends -----
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

// ----- share -----
async function shareDest(d, item) {
  const seasonLine = { peak: 'peak season right now', shoulder: 'shoulder season, fewer crowds', off: 'off-season', avoid: 'not the season' }[item.status];
  const text = `My next stop: ${d.name}, ${d.state}. ${item.roadKm} km away, ${seasonLine}. Find yours at mynextstop.online`;
  try {
    if (navigator.share) { await navigator.share({ title: 'my next stop', text, url: 'https://mynextstop.online' }); return; }
    throw 0;
  } catch {
    try { await navigator.clipboard.writeText(text); toast('Copied. Paste it anywhere.'); }
    catch { toast(text); }
  }
}

// ----- saved dialog -----
function openSavedDlg() {
  renderSaved();
  openDlg($('savedDlg'));
}
function renderSaved() {
  fillList($('savedList'), store.saved, 'Nothing saved yet. Tap Save on any pick.', id => {
    store.toggleSaved(id); renderSaved();
  });
  fillList($('beenList'), store.been, 'Tap Been there on a pick and it stops being suggested.', id => {
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

// ----- theme / toast -----
function effectiveTheme() {
  return document.documentElement.getAttribute('data-theme') ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function paintThemeBtns() {
  // the button shows the theme you'd switch to
  const html = icon(effectiveTheme() === 'dark' ? 'sun' : 'moon');
  $('themeBtn').innerHTML = html;
  $('themeBtnMap').innerHTML = html;
}

function applyTheme(next) {
  paintThemeBtns();
  setMapTheme(next);                       // basemap + border + arc colors
  if (S.origin && !$('screen-map').hidden) render(false);
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
