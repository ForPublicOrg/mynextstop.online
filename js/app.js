import { MONTHS, seasonOf, rank, whereAmI, longWeekends, fmtRange, seasonStatus, roadEstimate, travelText, festivalMonth, haversineKm } from './engine.js?v=e4';
import { CATEGORY_LABEL, catBadge, catIcon, cardBackground, spotKind, spotBadge } from './themes.js?v=e4';
import { icon } from './icons.js?v=e4';
import { CITIES, nearestCity } from './cities.js?v=e4';
import { locate, inIndia } from './geo.js?v=e4';
import { store } from './store.js?v=e4';
import { initMap, updateMap, nudgeMap, setMapTheme } from './map.js?v=e4';

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
// A generated guide page links here as /?to=<id>: land on the map with that
// place already open. Ranking needs an origin, so when there isn't one yet
// the pin waits in `pendingPin` until the "where are you?" answer arrives.
const WANT_ID = new URLSearchParams(location.search).get('to');
let pendingPin = null;
// True until an origin is settled. The launch fix arrives late, so it must
// check this before overruling a city the user typed while it was in flight.
let booting = true;
// Resolves true once the catalogue is in memory, false if it never arrives.
// The search box works before that (the city list is in-module), so a city
// picked early waits on this instead of blocking the typing.
let dataReady = null;
// A launch fix that landed while the user was mid-typing: held here rather
// than yanking the screen away, and used by the next locate tap for free.
let lateFix = null, lateFixAt = 0;

const DIST_KM = { nearby: 150, weekend: 450, long: 900, anywhere: Infinity };
const DIST_LABEL = [
  ['nearby', 'Quick hop', '≤150 km'],
  ['weekend', 'Weekend', '≤450 km'],
  ['long', 'Long weekend', '≤900 km'],
  ['anywhere', 'Anywhere', ''],
];

const $ = id => document.getElementById(id);
// A labelled button keeps its label as a bare text node so the accessible name
// is still computed from the button's contents. Swapping that node is how the
// wait states retitle a button without disturbing its icon.
const btnLabel = btn => [...btn.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
// resting copy for the two lines the launch wait borrows, so the wording
// itself stays in index.html
const HERO_NOTE = $('heroNote').textContent;
const LOCATE_LABEL = btnLabel($('btnLocate')).textContent;

// The curated data is written elsewhere; keep its em-dashes out of the UI
// at render time instead of editing the catalogue.
const deDash = s => typeof s === 'string' ? s.replace(/\s*[—–]\s*/g, ', ') : s;
function cleanDest(d) {
  for (const k of ['name', 'tagline', 'vibe', 'festival', 'hub']) if (d[k]) d[k] = deDash(d[k]);
  if (d.why) for (const k of Object.keys(d.why)) d.why[k] = deDash(d.why[k]);
  d.spots = Array.isArray(d.spots) ? d.spots.filter(s => s && s.name && s.note) : [];
  for (const s of d.spots) { s.name = deDash(s.name); s.note = deDash(s.note); }
  return d;
}
// the catalogue is first-party, but spot notes are free prose: keep them inert
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ----- boot -----
init();
async function init() {
  paintThemeBtns();
  buildMonthSel();
  buildDistChips();
  wireEvents();

  // Every launch asks the browser where the phone is now: a saved origin is
  // the fallback, not the default. Someone who used the site from Delhi last
  // month and opens it in Goa should get Goa. Fired before the catalogue
  // fetch so the prompt (or a cached fix) overlaps the download.
  setLocating(true);
  const fix = requestFix();

  dataReady = loadData();
  if (!(await dataReady)) return;

  buildMoodChips();  // needs DESTS: chips reflect categories actually in the data

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

  settleOrigin(await fix);
}

// The catalogue download. On a phone this is the slow part of the launch
// (it is bigger than everything else put together), which is why nothing
// above waits for it except the things that need the data itself.
async function loadData() {
  try {
    const [d, h] = await Promise.all([
      fetch('data/destinations.json').then(r => { if (!r.ok) throw 0; return r.json(); }),
      fetch('data/holidays.json').then(r => r.json()).catch(() => []),
    ]);
    if (!Array.isArray(d) || !d.length) throw 0;
    DESTS = d.map(cleanDest);
    HOLIDAYS = h;
    if (WANT_ID) pendingPin = DESTS.find(x => x.id === WANT_ID) || null;
    // a list typed out while this was downloading only knew the cities
    if (!$('homeResults').hidden) renderResults($('homeSearch').value, $('homeResults'));
    return true;
  } catch {
    // persistent error state, distinct from "no results for these filters"
    setLocating(false);
    $('btnLocate').disabled = true;
    $('homeSearch').disabled = true;
    $('homeResults').hidden = true;
    $('heroNote').innerHTML =
      'Couldn’t load destinations. Check your connection. ' +
      '<button id="btnRetry" class="btn-link">Retry</button>';
    $('btnRetry').onclick = () => location.reload();
    $('screen-map').hidden = true;
    $('screen-home').hidden = false;
    return false;
  }
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
  // the chip shows the choice; the select itself is the invisible hit area
  const paint = () => { $('monthLabel').textContent = (S.month === now.getMonth() + 1 ? 'Now · ' : '') + MONTHS[S.month - 1]; };
  paint();
  sel.onchange = () => { S.month = +sel.value; S.idx = 0; S.pinned = null; paint(); render(true); };
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
  $('btnLocate').onclick = () => doLocate($('btnLocate'));
  $('mapLocateBtn').onclick = () => doLocate($('mapLocateBtn'));
  // the dialog opens from either screen: spin the control the user can see
  $('dlgLocate').onclick = () => {
    closeDlg($('originDlg'));
    doLocate($('screen-map').hidden ? $('btnLocate') : $('mapLocateBtn'));
  };
  $('originBtn').onclick = openOriginDlg;
  $('themeBtn').onclick = toggleTheme;
  $('themeBtnMap').onclick = toggleTheme;
  $('savedBtn').onclick = openSavedDlg;
  $('originSearch').oninput = e => renderResults(e.target.value, $('originResults'));
  // Enter (or the keyboard's Go) takes the top match. Left alone, the
  // method="dialog" form would submit and close the dialog with nothing chosen.
  $('originSearch').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = $('originResults').querySelector('.origin-item');
    if (first) first.click();
  });
  $('sheetHandle').onclick = () => toggleSheet();
  wireSheetDrag();
  wireHomeSearch();
  const goHome = e => {
    e.preventDefault();
    $('screen-map').hidden = true;
    $('screen-home').hidden = false;
    // the map is still there behind this screen: offer the way back, so a
    // stray tap on the logo never costs another locate
    if (S.origin && DESTS.length) {
      const note = $('heroNote');
      note.textContent = '';
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn-link';
      b.textContent = `Back to the map, from ${S.origin.name}`;
      b.onclick = () => enterMap();
      note.append(b);
    }
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
    fitResults();
  };
  input.addEventListener('focus', show);
  input.addEventListener('input', show);
  input.addEventListener('keydown', e => {
    // Enter takes the top match; Escape puts the list away
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = box.querySelector('.origin-item');
      if (first) first.click();
    }
    if (e.key === 'Escape') { box.hidden = true; input.blur(); }
  });
  // hide when tapping anywhere outside the search area
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('.home-search-wrap')) box.hidden = true;
  });
  // The list must end above the phone keyboard, which only shrinks the
  // visual viewport: size it to what is actually visible below the box.
  const vv = window.visualViewport;
  function fitResults() {
    if (!vv || box.hidden) return;
    const room = vv.offsetTop + vv.height - box.getBoundingClientRect().top - 8;
    box.style.maxHeight = Math.max(132, Math.min(320, room)) + 'px';
  }
  if (vv) {
    vv.addEventListener('resize', fitResults);
    vv.addEventListener('scroll', fitResults);
  }
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
    await initMap($('mapEl'),
      // a dot: it becomes the answer, and a sheet parked at the peek rises
      // to show it
      d => { S.pinned = d; S.idx = 0; if (sheetLevel === 0) setSheetLevel(1); render(true); },
      effectiveTheme(),
      // bare map: on a phone the sheet drops to the peek so the map is the
      // whole screen; the docked desktop panel never covers the map
      () => { if (!isDesktop() && sheetLevel > 0) setSheetLevel(0); });
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
// The launch fix. Resolves to a position or to null: "the browser won't say"
// is an ordinary outcome on this path, not an error, so it never rejects.
async function requestFix() {
  if (!('geolocation' in navigator)) return null;
  try {
    // A blocked site rejects instantly and noisily in the console. When the
    // Permissions API can tell us that for free, skip the pointless ask.
    const p = await navigator.permissions?.query({ name: 'geolocation' });
    if (p && p.state === 'denied') return null;
  } catch { /* no Permissions API, or it doesn't know the name: just ask */ }
  try { return await locate(); } catch { return null; }
}

// Where the launch lands. The fresh fix wins; the last start point is what's
// left when the browser won't say; the home screen is what's left after that.
function settleOrigin(pos) {
  setLocating(false);
  if (!booting) return;   // a city was typed while the fix was in flight: it stands

  if (pos && inIndia(pos)) {
    const input = $('homeSearch');
    if (document.activeElement === input && input.value.trim()) {
      // mid-typing: hold the fix instead of yanking the screen away; the
      // locate button uses it without a second wait
      lateFix = pos; lateFixAt = Date.now();
      $('heroNote').textContent = `Location found, ${originFrom(pos).name}. Tap Use my location, or keep typing.`;
      return;
    }
    setOrigin(originFrom(pos));
    return;
  }

  const why = pos
    ? 'You seem to be outside India. '
    : 'Couldn’t get your location. ';
  if (S.origin) {
    // say it, or a stale start point silently passes for the current one
    toast(why + 'Showing your last start point.');
    if (pendingPin) { S.pinned = pendingPin; pendingPin = null; }
    enterMap();
  } else if (pendingPin) {
    toast(why + 'Type where you’ll start instead.');
    openOriginDlg();       // nothing to draw a route from yet, so ask
  } else {
    $('heroNote').textContent = why + 'Type where you are, or try again.';
  }
}

// The wait, held on the home screen rather than a splash: if the fix never
// lands this is already the screen the user needs, so there's nothing to undo.
function setLocating(on) {
  const btn = $('btnLocate');
  btn.classList.toggle('is-busy', on);
  btn.disabled = on;
  btnLabel(btn).textContent = on ? 'Locating…' : LOCATE_LABEL;
  $('heroNote').textContent = on ? 'Locating you…' : HERO_NOTE;
}

// Coordinates read back as a place name: the catalogue first (standing in a
// destination should say so), then the nearest big city.
function originFrom(pos) {
  const here = whereAmI(DESTS, pos) || nearestCity(pos.lat, pos.lng);
  return { name: here.near ? `near ${here.name}` : here.name, lat: pos.lat, lng: pos.lng };
}

// Any of the three locate controls can drive this: each spins its icon, and
// the labelled ones say "Locating…" while they wait.
async function doLocate(btn = $('btnLocate')) {
  const label = btnLabel(btn);   // the icon-only map control has none
  const old = label && label.textContent;
  btn.classList.add('is-busy');
  if (label) label.textContent = 'Locating…';
  btn.disabled = true;
  try {
    const held = lateFix && Date.now() - lateFixAt < 120000 ? lateFix : null;
    lateFix = null;
    const pos = held || await locate();
    if (!inIndia(pos)) {
      toast('You seem to be outside India. Type where you’ll start instead.');
      openOriginDlg();
      return;
    }
    setOrigin(originFrom(pos));
  } catch {
    toast('Couldn’t get your location. Type where you are instead.');
    openOriginDlg();
  } finally {
    btn.classList.remove('is-busy');
    if (label) label.textContent = old;
    btn.disabled = false;
  }
}

async function setOrigin(o) {
  booting = false;
  S.origin = o;
  store.origin = o;
  S.idx = 0;
  $('homeResults').hidden = true;
  if (!DESTS.length) {
    // chosen before the catalogue landed: say so, and carry on when it does
    $('heroNote').textContent = `Loading places near ${o.name}…`;
    if (!(await dataReady)) return;   // the error state is already on screen
    if (S.origin !== o) return;       // a later choice superseded this one
  }
  S.pinned = pendingPin;   // a /?to= deep link survives the detour through this dialog
  pendingPin = null;
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

// The local places once you are there: temples, viewpoints, falls, the
// market. Each row opens a Google Maps search for the spot scoped to the
// destination, which is more reliable than a coordinate we would have to
// hand-verify for thousands of small places.
function spotsHtml(d) {
  const spots = d.spots || [];
  if (!spots.length) return '';
  const base = d.name.split('(')[0].trim();
  const rows = spots.map(s => {
    const k = spotKind(s.kind);
    const q = encodeURIComponent(`${s.name}, ${base}, ${d.state}`);
    const dist = s.km > 0 ? `${s.km} km` : 'in town';
    return `<li><a class="spot" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">
        ${spotBadge(s)}
        <span class="spot-main">
          <span class="spot-name">${esc(s.name)}</span>
          <span class="spot-meta">${k.label} · ${dist}</span>
          <span class="spot-note">${esc(s.note)}</span>
        </span>
      </a></li>`;
  }).join('');
  return `<div class="sheet-spots">
      <div class="alt-head"><h3>Local places</h3><span class="alt-count">${spots.length} in and around ${esc(base)}</span></div>
      <ul class="spot-list">${rows}</ul>
    </div>`;
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
    measureSheet();
    setSheetLevel(Math.min(sheetLevel, 1), true);
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

  // seeds the reel maker with this trip: where you are, then the pick
  const reelHref = '/reel?stops=' + [S.origin, d]
    .map(p => `${p.lat.toFixed(4)},${p.lng.toFixed(4)},${encodeURIComponent(p.name)}`).join('|');

  const statusDot = STATUS_VAR[status];
  const statusWord = STATUS_WORD[status];

  body.innerHTML = `
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
        <div class="card-dist">${icon('pin')} ${S.pinned ? '' : `<b>#${pos + 1}</b> · `}${travelText(roadKm, hours)} from ${S.origin.name} · <span style="color:${statusDot}" title="${statusWord}">●</span></div>
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
          <a class="card-act" id="actReel" href="${reelHref}">${icon('film')}Reel</a>
          <button class="card-act" id="actShare">${icon('share')}Share</button>
          <button class="card-act ${store.isSaved(d.id) ? 'is-done' : ''}" id="actSave">
            ${icon(store.isSaved(d.id) ? 'heartFill' : 'heart')}Save</button>
          <button class="card-act" id="actBeen">${icon('check')}Been there</button>
        </div>
      </div>

      ${spotsHtml(d)}

      <div class="sheet-alts">
        <div class="alt-head"><h3>Also in reach</h3><span class="alt-count">${S.ranked.length} in range</span></div>
        <div class="alt-grid" id="altList"></div>
      </div>
    </div>`;

  $('btnAnother').onclick = nextPick;
  const bp2 = $('btnPrev'); if (bp2) bp2.onclick = prevPick;
  // tapping the card itself (not a control inside it) pulls the sheet up a level
  body.querySelector('.sheet-card').onclick = e => { if (!e.target.closest('a, button')) setSheetLevel(sheetLevel + 1); };
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
    if (it.d.id === d.id) continue;   // a pinned place is not its own alternate
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

  measureSheet();
  // the docked desktop panel has the room, so it opens in full; a phone
  // keeps whatever level it was at (the half card to begin with) and pulls
  // up for the rest
  if (isDesktop()) setSheetLevel(2, true);
}

const isDesktop = () => matchMedia('(min-width: 900px)').matches;

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
// toggle or drag is compositor work only. Three rest levels on a phone:
//   0  peek: the handle and the card's title row; the map has the screen
//   1  half: the answer card and its "show me another" row
//   2  full: everything, scrollable
// The desktop panel is docked and only knows 1 and 2. sheetY holds the
// translateY (px) of each level, measured after every render since the
// card's height depends on its content.
let sheetSettleTimer = null;
let sheetLevel = 1;
let sheetY = [0, 0, 0];      // translateY per level
let sheetH = [110, 300];     // visible height at peek / half

// The resting transform is applied inline in px; the CSS transition animates
// it. A calc(var()) transform is not reliably re-resolved by Chrome when the
// variable changes.
function measureSheet() {
  const sheet = $('sheet'), body = $('sheetBody');
  if (!sheet.clientHeight) return;  // map screen hidden, keep last value
  const H = sheet.offsetHeight;
  const pad = parseFloat(getComputedStyle(body).paddingBottom) || 12;
  // offsetTop is layout position (relative to the sheet), so a scrolled
  // body does not skew it
  const bottomOf = el => el.offsetTop + el.offsetHeight;
  const half = body.querySelector('.sheet-next-row') || body.firstElementChild;
  const head = body.querySelector('.card-head');
  let hHalf = half ? Math.min(bottomOf(half) + pad, H * 0.55) : H * 0.4;
  // the peek stops right under the title row (name and description):
  // just enough to say a card is here, the rest of the screen is map
  let hPeek = head ? bottomOf(head) + 6 : hHalf;
  hHalf = Math.round(Math.max(hHalf, hPeek));
  hPeek = Math.round(hPeek);
  sheetH = [hPeek, hHalf];
  sheetY = [Math.max(0, H - hPeek), Math.max(0, H - hHalf), 0];
  syncPeekVar();
  // apply immediately: retargeting an in-flight snap keeps it one smooth
  // motion; only an active finger drag owns the transform exclusively
  if (!sheet.classList.contains('is-dragging')) applySheetTransform();
}

// the map's locate button and its credit line ride on the resting sheet
function syncPeekVar() {
  document.documentElement.style.setProperty('--peek-h', sheetH[Math.min(sheetLevel, 1)] + 'px');
}

function applySheetTransform() {
  $('sheet').style.transform = `translateY(${sheetY[sheetLevel]}px)`;
}

function setSheetLevel(level, instant = false) {
  const sheet = $('sheet');
  clearTimeout(sheetSettleTimer);
  sheetLevel = Math.max(isDesktop() ? 1 : 0, Math.min(2, level));
  sheet.classList.toggle('is-expanded', sheetLevel === 2);
  sheet.classList.toggle('is-peek', sheetLevel === 0);
  syncPeekVar();
  applySheetTransform();
  $('sheetHandle').setAttribute('aria-label', sheetLevel === 2 ? 'Collapse details' : 'Expand details');
  // reduced motion kills the transition, so the move IS instant: settle now
  // rather than leaving the sheet mid-way for 400ms
  if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) { settleSheet(); return; }
  sheet.classList.add('is-moving');
  // transitionend is the normal path; the timer is a safety net
  sheetSettleTimer = setTimeout(settleSheet, 400);
}
function settleSheet() {
  const sheet = $('sheet');
  sheet.classList.remove('is-moving');
  if (sheetLevel < 2) $('sheetBody').scrollTop = 0;   // the card is the top of the sheet
  applySheetTransform();  // pick up any re-measure that happened mid-flight
}

// the handle steps through the levels: peek, half, full, and back to half
function toggleSheet(force) {
  if (force === true) return setSheetLevel(2);
  if (force === false) return setSheetLevel(1);
  setSheetLevel(sheetLevel === 2 ? 1 : sheetLevel + 1);
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
      const expanded = sheetLevel === 2;
      const vertical = Math.abs(dy) > Math.abs(dx) * 1.2;
      // expanded + content scrolled (or an upward pull) = a scroll, not a drag
      if (!vertical || (expanded && !(dy > 0 && body.scrollTop <= 0))) { mode = 'scroll'; return; }
      mode = 'drag';
      range = Math.max(1, sheetY[isDesktop() ? 1 : 0]);
      base = sheetY[sheetLevel];
      // if grabbed mid-animation, pick up from the actual current position
      const t = getComputedStyle(sheet).transform;
      if (t && t !== 'none') { try { base = new DOMMatrixReadOnly(t).m42; } catch { /* keep level-based base */ } }
      clearTimeout(sheetSettleTimer);
      sheet.classList.add('is-dragging', 'is-moving');
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
    // a flick moves one level in its direction; otherwise snap to the nearest
    let target;
    if (Math.abs(vel) > 0.35) {
      target = vel > 0 ? (sheetY[1] > cur + 1 ? 1 : 0) : (sheetY[1] < cur - 1 ? 1 : 2);
    } else {
      target = [0, 1, 2].reduce((b, i) => Math.abs(sheetY[i] - cur) < Math.abs(sheetY[b] - cur) ? i : b, 0);
    }
    setSheetLevel(target);
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
    rsTimer = setTimeout(() => { if (!$('screen-map').hidden) measureSheet(); }, 150);
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
