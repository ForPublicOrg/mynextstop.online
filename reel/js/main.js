/**
 * Reel maker, UI shell.
 *
 * Owns the project state, the stops builder, the preview clock and the export
 * modal. The engine (scene.js, themes.js, vehicles.js, tiles.js) and the
 * encoder (exporter.js) are pure modules that know nothing about this DOM.
 *
 * Every piece of user text reaches the page through textContent.
 */

import { THEMES, DEFAULT_THEME, paintSwatch } from './themes.js';
import { MODE_META } from './vehicles.js';
import { TileCache } from './tiles.js';
import { haversineKm } from './geo.js';
import {
  FORMATS, buildTimeline, renderFrame, planTiles, setupPreviewCanvas
} from './scene.js';
import { exportVideo, detectExportSupport } from './exporter.js';
import { createSearch } from './search.js';
import { roadKey, fetchRoad, cachedRoad, storeRoad } from './routes.js';

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';
const STORAGE_KEY = 'mns-reel-draft-v1';
/** Where the draft waits when a trip handed over from the map takes its place. */
const PREV_KEY = 'mns-reel-draft-prev';
const THEME_KEY = 'mns-theme';
const MAX_STOPS = 12;
const PREVIEW_MAX_W = 380;
/** Legs longer than this default to a flight. */
const PLANE_KM = 600;
/** Two picks this close with the same name are the same place. Matches search.js. */
const SAME_PLACE_DEG = 0.15;
/** Longest stop label the UI will ever hold, typed or restored. */
const MAX_LABEL = 40;
/** Longest canonical place name kept from a draft. */
const MAX_NAME = 60;
/** Tiles the background preview prefetch is allowed to ask for. */
const WARM_TILE_CAP = 1200;
const SPEEDS = ['relaxed', 'normal', 'fast'];
const ROUTE_STYLES = ['roads', 'arcs'];
/** Fair use on the shared router: never more than two requests in the air. */
const ROAD_CONCURRENCY = 2;
/** Longest an export will wait for roads that are still on the wire. */
const ROAD_EXPORT_WAIT = 6500;
/** A failed key waits this long before its one further attempt. */
const ROAD_RETRY_MS = 30000;
/** Attempts per key per session, retry included. Never more. */
const ROAD_MAX_TRIES = 2;
/** First cooldown after the router says it is busy. */
const ROAD_BACKOFF_MIN = 30000;
/** The cooldown doubles per trip and stops here. */
const ROAD_BACKOFF_MAX = 240000;
/** Said on a leg that asked for a road route and did not get one. */
const ROAD_FALLBACK_TITLE = 'Stylized path, road route unavailable';

const ICONS = {
  pencil: ['M4 20.4h4.1L20.1 8.4a2 2 0 0 0 0-2.9l-1.6-1.6a2 2 0 0 0-2.9 0L3.6 16v4.4z', 'm14.6 5.4 4 4'],
  close: ['M6.2 6.2 17.8 17.8', 'M17.8 6.2 6.2 17.8'],
  up: ['m6.5 14.5 5.5-5.5 5.5 5.5'],
  down: ['m6.5 9.5 5.5 5.5 5.5-5.5'],
  play: ['M8.4 5.3v13.4L19 12z'],
  pause: ['M8.8 5.4h3.1v13.2H8.8z', 'M15.1 5.4h3.1v13.2h-3.1z'],
  download: ['M12 3.6v10.9', 'm7.6 10.2 4.4 4.3 4.4-4.3', 'M4.6 16.4v2.1a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-2.1'],
  sun: ['M12 7.4a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2z',
        'M12 2.2v2.1M12 19.7v2.1M2.2 12h2.1M19.7 12h2.1M5.1 5.1l1.5 1.5M17.4 17.4l1.5 1.5M18.9 5.1l-1.5 1.5M6.6 17.4l-1.5 1.5'],
  moon: ['M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8z']
};

/** The sample trip offered from the empty state. */
const SAMPLE = {
  title: 'Golden Triangle',
  themeId: 'voyage',
  stops: [
    { name: 'Delhi', lat: 28.6139, lng: 77.2090, region: 'Delhi', country: 'India', source: 'photon', tagline: '' },
    { name: 'Agra', lat: 27.1767, lng: 78.0081, region: 'Uttar Pradesh', country: 'India', source: 'photon', tagline: '' },
    { name: 'Jaipur', lat: 26.9124, lng: 75.7873, region: 'Rajasthan', country: 'India', source: 'photon', tagline: '' }
  ],
  modes: ['car', 'car']
};

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

/**
 * @param {string} id element id
 * @returns {HTMLElement}
 */
function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error('missing element: ' + id);
  return el;
}

/**
 * @param {string} tag tag name
 * @param {string} [cls] class name
 * @param {string} [text] text content
 * @returns {HTMLElement}
 */
function make(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * Build an inline SVG icon from path data.
 * @param {Array<string>} paths d attributes
 * @param {{ filled?: boolean, cls?: string }} [opts] filled uses currentColor fill
 * @returns {SVGSVGElement}
 */
function icon(paths, opts) {
  const o = opts || {};
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', o.cls || 'ic');
  if (o.filled) {
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('stroke', 'none');
  } else {
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  }
  for (let i = 0; i < paths.length; i++) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', paths[i]);
    svg.appendChild(p);
  }
  return svg;
}

/**
 * @param {number} km distance
 * @returns {string} e.g. "1,240 km"
 */
function fmtKm(km) {
  return Math.round(km).toLocaleString('en-US') + ' km';
}

/**
 * @param {number} sec seconds
 * @returns {string} e.g. "0:16"
 */
function fmtTime(sec) {
  const whole = Math.max(0, Math.round(sec));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return m + ':' + (s < 10 ? '0' + s : String(s));
}

/**
 * @param {number} bytes size
 * @returns {string} e.g. "12.4 MB"
 */
function fmtSize(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return mb.toFixed(1) + ' MB';
}

/**
 * @param {Function} fn function to defer
 * @param {number} ms delay
 * @returns {Function} debounced wrapper
 */
function debounce(fn, ms) {
  let id = 0;
  return function () {
    const args = arguments;
    clearTimeout(id);
    id = setTimeout(function () { fn.apply(null, args); }, ms);
  };
}

/* ------------------------------------------------------------------ *
 * DOM references
 * ------------------------------------------------------------------ */

const dom = {
  themeBtn: byId('themeBtn'),
  search: byId('stopSearch'),
  results: byId('stopResults'),
  stopList: byId('stopList'),
  stopsEmpty: byId('stopsEmpty'),
  styleRow: byId('styleRow'),
  formatSeg: byId('formatSeg'),
  speedSeg: byId('speedSeg'),
  title: byId('tripTitle'),
  exportBtn: byId('exportBtn'),
  exportHint: byId('exportHint'),
  exportBtnMobile: byId('exportBtnMobile'),
  previewHold: byId('previewHold'),
  phone: byId('phoneFrame'),
  canvas: /** @type {HTMLCanvasElement} */ (byId('previewCanvas')),
  empty: byId('emptyState'),
  sampleBtn: byId('sampleBtn'),
  playBar: byId('playBar'),
  playBtn: byId('playBtn'),
  seek: /** @type {HTMLInputElement} */ (byId('seek')),
  timecode: byId('timecode'),
  live: byId('live'),
  dlg: /** @type {HTMLDialogElement} */ (byId('exportDlg')),
  exTitle: byId('exTitle'),
  exProgress: byId('exProgress'),
  exStage: byId('exStage'),
  exBar: byId('exBar'),
  exCount: byId('exCount'),
  exCancel: byId('exCancel'),
  exDone: byId('exDone'),
  exVideo: /** @type {HTMLVideoElement} */ (byId('exVideo')),
  exMeta: byId('exMeta'),
  exFallbackNote: byId('exFallbackNote'),
  exTileNote: byId('exTileNote'),
  exDownload: /** @type {HTMLAnchorElement} */ (byId('exDownload')),
  exClose: byId('exClose'),
  exError: byId('exError'),
  exErrorMsg: byId('exErrorMsg'),
  exRetry: byId('exRetry'),
  exErrClose: byId('exErrClose')
};

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const state = {
  title: '',
  /** @type {Array<Object>} */ stops: [],
  /** @type {Array<string>} */ modes: [],
  themeId: DEFAULT_THEME,
  format: '9x16',
  speed: 'normal',
  /** Road geometry that arrived, keyed by roadKey. Never persisted. */
  /** @type {Object<string, { coords: Array<Array<number>>, km: number }>} */ roads: {},
  /** 'roads' follows real roads on drive and ride legs, 'arcs' keeps the stylized bow. */
  routeStyle: 'roads'
};

/** Explicit mode choices, keyed "fromId|toId", so reordering restores them. */
const modeMemory = new Map();
/** One tile cache per theme, shared by preview and export. */
const tileCaches = new Map();

let stopSeq = 0;
let timeline = null;
let ctx = null;
let t = 0;
let playing = false;
let rafId = 0;
let lastNow = 0;
let exportSupport = { mp4: true, webm: true };
let exporting = false;
/** Element to focus once the stop list re-renders. */
let focusAfterRender = null;

/**
 * @returns {Object} a defensive copy of the project for the engine
 */
function project() {
  return {
    title: state.title,
    stops: state.stops.slice(),
    modes: state.modes.slice(),
    themeId: state.themeId,
    format: state.format,
    speed: state.speed,
    // Stylized mode hands the engine nothing, so every leg falls back to its arc.
    roads: state.routeStyle === 'roads' ? state.roads : {}
  };
}

/**
 * @returns {string} next stable stop id
 */
function nextId() {
  stopSeq += 1;
  return 's' + stopSeq;
}

/**
 * @param {string} themeId theme key
 * @returns {TileCache}
 */
function tilesFor(themeId) {
  let cache = tileCaches.get(themeId);
  if (!cache) {
    cache = new TileCache(THEMES[themeId].tiles);
    tileCaches.set(themeId, cache);
  }
  return cache;
}

/**
 * @param {number} i leg index
 * @returns {number} great-circle km between stop i and i+1
 */
function legKm(i) {
  return haversineKm(state.stops[i], state.stops[i + 1]);
}

/** Recompute every leg mode from memory, falling back to the distance rule. */
function recomputeModes() {
  const modes = [];
  for (let i = 0; i < state.stops.length - 1; i++) {
    const a = state.stops[i].id;
    const b = state.stops[i + 1].id;
    // A leg is the same leg in either direction, so a reversal keeps the choice.
    if (modeMemory.has(a + '|' + b)) modes.push(modeMemory.get(a + '|' + b));
    else if (modeMemory.has(b + '|' + a)) modes.push(modeMemory.get(b + '|' + a));
    else modes.push(legKm(i) > PLANE_KM ? 'plane' : 'car');
  }
  state.modes = modes;
}

/* ------------------------------------------------------------------ *
 * road routes
 *
 * One place decides what the router is asked for. Everything here is
 * optional: a leg without a road simply keeps its stylized arc, so no
 * failure path can block the preview or the export.
 * ------------------------------------------------------------------ */

/**
 * Keys the router refused, with what to do about it: key -> { tries, retryAt }.
 * A transient blip gets one more chance after a wait, so a page that loaded in
 * a tunnel heals itself; retryAt is Infinity once the attempts are spent, and
 * that key is done for the session.
 * @type {Map<string, { tries: number, retryAt: number }>}
 */
const roadFailed = new Map();
/** In flight or waiting, keyed by roadKey. One job per key, so requests dedupe. */
const roadJobs = new Map();
/** Keys waiting for a slot, oldest first. */
const roadQueue = [];
let roadActive = 0;
/** No job starts before this. Set when the router asks us to back off. */
let roadPauseUntil = 0;
/** How long the next 429 or 5xx will cost, doubling per trip. */
let roadBackoff = ROAD_BACKOFF_MIN;
/** The one timer that wakes the pump for a retry or the end of a cooldown. */
let roadWakeTimer = null;
let roadWakeAt = 0;

/**
 * @param {string} key road key
 * @param {number} now current time in ms
 * @returns {boolean} true while this key must not be asked for again
 */
function roadBlocked(key, now) {
  const miss = roadFailed.get(key);
  return !!miss && now < miss.retryAt;
}

/**
 * One timer for the whole pipeline, always set to the earliest wake wanted.
 * @param {number} at when to look at the queue again, in ms
 */
function scheduleRoadWake(at) {
  if (!Number.isFinite(at)) return;
  if (roadWakeTimer && roadWakeAt <= at) return;
  if (roadWakeTimer) clearTimeout(roadWakeTimer);
  roadWakeAt = at;
  roadWakeTimer = setTimeout(function () {
    roadWakeTimer = null;
    roadWakeAt = 0;
    syncRoads();
  }, Math.max(0, at - Date.now()));
}

/**
 * The road keys this trip wants right now, with the coordinates to ask for.
 * Empty while the route style is stylized. Identical legs collapse to one key.
 * @returns {Map<string, { a: Object, b: Object, mode: string }>}
 */
function wantedRoads() {
  const out = new Map();
  if (state.routeStyle !== 'roads') return out;
  for (let i = 0; i < state.stops.length - 1; i++) {
    const a = state.stops[i];
    const b = state.stops[i + 1];
    if (!a || !b) continue;
    const key = roadKey(a, b, state.modes[i]);
    if (!key || out.has(key)) continue;
    out.set(key, {
      a: { lat: a.lat, lng: a.lng },
      b: { lat: b.lat, lng: b.lng },
      mode: state.modes[i]
    });
  }
  return out;
}

/**
 * @param {number} i leg index
 * @returns {Object|null} the road for that leg, when one is being used
 */
function roadForLeg(i) {
  if (state.routeStyle !== 'roads') return null;
  const a = state.stops[i];
  const b = state.stops[i + 1];
  if (!a || !b) return null;
  const key = roadKey(a, b, state.modes[i]);
  return key ? (state.roads[key] || null) : null;
}

/**
 * @param {number} i leg index
 * @returns {'none'|'pending'|'failed'} what the router is doing for that leg
 */
function roadStateForLeg(i) {
  if (state.routeStyle !== 'roads') return 'none';
  const a = state.stops[i];
  const b = state.stops[i + 1];
  if (!a || !b) return 'none';
  const key = roadKey(a, b, state.modes[i]);
  if (!key || state.roads[key]) return 'none';
  if (roadJobs.has(key)) return 'pending';
  // A key waiting for its retry reads as failed, which is what it is until the
  // second attempt lands: the leg is a stylized arc right now.
  if (roadFailed.has(key)) return 'failed';
  return 'none';
}

/**
 * Distance to show for a leg: the router's driving km once it lands, the
 * straight line until then.
 * @param {number} i leg index
 * @returns {number} km
 */
function legKmShown(i) {
  const road = roadForLeg(i);
  return road && Number.isFinite(road.km) ? road.km : legKm(i);
}

/** Start jobs until the two slots are full, unless the router said wait. */
function pumpRoads() {
  // Breaker open: a router answering 429 or 5xx in milliseconds would
  // otherwise get the whole remaining queue as one burst.
  if (Date.now() < roadPauseUntil) {
    scheduleRoadWake(roadPauseUntil);
    return;
  }
  while (roadActive < ROAD_CONCURRENCY && roadQueue.length) {
    const key = roadQueue.shift();
    const job = roadJobs.get(key);
    // Cancelled while it sat in the queue.
    if (!job || job.started) continue;
    job.started = true;
    roadActive += 1;
    runRoadJob(job);
  }
}

/**
 * @param {Object} job the queued job
 */
function runRoadJob(job) {
  const ctrl = new AbortController();
  job.ctrl = ctrl;
  fetchRoad(job.a, job.b, job.mode, { signal: ctrl.signal }).then(function (road) {
    finishRoadJob(job, road, null);
  }, function (err) {
    finishRoadJob(job, null, err);
  });
}

/** A rebuild is waiting on a microtask. */
let roadRebuildQueued = false;
/** The exporter owns the tile cache: no rebuild, no preview render. */
let exportHoldsTiles = false;
/** A road landed while the exporter held the cache. */
let roadRebuildHeld = false;

/**
 * Rebuild once for a burst of roads. Two fetches settling in the same task
 * used to cost two full rebuilds and two preview renders; the seek position
 * is unaffected, since rebuildTimeline rescales t proportionally either way.
 */
function rebuildTimelineSoon() {
  if (roadRebuildQueued) return;
  roadRebuildQueued = true;
  queueMicrotask(flushRoadRebuild);
}

/** Apply a queued rebuild now, unless the exporter is holding the cache. */
function flushRoadRebuild() {
  if (!roadRebuildQueued) return;
  roadRebuildQueued = false;
  if (exportHoldsTiles) { roadRebuildHeld = true; return; }
  rebuildTimeline();
}

/**
 * Give the preview back its cache once the export session is over, and show
 * whatever landed while it was running.
 */
function releaseRoadHold() {
  exportHoldsTiles = false;
  if (!roadRebuildHeld) return;
  roadRebuildHeld = false;
  rebuildTimeline();
  refreshLegs();
}

/**
 * @param {Object} job the job that settled
 * @param {Object|null} road the geometry, when it arrived
 * @param {*} err whatever went wrong otherwise
 */
function finishRoadJob(job, road, err) {
  if (job.started) roadActive -= 1;
  // A job that was cancelled has already left the map.
  if (roadJobs.get(job.key) === job) roadJobs.delete(job.key);
  job.settle();

  if (road) {
    // The router is answering again, so the breaker starts over.
    roadPauseUntil = 0;
    roadBackoff = ROAD_BACKOFF_MIN;
    roadFailed.delete(job.key);
    // Cache first: the answer is good even if this trip has moved on.
    try { storeRoad(job.key, road); } catch (cacheErr) { /* cache is a bonus */ }
    // Stale guard: the leg may be gone, or the user may have picked stylized.
    if (state.routeStyle === 'roads' && wantedRoads().has(job.key)) {
      // Synchronous, so an export awaiting this job sees the road applied.
      state.roads[job.key] = road;
      rebuildTimelineSoon();
    }
  } else if (!err || err.name !== 'AbortError') {
    // Anything that is not a cancellation counts as a miss: offline, router
    // error, timeout, absurd detour, leg over the length cap. One further
    // attempt after a wait, then the leg keeps its arc for the session.
    const now = Date.now();
    const seen = roadFailed.get(job.key);
    const tries = (seen ? seen.tries : 0) + 1;
    roadFailed.set(job.key, {
      tries: tries,
      retryAt: tries < ROAD_MAX_TRIES ? now + ROAD_RETRY_MS : Infinity
    });
    if (tries < ROAD_MAX_TRIES) scheduleRoadWake(now + ROAD_RETRY_MS);
    // A busy or broken router pauses every key, not just this one.
    const code = err && typeof err.message === 'string' ? err.message : '';
    if (code === 'http-429' || /^http-5\d\d$/.test(code)) {
      roadPauseUntil = now + roadBackoff;
      roadBackoff = Math.min(roadBackoff * 2, ROAD_BACKOFF_MAX);
    }
  }

  refreshLegs();
  pumpRoads();
}

/**
 * @param {Object} job the job to drop
 */
function cancelRoadJob(job) {
  if (roadJobs.get(job.key) === job) roadJobs.delete(job.key);
  if (job.ctrl) job.ctrl.abort();
  else job.settle();
}

/**
 * Bring the router in line with the current stops, modes and route style.
 * Cheap and idempotent: safe to call after every project change.
 */
function syncRoads() {
  const wanted = wantedRoads();

  // Drop work nobody is waiting for any more.
  const stale = [];
  roadJobs.forEach(function (job, key) { if (!wanted.has(key)) stale.push(job); });
  for (let i = 0; i < stale.length; i++) cancelRoadJob(stale[i]);

  // Keep the map in step with the trip. The routes.js cache still holds the
  // rest, so a removed stop that comes back is instant.
  const held = Object.keys(state.roads);
  for (let i = 0; i < held.length; i++) {
    if (!wanted.has(held[i])) delete state.roads[held[i]];
  }

  const now = Date.now();
  wanted.forEach(function (leg, key) {
    if (state.roads[key]) return;
    const hit = cachedRoad(leg.a, leg.b, leg.mode);
    if (hit) { state.roads[key] = hit; return; }
    if (roadJobs.has(key)) return;
    if (roadBlocked(key, now)) {
      // Still cooling off. Come back for it when the wait is over.
      const miss = roadFailed.get(key);
      if (miss) scheduleRoadWake(miss.retryAt);
      return;
    }

    let settle = null;
    const done = new Promise(function (resolve) { settle = resolve; });
    roadJobs.set(key, {
      key: key, a: leg.a, b: leg.b, mode: leg.mode,
      ctrl: null, started: false, done: done, settle: settle
    });
    roadQueue.push(key);
  });

  pumpRoads();
}

/**
 * Let the roads that are already on the wire land before an export starts.
 * Whatever has not arrived by the cap stays an arc, which is exactly what the
 * preview was showing anyway.
 * @returns {Promise<void>}
 */
function awaitPendingRoads() {
  // While the breaker is open a queued job cannot start, so waiting on it
  // would spend the whole cap for nothing.
  const paused = Date.now() < roadPauseUntil;
  const waits = [];
  roadJobs.forEach(function (job) {
    if (paused && !job.started) return;
    waits.push(job.done);
  });
  if (!waits.length) return Promise.resolve();
  return Promise.race([
    Promise.allSettled(waits),
    new Promise(function (resolve) { setTimeout(resolve, ROAD_EXPORT_WAIT); })
  ]).then(function () { /* value ignored, we proceed either way */ });
}

/* ------------------------------------------------------------------ *
 * live region: toasts and announcements
 * ------------------------------------------------------------------ */

/**
 * Show a transient message. With an action the toast lingers so the button
 * is actually reachable.
 * @param {string} message toast text
 * @param {{ label: string, onAction: Function }} [action] optional button
 */
function toast(message, action) {
  const el = make('div', 'toast');
  el.appendChild(make('span', null, message));
  let timer = 0;
  let gone = false;

  function dismiss() {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    el.classList.remove('is-show');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  }

  /** Restart the countdown once the toast is no longer being attended to. */
  function rearm() {
    if (gone) return;
    clearTimeout(timer);
    timer = setTimeout(dismiss, 8000);
  }

  if (action) {
    const btn = make('button', 'toast-act', action.label);
    btn.type = 'button';
    btn.addEventListener('click', function () {
      dismiss();
      action.onAction();
    });
    el.appendChild(btn);
    // A toast that carries an action must not time out under the pointer or
    // under keyboard focus: the action has to stay reachable.
    el.addEventListener('pointerenter', function () { clearTimeout(timer); });
    el.addEventListener('focusin', function () { clearTimeout(timer); });
    el.addEventListener('pointerleave', rearm);
    el.addEventListener('focusout', rearm);
  }

  dom.live.appendChild(el);
  requestAnimationFrame(function () { el.classList.add('is-show'); });
  timer = setTimeout(dismiss, action ? 8000 : 3500);
}

/**
 * Speak a status line without showing anything.
 * @param {string} message announcement text
 */
function announce(message) {
  const el = make('span', 'vh', message);
  dom.live.appendChild(el);
  setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1500);
}

/* ------------------------------------------------------------------ *
 * persistence
 * ------------------------------------------------------------------ */

/** Drop remembered legs whose stops are no longer in the trip. */
function pruneModeMemory() {
  const live = new Set();
  for (let i = 0; i < state.stops.length; i++) live.add(state.stops[i].id);
  const dead = [];
  modeMemory.forEach(function (mode, key) {
    const at = key.indexOf('|');
    if (at < 0 || !live.has(key.slice(0, at)) || !live.has(key.slice(at + 1))) dead.push(key);
  });
  for (let i = 0; i < dead.length; i++) modeMemory.delete(dead[i]);
}

const saveDraft = debounce(function () {
  try {
    pruneModeMemory();
    const pairs = [];
    modeMemory.forEach(function (mode, key) { pairs.push([key, mode]); });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: 1,
      title: state.title,
      stops: state.stops,
      modes: state.modes,
      themeId: state.themeId,
      format: state.format,
      speed: state.speed,
      routeStyle: state.routeStyle,
      pairs: pairs
    }));
  } catch (err) {
    /* storage full or blocked: the draft is a convenience, not a promise */
  }
}, 400);

/**
 * @param {number} lat latitude in degrees
 * @param {number} lng longitude in degrees
 * @returns {boolean} true when the pair is inside the drawable world
 */
function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -85 && lat <= 85;
}

/**
 * Fold any longitude into [-180, 180) so a hand-edited draft cannot push the
 * camera off the world.
 * @param {number} lng longitude in degrees
 * @returns {number}
 */
function normLng(lng) {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * @param {*} s candidate stop
 * @returns {boolean}
 */
function validStop(s) {
  return !!s && typeof s.id === 'string' && typeof s.name === 'string'
    && s.name.trim().length > 0 && validCoords(s.lat, s.lng);
}

/**
 * Read the saved draft and fold it into state. Corrupt drafts are ignored.
 * @returns {boolean} true when a draft with a playable route was restored
 */
function restoreDraft() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (err) { return false; }
  if (!raw) return false;

  let data = null;
  try { data = JSON.parse(raw); } catch (err) { return false; }
  if (!data || typeof data !== 'object' || !Array.isArray(data.stops)) return false;

  const stops = [];
  for (let i = 0; i < data.stops.length && stops.length < MAX_STOPS; i++) {
    const s = data.stops[i];
    if (!validStop(s)) continue;
    const name = s.name.trim().slice(0, MAX_NAME);
    const label = typeof s.label === 'string' && s.label.trim()
      ? s.label.trim().slice(0, MAX_LABEL)
      : name.slice(0, MAX_LABEL);
    stops.push({
      id: s.id,
      name: name,
      label: label,
      lat: s.lat,
      lng: normLng(s.lng),
      region: typeof s.region === 'string' ? s.region : '',
      country: typeof s.country === 'string' ? s.country : '',
      source: s.source === 'catalogue' ? 'catalogue' : 'photon',
      tagline: typeof s.tagline === 'string' ? s.tagline : ''
    });
  }
  if (!stops.length) return false;

  state.stops = stops;
  state.title = typeof data.title === 'string' ? data.title.slice(0, 48) : '';
  state.themeId = Object.prototype.hasOwnProperty.call(THEMES, data.themeId) ? data.themeId : DEFAULT_THEME;
  state.format = Object.prototype.hasOwnProperty.call(FORMATS, data.format) ? data.format : '9x16';
  state.speed = SPEEDS.indexOf(data.speed) !== -1 ? data.speed : 'normal';
  // Drafts written before roads existed simply get the default.
  state.routeStyle = ROUTE_STYLES.indexOf(data.routeStyle) !== -1 ? data.routeStyle : 'roads';

  const modeIds = MODE_META.map(function (m) { return m.id; });
  const liveIds = new Set();
  for (let i = 0; i < stops.length; i++) liveIds.add(stops[i].id);
  if (Array.isArray(data.pairs)) {
    for (let i = 0; i < data.pairs.length; i++) {
      const pair = data.pairs[i];
      if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
      if (modeIds.indexOf(pair[1]) === -1) continue;
      // Pairs for stops that did not survive the restore are dead weight.
      const at = pair[0].indexOf('|');
      if (at < 0 || !liveIds.has(pair[0].slice(0, at)) || !liveIds.has(pair[0].slice(at + 1))) continue;
      modeMemory.set(pair[0], pair[1]);
    }
  }
  if (Array.isArray(data.modes) && data.modes.length === stops.length - 1) {
    for (let i = 0; i < data.modes.length; i++) {
      if (modeIds.indexOf(data.modes[i]) === -1) continue;
      modeMemory.set(stops[i].id + '|' + stops[i + 1].id, data.modes[i]);
    }
  }

  // Keep new ids clear of restored ones.
  for (let i = 0; i < stops.length; i++) {
    const n = parseInt(String(stops[i].id).replace(/^s/, ''), 10);
    if (Number.isFinite(n) && n > stopSeq) stopSeq = n;
  }

  recomputeModes();
  return stops.length >= 2;
}

/** Wipe the saved draft and start from an empty project. */
function startFresh() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* nothing to clear */ }
  state.title = '';
  state.stops = [];
  state.modes = [];
  state.themeId = DEFAULT_THEME;
  state.format = '9x16';
  state.speed = 'normal';
  state.routeStyle = 'roads';
  state.roads = {};
  modeMemory.clear();
  dom.title.value = '';
  syncRadio(dom.formatSeg, state.format);
  syncRadio(dom.speedSeg, state.speed);
  syncRadio(dom.styleRow, state.themeId);
  if (dom.routeSeg) syncRadio(dom.routeSeg, state.routeStyle);
  commit();
  announce('Draft cleared');
}

/* ------------------------------------------------------------------ *
 * hand-off from the map
 *
 * The map links here with ?stops=lat,lng,label|... One bad part drops the
 * whole parameter, so a mangled link quietly falls through to the draft
 * instead of loading half a trip.
 * ------------------------------------------------------------------ */

/**
 * Pull one parameter out of a query string without decoding it: the labels
 * carry their own percent-encoding and must survive until the split is done.
 * @param {string} search location.search
 * @param {string} name parameter name
 * @returns {string} the raw value, empty when absent
 */
function rawParam(search, name) {
  const parts = search.replace(/^\?/, '').split('&');
  for (let i = 0; i < parts.length; i++) {
    const at = parts[i].indexOf('=');
    if (at > 0 && parts[i].slice(0, at) === name) return parts[i].slice(at + 1);
  }
  return '';
}

/**
 * @param {string} raw the stops parameter, still encoded
 * @returns {Array<Object>|null} seed places, or null when the link is unusable
 */
function parseSeed(raw) {
  if (!raw) return null;
  // Some browsers hand back the separator percent-encoded, so accept both.
  // Latent edge accepted: a label containing a literal pipe would arrive as
  // %7C and mis-split, dropping the whole seed to the draft fallback. No
  // catalogue or geocoder name carries one.
  const parts = raw.split(/\||%7C/i);
  if (parts.length < 2 || parts.length > MAX_STOPS) return null;

  const seed = [];
  for (let i = 0; i < parts.length; i++) {
    // Only the first two commas delimit: the label keeps its own, encoded.
    const first = parts[i].indexOf(',');
    if (first < 0) return null;
    const second = parts[i].indexOf(',', first + 1);
    if (second < 0) return null;
    const latText = parts[i].slice(0, first).trim();
    const lngText = parts[i].slice(first + 1, second).trim();
    if (!latText || !lngText) return null;
    const lat = Number(latText);
    const lng = Number(lngText);
    if (!validCoords(lat, lng)) return null;

    let label = '';
    try { label = decodeURIComponent(parts[i].slice(second + 1)); } catch (err) { return null; }
    label = label.trim().slice(0, MAX_LABEL);
    if (!label) return null;
    seed.push({ label: label, lat: lat, lng: normLng(lng) });
  }
  return seed;
}


/**
 * Set the saved draft aside when a map link is about to write over real work.
 * @param {Array<Object>} seed the trip about to be loaded
 * @returns {boolean} true when a draft was moved to the previous slot
 */
function stashDraft(seed) {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (err) { return false; }
  if (!raw) return false;

  let data = null;
  try { data = JSON.parse(raw); } catch (err) { return false; }
  if (!data || typeof data !== 'object' || !Array.isArray(data.stops)) return false;

  const kept = data.stops.filter(validStop);
  // Anything shorter than a route is not worth keeping. The same trip IS:
  // seeding resets title, theme, format, speed and leg modes, so re-tapping
  // the map link must still leave the customized draft one toast tap away.
  if (kept.length < 2) return false;

  try { localStorage.setItem(PREV_KEY, raw); } catch (err) { return false; }
  return true;
}

/**
 * Replace the project with the trip from the link. Modes come from the same
 * distance rule a hand-built trip gets, and the roads follow from commit().
 * @param {Array<Object>} seed seed places
 */
function applySeed(seed) {
  state.stops = seed.map(function (s) {
    return {
      id: nextId(), name: s.label, label: s.label, lat: s.lat, lng: s.lng,
      region: '', country: '', source: 'photon', tagline: ''
    };
  });
  state.routeStyle = 'roads';
  recomputeModes();
}

/** Put the draft the map link displaced back in place of the seeded trip. */
function restorePrevious() {
  let raw = null;
  try { raw = localStorage.getItem(PREV_KEY); } catch (err) { return; }
  if (!raw) return;
  let swapped = false;
  try {
    localStorage.setItem(STORAGE_KEY, raw);
    localStorage.removeItem(PREV_KEY);
    swapped = true;
  } catch (err) { /* storage closed on us between the stash and the click */ }
  // Without the swap the reader below would only find the seeded trip again.
  if (!swapped) {
    toast('That draft could not be restored');
    return;
  }

  state.stops = [];
  state.modes = [];
  state.roads = {};
  modeMemory.clear();
  restoreDraft();
  dom.title.value = state.title;
  syncRadio(dom.formatSeg, state.format);
  syncRadio(dom.speedSeg, state.speed);
  syncRadio(dom.styleRow, state.themeId);
  if (dom.routeSeg) syncRadio(dom.routeSeg, state.routeStyle);
  commit();
  announce('Previous draft restored');
}

/** Drop the seed parameter so a refresh keeps the user's edits. */
function stripSeedQuery() {
  if (!location.search) return;
  try {
    history.replaceState(null, '', location.pathname + location.hash);
  } catch (err) { /* nothing important rides on the address bar */ }
}

/* ------------------------------------------------------------------ *
 * project mutations
 * ------------------------------------------------------------------ */

/**
 * Re-render everything that depends on the project and persist it.
 * @param {{ skipList?: boolean }} [opts] skipList keeps an open inline editor
 */
function commit(opts) {
  // Roads first: a cache hit lands before the list is drawn, so the leg shows
  // its driving distance immediately instead of flickering through the arc one.
  syncRoads();
  if (!opts || !opts.skipList) renderStops();
  else refreshLegs();
  rebuildTimeline();
  syncExportButtons();
  saveDraft();
}

/**
 * Add a stop from the search popover.
 * @param {Object} partial a partial Stop from search.js
 */
function addStop(partial) {
  if (state.stops.length >= MAX_STOPS) {
    toast('Twelve stops is the max for one reel');
    return;
  }
  if (!partial || typeof partial.name !== 'string' || !validCoords(partial.lat, partial.lng)) {
    toast('That place has no usable location');
    return;
  }
  const last = state.stops[state.stops.length - 1];
  if (last && last.name.toLowerCase() === partial.name.toLowerCase()
    && Math.abs(last.lat - partial.lat) < SAME_PLACE_DEG
    && Math.abs(last.lng - partial.lng) < SAME_PLACE_DEG) {
    toast('That is already the previous stop');
    return;
  }

  const name = partial.name.trim().slice(0, MAX_NAME);
  state.stops.push({
    id: nextId(),
    name: name,
    label: name.slice(0, MAX_LABEL),
    lat: partial.lat,
    lng: normLng(partial.lng),
    region: partial.region || '',
    country: partial.country || '',
    source: partial.source === 'catalogue' ? 'catalogue' : 'photon',
    tagline: partial.tagline || ''
  });
  recomputeModes();
  commit();
  announce('Added ' + name + ', stop ' + state.stops.length);
}

/**
 * @param {number} index position to drop
 */
function removeStop(index) {
  const stop = state.stops[index];
  if (!stop) return;
  state.stops.splice(index, 1);
  modeMemory.forEach(function (mode, key) {
    if (key.startsWith(stop.id + '|') || key.endsWith('|' + stop.id)) modeMemory.delete(key);
  });
  recomputeModes();
  // The next row's remove button, or the previous one when the last row went.
  // With nothing left there is no row to hold focus, so go back to the search.
  focusAfterRender = state.stops.length
    ? { index: Math.min(index, state.stops.length - 1), selector: '.row-remove' }
    : { search: true };
  commit();
  announce('Removed ' + stop.label);
}

/**
 * @param {number} from current index
 * @param {number} to target index
 * @param {string} [focusSelector] control to refocus in the moved row
 */
function moveStop(from, to, focusSelector) {
  if (to < 0 || to >= state.stops.length || from === to) return;
  const moved = state.stops.splice(from, 1)[0];
  state.stops.splice(to, 0, moved);
  recomputeModes();
  if (focusSelector) focusAfterRender = { index: to, selector: focusSelector };
  commit();
  announce(moved.label + ' is now stop ' + (to + 1));
}

/**
 * @param {number} legIndex leg between stop i and i+1
 * @param {string} mode one of MODE_META ids
 */
function setMode(legIndex, mode) {
  const a = state.stops[legIndex];
  const b = state.stops[legIndex + 1];
  if (!a || !b) return;
  modeMemory.set(a.id + '|' + b.id, mode);
  state.modes[legIndex] = mode;
  // The list re-renders, so hand focus back to the button that was just used.
  focusAfterRender = { index: legIndex, selector: '.mode-btn[data-mode="' + mode + '"]' };
  commit();
}

/**
 * @param {number} index stop position
 * @param {string} label new label
 * @param {boolean} [focusRow] hand focus back to the row after the re-render
 * @returns {boolean} true when the label actually changed
 */
function setLabel(index, label, focusRow) {
  const stop = state.stops[index];
  if (!stop) return false;
  const next = label.trim().slice(0, MAX_LABEL);
  if (!next || next === stop.label) return false;
  stop.label = next;
  // Only the keyboard paths ask for the row back. A pointer commit must let
  // the click the user is making land where they aimed it.
  if (focusRow) focusAfterRender = { index: index, selector: '.stop-label-row' };
  commit();
  return true;
}

/** Replace the project with the Golden Triangle sample. */
function loadSample() {
  state.stops = SAMPLE.stops.map(function (s) {
    return {
      id: nextId(), name: s.name, label: s.name, lat: s.lat, lng: s.lng,
      region: s.region, country: s.country, source: s.source, tagline: s.tagline
    };
  });
  for (let i = 0; i < SAMPLE.modes.length; i++) {
    modeMemory.set(state.stops[i].id + '|' + state.stops[i + 1].id, SAMPLE.modes[i]);
  }
  state.title = SAMPLE.title;
  dom.title.value = SAMPLE.title;
  state.themeId = SAMPLE.themeId;
  syncRadio(dom.styleRow, state.themeId);
  recomputeModes();
  commit();
  announce('Sample trip loaded, 3 stops');
}

/* ------------------------------------------------------------------ *
 * stops builder rendering
 * ------------------------------------------------------------------ */

/**
 * The metadata line under a stop name. Its distance follows the same source
 * as the leg connector above it, so the two never disagree.
 * @param {Object} stop the stop
 * @param {number} index its position
 * @returns {string}
 */
function stopSubText(stop, index) {
  const bits = [];
  const place = [stop.region, stop.country].filter(Boolean).join(', ');
  if (place) bits.push(place);
  if (index > 0) bits.push(fmtKm(legKmShown(index - 1)) + ' from previous');
  return bits.join(' · ');
}

/**
 * @param {Object} stop the stop
 * @param {number} index its position
 * @returns {HTMLElement} the row element
 */
function buildStopRow(stop, index) {
  const row = make('div', 'stop-row');

  const num = make('div', 'stop-num', String(index + 1));
  num.title = 'Drag to reorder';
  num.addEventListener('pointerdown', onDragStart);
  row.appendChild(num);

  const main = make('div', 'stop-main');

  const labelBtn = make('button', 'stop-label-row');
  labelBtn.type = 'button';
  labelBtn.setAttribute('aria-label', 'Rename ' + stop.label);
  labelBtn.appendChild(make('span', 'stop-label', stop.label));
  const pencil = icon(ICONS.pencil, { cls: 'ic' });
  const pencilWrap = make('span', 'stop-edit');
  pencilWrap.appendChild(pencil);
  labelBtn.appendChild(pencilWrap);
  labelBtn.addEventListener('click', function () { startEdit(index); });
  main.appendChild(labelBtn);

  main.appendChild(make('div', 'stop-sub', stopSubText(stop, index)));
  row.appendChild(main);

  const acts = make('div', 'stop-acts');

  const up = make('button', 'row-btn row-up');
  up.type = 'button';
  up.setAttribute('aria-label', 'Move ' + stop.label + ' up');
  up.appendChild(icon(ICONS.up));
  up.disabled = index === 0;
  up.addEventListener('click', function () { moveStop(index, index - 1, '.row-up'); });
  acts.appendChild(up);

  const down = make('button', 'row-btn row-down');
  down.type = 'button';
  down.setAttribute('aria-label', 'Move ' + stop.label + ' down');
  down.appendChild(icon(ICONS.down));
  down.disabled = index === state.stops.length - 1;
  down.addEventListener('click', function () { moveStop(index, index + 1, '.row-down'); });
  acts.appendChild(down);

  const rm = make('button', 'row-btn row-remove');
  rm.type = 'button';
  rm.setAttribute('aria-label', 'Remove ' + stop.label);
  rm.appendChild(icon(ICONS.close));
  rm.addEventListener('click', function () { removeStop(index); });
  acts.appendChild(rm);

  row.appendChild(acts);
  return row;
}

/**
 * @param {number} legIndex leg between stop legIndex and legIndex + 1
 * @returns {HTMLElement}
 */
function buildLegRow(legIndex) {
  const leg = make('div', 'leg');
  const a = state.stops[legIndex];
  const b = state.stops[legIndex + 1];

  const group = make('div', 'leg-modes');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Travel mode from ' + a.label + ' to ' + b.label);

  for (let i = 0; i < MODE_META.length; i++) {
    const meta = MODE_META[i];
    const btn = make('button', 'mode-btn');
    btn.type = 'button';
    btn.setAttribute('aria-label', meta.label);
    btn.setAttribute('aria-pressed', state.modes[legIndex] === meta.id ? 'true' : 'false');
    btn.dataset.mode = meta.id;
    btn.appendChild(icon([meta.d], { filled: true, cls: 'mode-ic' }));
    btn.addEventListener('click', function () { setMode(legIndex, meta.id); });
    group.appendChild(btn);
  }
  leg.appendChild(group);
  leg.appendChild(make('span', 'leg-km'));
  paintLeg(leg, legIndex);
  return leg;
}

/**
 * Put the distance, the in flight spinner and the fallback hint on one leg
 * connector. Kept separate from the row build so a road that lands mid edit
 * updates the number without rebuilding the list under the user.
 * @param {HTMLElement} leg the connector element
 * @param {number} legIndex leg between stop legIndex and legIndex + 1
 */
function paintLeg(leg, legIndex) {
  const km = leg.querySelector('.leg-km');
  if (!km) return;
  const status = roadStateForLeg(legIndex);

  km.textContent = fmtKm(legKmShown(legIndex));
  if (status === 'failed') km.title = ROAD_FALLBACK_TITLE;
  else km.removeAttribute('title');

  let spin = leg.querySelector('.leg-spin');
  if (status === 'pending') {
    if (!spin) {
      spin = make('span', 'leg-spin');
      spin.setAttribute('aria-hidden', 'true');
      leg.appendChild(spin);
    }
  } else if (spin && spin.parentNode) {
    spin.parentNode.removeChild(spin);
  }
}

/**
 * Refresh every leg connector and the distances that follow from it, in
 * place. No focus moves, no open inline editor closes.
 */
function refreshLegs() {
  const items = dom.stopList.children;
  for (let i = 0; i < items.length; i++) {
    const leg = items[i].querySelector('.leg');
    if (leg) paintLeg(leg, i);
    const sub = items[i].querySelector('.stop-sub');
    if (sub && state.stops[i]) sub.textContent = stopSubText(state.stops[i], i);
  }
}

/**
 * Put focus somewhere sensible after the list was rebuilt under the user.
 * The wanted control may have gone or become disabled (a row that reached an
 * end, a row that was removed), and dropping focus on the body would strand a
 * keyboard user.
 * @param {{ index?: number, selector?: string, search?: boolean }} want what was asked for
 */
function applyFocusAfterRender(want) {
  if (want.search) { dom.search.focus(); return; }

  const item = dom.stopList.children[want.index];
  const usable = function (el) { return !!el && !el.disabled && !el.hidden; };

  if (item) {
    const target = item.querySelector(want.selector);
    if (usable(target)) { target.focus(); return; }
    // A reorder button only goes away by hitting an end: the opposite one is
    // the closest thing to where the user was.
    let opposite = null;
    if (want.selector === '.row-up') opposite = item.querySelector('.row-down');
    else if (want.selector === '.row-down') opposite = item.querySelector('.row-up');
    if (usable(opposite)) { opposite.focus(); return; }
    const rename = item.querySelector('.stop-label-row');
    if (usable(rename)) { rename.focus(); return; }
    const remove = item.querySelector('.row-remove');
    if (usable(remove)) { remove.focus(); return; }
  }
  dom.search.focus();
}

/** Rebuild the whole stop list. Cheap at 12 rows and keeps indexes honest. */
function renderStops() {
  dom.stopList.textContent = '';
  for (let i = 0; i < state.stops.length; i++) {
    const li = make('li', 'stop-item');
    li.dataset.index = String(i);
    li.appendChild(buildStopRow(state.stops[i], i));
    if (i < state.stops.length - 1) li.appendChild(buildLegRow(i));
    dom.stopList.appendChild(li);
  }
  dom.stopsEmpty.hidden = state.stops.length > 0;
  syncStartOver();

  if (focusAfterRender) {
    const want = focusAfterRender;
    focusAfterRender = null;
    applyFocusAfterRender(want);
  }
}

/* ------------------------------------------------------------------ *
 * start over (persistent twin of the restore toast's action)
 * ------------------------------------------------------------------ */

let startOverBtn = null;
let startOverArmed = false;
let startOverTimer = 0;

/** Put a small text button next to the "Your stops" heading. */
function buildStartOver() {
  const head = document.getElementById('stopsHead');
  if (!head || !head.parentNode) return;

  const row = make('div', 'card-head-row');
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.justifyContent = 'space-between';
  row.style.gap = '10px';
  head.parentNode.insertBefore(row, head);
  row.appendChild(head);

  const btn = make('button', 'start-over', 'Start over');
  btn.type = 'button';
  btn.style.fontSize = '12.5px';
  btn.style.fontWeight = '600';
  btn.style.color = 'var(--muted)';
  btn.style.borderRadius = '10px';
  btn.style.flex = '0 0 auto';
  // Visual size stays small, the tappable box is 44 px tall.
  btn.style.padding = '13px 10px';
  btn.style.margin = '-13px -10px';
  btn.hidden = true;
  btn.addEventListener('click', onStartOver);
  row.appendChild(btn);
  startOverBtn = btn;
}

/** Back to the resting label. */
function disarmStartOver() {
  clearTimeout(startOverTimer);
  startOverTimer = 0;
  startOverArmed = false;
  if (!startOverBtn) return;
  startOverBtn.textContent = 'Start over';
  startOverBtn.style.color = 'var(--muted)';
}

/** First press asks, second press clears. The question expires on its own. */
function onStartOver() {
  if (!startOverBtn) return;
  if (startOverArmed) {
    disarmStartOver();
    startFresh();
    dom.search.focus();
    return;
  }
  startOverArmed = true;
  startOverBtn.textContent = 'Really clear?';
  startOverBtn.style.color = 'var(--ink)';
  announce('Press again to clear this trip');
  clearTimeout(startOverTimer);
  startOverTimer = setTimeout(disarmStartOver, 4000);
}

/** The control only makes sense while there is something to clear. */
function syncStartOver() {
  if (!startOverBtn) return;
  const show = state.stops.length > 0;
  if (!show && startOverArmed) disarmStartOver();
  startOverBtn.hidden = !show;
}

/**
 * Swap a label for an inline text input.
 * @param {number} index stop position
 */
function startEdit(index) {
  const item = dom.stopList.children[index];
  if (!item) return;
  const btn = item.querySelector('.stop-label-row');
  if (!btn || btn.hidden) return;

  const stop = state.stops[index];
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'stop-input';
  input.value = stop.label;
  input.maxLength = MAX_LABEL;
  input.setAttribute('aria-label', 'Stop name');
  btn.hidden = true;
  btn.parentNode.insertBefore(input, btn);

  let done = false;

  /**
   * @param {boolean} save commit the typed value, or revert
   * @param {boolean} fromKey Enter or Escape, so focus belongs back on the row
   */
  function finish(save, fromKey) {
    if (done) return;
    done = true;
    const value = input.value;
    input.removeEventListener('blur', onBlur);
    document.removeEventListener('pointerdown', onOutside, true);
    if (input.parentNode) input.parentNode.removeChild(input);
    btn.hidden = false;
    const changed = save ? setLabel(index, value, fromKey) : false;
    if (!changed && fromKey) btn.focus();
  }

  function onBlur() { finish(true, false); }

  /**
   * Commit on the way down, not on blur: the list is rebuilt before the click
   * is hit-tested, so the control the user pressed still receives it.
   * @param {PointerEvent} ev pointerdown anywhere on the page
   */
  function onOutside(ev) {
    if (ev.target === input || (input.contains && input.contains(ev.target))) return;
    finish(true, false);
  }

  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true, true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false, true); }
  });
  input.addEventListener('blur', onBlur);
  document.addEventListener('pointerdown', onOutside, true);

  input.focus();
  input.select();
}

/* ------------------------------------------------------------------ *
 * pointer drag reorder (enhancement; the buttons stay the a11y path)
 * ------------------------------------------------------------------ */

let drag = null;

/**
 * @param {PointerEvent} ev pointerdown on a number badge
 */
function onDragStart(ev) {
  if (ev.button !== 0 && ev.pointerType === 'mouse') return;
  if (state.stops.length < 2) return;
  // One drag at a time. A second finger must not overwrite the first one's
  // state, which every handler below reads from this single object.
  if (drag) return;
  const handle = ev.currentTarget;
  const item = handle.closest('.stop-item');
  if (!item) return;

  const items = Array.from(dom.stopList.children);
  drag = {
    handle: handle,
    item: item,
    index: items.indexOf(item),
    startY: ev.clientY,
    rects: items.map(function (el) { return el.getBoundingClientRect(); }),
    listTop: dom.stopList.getBoundingClientRect().top,
    line: null,
    insertAt: items.indexOf(item),
    active: false,
    pointerId: ev.pointerId
  };

  try { handle.setPointerCapture(ev.pointerId); } catch (err) { /* older engines */ }
  handle.addEventListener('pointermove', onDragMove);
  handle.addEventListener('pointerup', onDragEnd);
  handle.addEventListener('pointercancel', onDragCancel);
}

/**
 * @param {PointerEvent} ev pointermove while dragging
 */
function onDragMove(ev) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const dy = ev.clientY - drag.startY;
  if (!drag.active) {
    if (Math.abs(dy) < 4) return;
    drag.active = true;
    drag.item.classList.add('is-dragging');
    drag.line = make('div', 'drop-line');
    dom.stopList.appendChild(drag.line);
  }
  ev.preventDefault();
  drag.item.style.transform = 'translateY(' + dy + 'px)';

  let insertAt = drag.rects.length;
  for (let i = 0; i < drag.rects.length; i++) {
    const r = drag.rects[i];
    if (ev.clientY < r.top + r.height / 2) { insertAt = i; break; }
  }
  drag.insertAt = insertAt;

  const edge = insertAt < drag.rects.length
    ? drag.rects[insertAt].top
    : drag.rects[drag.rects.length - 1].bottom;
  drag.line.style.top = (edge - drag.listTop - 1) + 'px';
}

/** Undo the visual drag state. */
function cleanupDrag() {
  if (!drag) return;
  drag.handle.removeEventListener('pointermove', onDragMove);
  drag.handle.removeEventListener('pointerup', onDragEnd);
  drag.handle.removeEventListener('pointercancel', onDragCancel);
  try { drag.handle.releasePointerCapture(drag.pointerId); } catch (err) { /* already gone */ }
  drag.item.classList.remove('is-dragging');
  drag.item.style.transform = '';
  if (drag.line && drag.line.parentNode) drag.line.parentNode.removeChild(drag.line);
  const result = drag;
  drag = null;
  return result;
}

/**
 * @param {PointerEvent} ev pointerup
 */
function onDragEnd(ev) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const wasActive = drag.active;
  const from = drag.index;
  const insertAt = drag.insertAt;
  cleanupDrag();
  if (!wasActive) return;
  const to = insertAt > from ? insertAt - 1 : insertAt;
  if (to !== from) moveStop(from, to);
}

/**
 * Pointer cancelled: leave the order alone.
 * @param {PointerEvent} ev pointercancel
 */
function onDragCancel(ev) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  cleanupDrag();
}

/* ------------------------------------------------------------------ *
 * radio groups (style, format, speed)
 * ------------------------------------------------------------------ */

/**
 * Roving tabindex plus arrow keys for a role="radiogroup".
 * @param {HTMLElement} container the group
 * @param {(value: string) => void} onChange fires with the picked value
 */
function wireRadioGroup(container, onChange) {
  container.addEventListener('click', function (ev) {
    const btn = ev.target.closest('[role="radio"]');
    if (!btn || !container.contains(btn)) return;
    const value = btn.dataset.value;
    if (!value) return;
    syncRadio(container, value);
    onChange(value);
  });

  container.addEventListener('keydown', function (ev) {
    const items = Array.from(container.querySelectorAll('[role="radio"]'));
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    let next = -1;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = items.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    items[next].focus();
    items[next].click();
  });
}

/**
 * @param {HTMLElement} container the group
 * @param {string} value the selected value
 */
function syncRadio(container, value) {
  const items = container.querySelectorAll('[role="radio"]');
  for (let i = 0; i < items.length; i++) {
    const on = items[i].dataset.value === value;
    items[i].setAttribute('aria-checked', on ? 'true' : 'false');
    items[i].tabIndex = on ? 0 : -1;
  }
}

/** Put the engine's own format names on the segmented control. */
function renderFormatLabels() {
  const items = dom.formatSeg.querySelectorAll('[role="radio"]');
  for (let i = 0; i < items.length; i++) {
    const slot = items[i].querySelector('[data-fmt-label]');
    const spec = FORMATS[items[i].dataset.value];
    if (slot && spec && spec.label) slot.textContent = spec.label;
  }
}

/**
 * Add the Route shape control under Speed. Built here rather than in the
 * markup so the page keeps working if this script never loads.
 */
function buildRouteShape() {
  const speedField = dom.speedSeg.closest ? dom.speedSeg.closest('.field') : null;
  if (!speedField || !speedField.parentNode) return;

  const field = make('div', 'field');
  const lbl = make('span', 'lbl', 'Route shape');
  lbl.id = 'routeShapeLbl';
  field.appendChild(lbl);

  const seg = make('div', 'seg');
  seg.id = 'routeShapeSeg';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-labelledby', 'routeShapeLbl');

  const choices = [
    { value: 'roads', label: 'Roads' },
    { value: 'arcs', label: 'Stylized' }
  ];
  for (let i = 0; i < choices.length; i++) {
    const btn = make('button', 'seg-btn');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.tabIndex = -1;
    btn.dataset.value = choices[i].value;
    btn.appendChild(make('span', null, choices[i].label));
    seg.appendChild(btn);
  }
  field.appendChild(seg);
  speedField.parentNode.insertBefore(field, speedField.nextSibling);

  dom.routeSeg = seg;
  syncRadio(seg, state.routeStyle);
  wireRadioGroup(seg, function (value) {
    if (value === state.routeStyle) return;
    state.routeStyle = value;
    // Stylized needs no network at all. Roads reuses the cache, so coming
    // back is usually instant.
    commit();
  });
}

/** Name the router in the footer, next to the map credits. */
function addRoutingCredit() {
  const lines = document.querySelectorAll('.reel-foot p');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].textContent || '';
    if (text.indexOf('Map data') !== 0) continue;
    if (text.indexOf('OSRM') !== -1) return;
    lines[i].textContent = text.replace(/\s*\.\s*$/, '') + ', routing © OSRM / FOSSGIS.';
    return;
  }
}

/** Paint the theme picker cards. */
function renderStyleCards() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const keys = Object.keys(THEMES);
  dom.styleRow.textContent = '';

  for (let i = 0; i < keys.length; i++) {
    const id = keys[i];
    const theme = THEMES[id];
    const card = make('button', 'style-card');
    card.type = 'button';
    card.setAttribute('role', 'radio');
    card.dataset.value = id;
    card.setAttribute('aria-checked', id === state.themeId ? 'true' : 'false');
    card.tabIndex = id === state.themeId ? 0 : -1;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(96 * dpr);
    canvas.height = Math.round(128 * dpr);
    canvas.style.width = '96px';
    canvas.style.height = '128px';
    const c2d = canvas.getContext('2d');
    if (c2d) {
      c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      try {
        paintSwatch(c2d, theme, 96, 128);
      } catch (err) {
        c2d.fillStyle = theme.bg || '#888';
        c2d.fillRect(0, 0, 96, 128);
      }
    }
    card.appendChild(canvas);
    card.appendChild(make('span', 'style-name', theme.name));
    dom.styleRow.appendChild(card);
  }
}

/* ------------------------------------------------------------------ *
 * preview and playback
 * ------------------------------------------------------------------ */

/** Size the canvas to the column and reapply the drawing transform. */
function layoutPreview() {
  if (!timeline) return;
  const avail = dom.previewHold.clientWidth || PREVIEW_MAX_W;
  const cssWidth = Math.max(200, Math.min(PREVIEW_MAX_W, avail - 14));
  ctx = setupPreviewCanvas(dom.canvas, timeline, cssWidth);
}

/** Draw the current frame and refresh the playback bar. */
function render() {
  if (!timeline || !ctx) return;
  renderFrame(ctx, timeline, t, tilesFor(state.themeId));
  syncPlaybar();
}

/**
 * @param {number} sec seconds
 * @returns {string} e.g. "13 seconds", for screen readers
 */
function spokenSeconds(sec) {
  const whole = Math.max(0, Math.round(sec));
  return whole + (whole === 1 ? ' second' : ' seconds');
}

/** Push t and duration into the slider and timecode. */
function syncPlaybar() {
  if (!timeline) return;
  const dur = timeline.duration;
  dom.seek.max = String(dur);
  if (document.activeElement !== dom.seek || playing) dom.seek.value = String(Math.min(t, dur));
  dom.seek.style.setProperty('--pct', String(dur > 0 ? (t / dur) * 100 : 0));
  dom.seek.setAttribute('aria-valuetext', spokenSeconds(t) + ' of ' + spokenSeconds(dur));
  dom.timecode.textContent = fmtTime(t) + ' / ' + fmtTime(dur);
}

/**
 * @param {number} now rAF timestamp
 */
function tick(now) {
  rafId = requestAnimationFrame(tick);
  if (!timeline) return;
  const dt = lastNow ? (now - lastNow) / 1000 : 0;
  lastNow = now;
  t += dt;
  if (t >= timeline.duration) t = timeline.duration > 0 ? t % timeline.duration : 0;
  render();
}

function play() {
  if (playing || !timeline) return;
  playing = true;
  lastNow = 0;
  rafId = requestAnimationFrame(tick);
  syncPlayButton();
}

function pause() {
  if (!playing) return;
  playing = false;
  cancelAnimationFrame(rafId);
  rafId = 0;
  lastNow = 0;
  syncPlayButton();
}

function syncPlayButton() {
  dom.playBtn.textContent = '';
  dom.playBtn.appendChild(icon(playing ? ICONS.pause : ICONS.play, { filled: true }));
  dom.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

/**
 * Rebuild the timeline after any project change, holding the relative
 * playhead position so the preview does not jump.
 */
function rebuildTimeline() {
  if (state.stops.length < 2) {
    pause();
    timeline = null;
    ctx = null;
    t = 0;
    dom.empty.hidden = false;
    dom.phone.hidden = true;
    dom.playBar.hidden = true;
    return;
  }

  const oldDuration = timeline ? timeline.duration : 0;
  let next = null;
  try {
    next = buildTimeline(project());
  } catch (err) {
    pause();
    timeline = null;
    ctx = null;
    dom.empty.hidden = false;
    dom.phone.hidden = true;
    dom.playBar.hidden = true;
    toast('Could not build the preview from those stops');
    return;
  }

  t = oldDuration > 0 ? (t / oldDuration) * next.duration : 0;
  timeline = next;
  dom.empty.hidden = true;
  dom.phone.hidden = false;
  dom.playBar.hidden = false;
  layoutPreview();
  render();
  warmTilesSoon();
}

const warmTilesSoon = debounce(function () {
  warmTiles();
}, 300);

let warmAbort = null;

/** Quietly pull the tiles this timeline needs so preview and export start warm. */
function warmTiles() {
  if (!timeline) return;
  // A road landing mid export rebuilds the timeline. The exporter is already
  // pulling tiles for that route, so stay off the same cache.
  if (exporting) return;
  if (warmAbort) warmAbort.abort();
  warmAbort = new AbortController();

  let list = null;
  try {
    list = planTiles(timeline);
  } catch (err) {
    return;
  }
  // Preview only needs the opening of the trip to look right: lazy get() plus
  // the renderer's parent-zoom fallback covers the rest, and an unbounded warm
  // list would pin the whole plan in the cache.
  if (list.length > WARM_TILE_CAP) list = list.slice(0, WARM_TILE_CAP);
  const cache = tilesFor(state.themeId);
  let seen = 0;
  cache.prefetch(list, {
    signal: warmAbort.signal,
    concurrency: 6,
    pin: false,
    onProgress: function () {
      seen += 1;
      if (!playing && seen % 8 === 0) render();
    }
  }).then(function () {
    if (!playing) render();
  }).catch(function () {
    /* aborted or offline: the renderer skips missing tiles */
  });
}

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

let exportAbort = null;
let exportUrl = '';
let lastFocus = null;
let manualDialog = false;
let cleanupDone = true;
/** Bumped for every export run and every dialog close, so a late settle knows it is stale. */
let exportSession = 0;
/** Backdrop used only by the manual dialog fallback. */
let manualBackdrop = null;

/** Fill both export buttons and mirror the disabled state. */
function syncExportButtons() {
  const canRecord = exportSupport.mp4 || exportSupport.webm;
  const ready = state.stops.length >= 2 && !exporting && canRecord;
  const buttons = [dom.exportBtn, dom.exportBtnMobile];
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i];
    btn.textContent = '';
    btn.appendChild(icon(ICONS.download));
    btn.appendChild(make('span', null, exporting ? 'Exporting' : 'Export video'));
    btn.disabled = !ready;
  }
  if (state.stops.length < 2) dom.exportHint.textContent = 'Add at least 2 stops';
  else if (!canRecord) dom.exportHint.textContent = 'This browser cannot record video. Try Chrome, Edge or Safari 16.4+.';
  else dom.exportHint.textContent = 'No sign-up, the file never leaves your device.';
}

/** Drop the previous object URL so blobs do not pile up. */
function revokeExportUrl() {
  if (!exportUrl) return;
  dom.exVideo.removeAttribute('src');
  dom.exVideo.load();
  URL.revokeObjectURL(exportUrl);
  exportUrl = '';
}

/**
 * @param {'progress'|'done'|'error'} pane which pane to show
 */
function showPane(pane) {
  dom.exProgress.hidden = pane !== 'progress';
  dom.exDone.hidden = pane !== 'done';
  dom.exError.hidden = pane !== 'error';
  if (pane === 'progress') dom.exTitle.textContent = 'Exporting your reel';
  else if (pane === 'done') dom.exTitle.textContent = 'Your reel is ready';
  else dom.exTitle.textContent = 'Export did not finish';
}

/** Body sections that must go quiet while the manual dialog is up. */
function backgroundSections() {
  const out = [];
  const wrap = document.querySelector('.wrap');
  const bar = document.getElementById('exportBar');
  if (wrap) out.push(wrap);
  if (bar) out.push(bar);
  return out;
}

/**
 * Engines without showModal get a real modal anyway: a backdrop that eats
 * pointer events, an inert background, and a stacking order above the sticky
 * export bar and the toasts.
 */
function enterManualModal() {
  const back = make('div', 'dlg-backdrop');
  back.style.position = 'fixed';
  back.style.top = '0';
  back.style.right = '0';
  back.style.bottom = '0';
  back.style.left = '0';
  back.style.background = 'rgba(10, 14, 18, .55)';
  back.style.zIndex = '400';
  back.addEventListener('pointerdown', function (ev) { ev.preventDefault(); });
  document.body.appendChild(back);
  manualBackdrop = back;

  dom.dlg.style.zIndex = '401';
  const sections = backgroundSections();
  for (let i = 0; i < sections.length; i++) {
    sections[i].setAttribute('aria-hidden', 'true');
    sections[i].inert = true;
  }
  document.documentElement.style.overflow = 'hidden';
  document.addEventListener('keydown', manualTrap, true);
}

/** Undo everything enterManualModal did. */
function exitManualModal() {
  if (manualBackdrop && manualBackdrop.parentNode) manualBackdrop.parentNode.removeChild(manualBackdrop);
  manualBackdrop = null;
  dom.dlg.style.zIndex = '';
  const sections = backgroundSections();
  for (let i = 0; i < sections.length; i++) {
    sections[i].removeAttribute('aria-hidden');
    sections[i].inert = false;
  }
  document.documentElement.style.overflow = '';
  document.removeEventListener('keydown', manualTrap, true);
}

/**
 * @param {Element} [trigger] the control that opened the dialog
 */
function openDialog(trigger) {
  // Retry reopens an already open dialog: keep the focus we came in with,
  // otherwise it becomes a button inside the dialog and closing strands focus.
  // The trigger is passed in because disabling the export button blurs it
  // before we get here, and the body is not a place to send focus back to.
  if (!dom.dlg.open && !manualDialog) {
    const el = trigger && typeof trigger.focus === 'function' ? trigger : document.activeElement;
    lastFocus = el && el !== document.body ? el : null;
  }
  cleanupDone = false;
  if (typeof dom.dlg.showModal === 'function') {
    if (!dom.dlg.open) dom.dlg.showModal();
    manualDialog = false;
  } else if (!manualDialog) {
    dom.dlg.setAttribute('open', '');
    manualDialog = true;
    enterManualModal();
  }
}

/**
 * Close and clean up. Cleanup is driven from here rather than from the
 * dialog's close event, which not every engine delivers.
 */
function closeDialog() {
  if (manualDialog) {
    dom.dlg.removeAttribute('open');
    exitManualModal();
    manualDialog = false;
  } else if (dom.dlg.open) {
    dom.dlg.close();
  }
  onDialogClosed();
}

/**
 * Focus trap and Escape for engines without <dialog>.
 * @param {KeyboardEvent} ev keydown
 */
function manualTrap(ev) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    if (exportAbort) exportAbort.abort();
    closeDialog();
    return;
  }
  if (ev.key !== 'Tab') return;
  const focusable = dom.dlg.querySelectorAll('button:not([disabled]), a[href], video, [tabindex]:not([tabindex="-1"])');
  const list = Array.from(focusable).filter(function (el) { return el.offsetParent !== null; });
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}

/**
 * @returns {HTMLElement|null} a visible export button to fall back on
 */
function visibleExportButton() {
  const buttons = [dom.exportBtn, dom.exportBtnMobile];
  for (let i = 0; i < buttons.length; i++) {
    if (buttons[i].offsetParent !== null && !buttons[i].disabled) return buttons[i];
  }
  return null;
}

/** Shared cleanup whichever way the dialog closed. Safe to call twice. */
function onDialogClosed() {
  if (cleanupDone) return;
  cleanupDone = true;
  // Anything still running for this dialog is now stale, whatever it settles as.
  exportSession += 1;
  if (exportAbort) {
    exportAbort.abort();
    exportAbort = null;
  }
  revokeExportUrl();
  exporting = false;
  releaseRoadHold();
  syncExportButtons();

  const back = lastFocus;
  lastFocus = null;
  if (back && back !== document.body && back.isConnected !== false && !back.disabled
    && !dom.dlg.contains(back) && typeof back.focus === 'function') {
    back.focus();
  } else {
    const fallback = visibleExportButton();
    if (fallback) fallback.focus();
    else dom.search.focus();
  }
}

/** Tiles and frames now interleave, so each stage keeps its own tally. */
let exTiles = { done: 0, total: 0 };
let exFrames = { done: 0, total: 0 };
let exEncoding = false;

/** Forget the previous run's counters. */
function resetExportProgress() {
  exTiles = { done: 0, total: 0 };
  exFrames = { done: 0, total: 0 };
  exEncoding = false;
  dom.exStage.textContent = 'Preparing map tiles';
  dom.exCount.textContent = '';
  dom.exBar.setAttribute('aria-valuenow', '0');
  dom.exBar.firstElementChild.style.width = '0%';
}

/**
 * @param {{ stage: string, done?: number, total?: number }} p progress event
 */
function onExportProgress(p) {
  if (!p) return;

  // The muxer and the file write have no honest percentage: go indeterminate
  // rather than pretend the bar is still moving.
  if (p.stage === 'finish') {
    dom.exStage.textContent = 'Finishing your video';
    dom.exCount.textContent = '';
    dom.exBar.removeAttribute('aria-valuenow');
    dom.exBar.firstElementChild.style.width = '100%';
    return;
  }

  const done = Math.max(0, Number(p.done) || 0);
  const total = Math.max(0, Number(p.total) || 0);
  if (p.stage === 'tiles') {
    exTiles = { done: done, total: total };
  } else {
    exEncoding = true;
    exFrames = { done: done, total: total };
  }

  const tileFrac = exTiles.total > 0 ? Math.min(1, exTiles.done / exTiles.total) : 0;
  const frameFrac = exFrames.total > 0 ? Math.min(1, exFrames.done / exFrames.total) : 0;
  const overall = tileFrac * 0.3 + frameFrac * 0.7;

  // Once frames are being written the headline stays on frames: late tile
  // windows must not throw the stage line back to the start.
  dom.exStage.textContent = exEncoding ? 'Rendering frames' : 'Preparing map tiles';
  dom.exCount.textContent = exEncoding
    ? exFrames.done + ' of ' + exFrames.total + ' frames'
    : exTiles.done + ' of ' + exTiles.total + ' tiles';
  const pct = Math.round(overall * 100);
  dom.exBar.setAttribute('aria-valuenow', String(pct));
  dom.exBar.firstElementChild.style.width = pct + '%';
}

/**
 * @param {Object} result the exporter result
 */
function showResult(result) {
  revokeExportUrl();
  exportUrl = URL.createObjectURL(result.blob);
  dom.exVideo.src = exportUrl;
  dom.exMeta.textContent = fmtSize(result.blob.size) + ', ' + fmtTime(result.seconds)
    + ', ' + result.width + 'x' + result.height;
  dom.exDownload.href = exportUrl;
  dom.exDownload.download = 'mynextstop-reel.' + result.ext;
  dom.exFallbackNote.hidden = result.ext !== 'webm';

  const failed = Number(result.failedTiles) || 0;
  if (failed > 0) {
    dom.exTileNote.textContent = 'Some map tiles did not load (' + failed + '). The video may have blank patches.';
    dom.exTileNote.hidden = false;
  } else {
    dom.exTileNote.textContent = '';
    dom.exTileNote.hidden = true;
  }

  showPane('done');
  dom.exDownload.focus();
}

/** Internal exporter codes, said the way a person would say them. */
const EXPORT_ERROR_COPY = {
  'export-unsupported': 'This browser cannot record video. Try Chrome, Edge or Safari 16.4+.',
  'bad-timeline': 'This route could not be turned into a video. Try removing a stop, then export again.',
  'canvas-unavailable': 'The video canvas could not start. Reload the page, then try again.',
  'muxer-empty': 'The video came out empty. Try again, or try a shorter route.',
  'recorder-empty': 'The recording came out empty. Try again, and keep this tab in front while it runs.'
};

/**
 * Never show a raw exception as copy.
 * @param {*} err whatever the exporter threw
 * @returns {string} a friendly line
 */
function friendlyExportError(err) {
  const code = err && err.message ? String(err.message) : '';
  if (Object.prototype.hasOwnProperty.call(EXPORT_ERROR_COPY, code)) return EXPORT_ERROR_COPY[code];

  const name = err && err.name ? String(err.name) : '';
  if (name === 'NotSupportedError' || name === 'EncodingError' || /codec|configur/i.test(code)) {
    return 'This browser could not set up the video encoder. Try Chrome or Edge, or pick a smaller format.';
  }
  if (name === 'NetworkError' || /network|fetch|tile|offline/i.test(code)) {
    return 'The map tiles could not load. Check your connection, then try again.';
  }
  return 'The export did not finish. Try again, or try a shorter route.';
}

/**
 * Fold the raw exception into a collapsed detail line under the friendly copy.
 * @param {*} err whatever the exporter threw
 */
function setErrorDetail(err) {
  let detail = dom.exError.querySelector('.ex-detail');
  const name = err && err.name ? String(err.name) : '';
  const message = err && err.message ? String(err.message) : '';
  const text = (name && message ? name + ': ' + message : name || message).slice(0, 300);

  if (!text) {
    if (detail) detail.hidden = true;
    return;
  }
  if (!detail) {
    detail = document.createElement('details');
    detail.className = 'ex-detail';
    detail.style.fontSize = '12.5px';
    detail.style.color = 'var(--muted)';
    const summary = document.createElement('summary');
    summary.textContent = 'Technical detail';
    summary.style.cursor = 'pointer';
    summary.style.padding = '6px 0';
    detail.appendChild(summary);
    detail.appendChild(make('p', 'ex-detail-body'));
    dom.exErrorMsg.parentNode.insertBefore(detail, dom.exErrorMsg.nextSibling);
  }
  detail.open = false;
  detail.hidden = false;
  detail.querySelector('.ex-detail-body').textContent = text;
}

/**
 * @param {*} err whatever the exporter threw
 */
function showError(err) {
  dom.exErrorMsg.textContent = friendlyExportError(err);
  setErrorDetail(err);
  showPane('error');
  dom.exRetry.focus();
}

async function startExport() {
  if (!timeline || exporting) return;
  // Grab the trigger before syncExportButtons disables it out from under focus.
  const trigger = document.activeElement;
  pause();
  if (warmAbort) warmAbort.abort();

  // Claim the run before anything can await: a second click, or a settle from
  // a run the user already cancelled, must not touch this one's state.
  exporting = true;
  const session = ++exportSession;
  syncExportButtons();
  revokeExportUrl();
  showPane('progress');
  resetExportProgress();
  openDialog(trigger);
  dom.exCancel.focus();

  // Let roads still on the wire land first, so the video matches the preview
  // the user is about to get. Nearly always instant: the cache has them, and
  // session failures are already marked so nothing can hang here.
  await awaitPendingRoads();
  if (exportSession !== session) return;
  // Anything that just landed goes in before the timeline is handed over.
  flushRoadRebuild();
  if (!timeline) {
    exporting = false;
    syncExportButtons();
    showError(new Error('bad-timeline'));
    return;
  }

  // From here the exporter owns the tile cache. A road landing now must not
  // rebuild or render the preview into it: hold the work until the session is
  // over. warmTiles has the same rule, and rebuildTimeline renders past it.
  exportHoldsTiles = true;
  roadRebuildHeld = false;

  const ac = new AbortController();
  exportAbort = ac;
  try {
    const result = await exportVideo({
      timeline: timeline,
      tiles: tilesFor(state.themeId),
      onProgress: onExportProgress,
      signal: ac.signal
    });
    // Cancelled, closed, or superseded: drop the result, blob URL and all.
    if (exportSession !== session) return;
    exportAbort = null;
    exporting = false;
    syncExportButtons();
    showResult(result);
  } catch (err) {
    if (exportSession !== session) return;
    exportAbort = null;
    exporting = false;
    syncExportButtons();
    if (err && err.name === 'AbortError') {
      closeDialog();
      return;
    }
    showError(err);
  }
}

/* ------------------------------------------------------------------ *
 * theme toggle
 * ------------------------------------------------------------------ */

/**
 * @returns {'light'|'dark'} the theme in force right now
 */
function currentTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * @param {'light'|'dark'} mode theme to apply
 */
function setTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  document.documentElement.style.colorScheme = mode;
  try { localStorage.setItem(THEME_KEY, mode); } catch (err) { /* private mode */ }
  syncThemeButton();
}

function syncThemeButton() {
  const dark = currentTheme() === 'dark';
  dom.themeBtn.textContent = '';
  dom.themeBtn.appendChild(icon(dark ? ICONS.sun : ICONS.moon));
}

/* ------------------------------------------------------------------ *
 * wiring
 * ------------------------------------------------------------------ */

function wire() {
  // announce is offered so search status rows can reach the shared live region.
  createSearch({ input: dom.search, listbox: dom.results, onPick: addStop, announce: announce });

  dom.themeBtn.addEventListener('click', function () {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });

  wireRadioGroup(dom.styleRow, function (value) {
    state.themeId = value;
    commit();
  });
  wireRadioGroup(dom.formatSeg, function (value) {
    state.format = value;
    commit();
  });
  wireRadioGroup(dom.speedSeg, function (value) {
    state.speed = value;
    commit();
  });

  const titleChanged = debounce(function () {
    state.title = dom.title.value.slice(0, 48);
    rebuildTimeline();
    saveDraft();
  }, 250);
  dom.title.addEventListener('input', titleChanged);

  dom.sampleBtn.addEventListener('click', loadSample);

  dom.playBtn.addEventListener('click', function () {
    if (playing) pause(); else play();
  });
  dom.seek.addEventListener('input', function () {
    if (!timeline) return;
    t = Math.max(0, Math.min(timeline.duration, parseFloat(dom.seek.value) || 0));
    render();
  });

  dom.exportBtn.addEventListener('click', startExport);
  dom.exportBtnMobile.addEventListener('click', startExport);
  dom.exCancel.addEventListener('click', function () {
    if (exportAbort) exportAbort.abort();
    closeDialog();
  });
  dom.exClose.addEventListener('click', closeDialog);
  dom.exErrClose.addEventListener('click', closeDialog);
  dom.exRetry.addEventListener('click', startExport);

  // Escape on a native <dialog> fires cancel first. Drive the close from
  // here so cleanup runs on every engine, then keep the close listener as a
  // harmless safety net (onDialogClosed is idempotent).
  dom.dlg.addEventListener('cancel', function (ev) {
    ev.preventDefault();
    if (exportAbort) exportAbort.abort();
    closeDialog();
  });
  dom.dlg.addEventListener('close', onDialogClosed);

  let resizeId = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeId);
    resizeId = setTimeout(function () {
      if (!timeline) return;
      layoutPreview();
      render();
    }, 120);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pause();
  });
}

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

function init() {
  syncThemeButton();
  renderFormatLabels();
  renderStyleCards();
  buildStartOver();
  buildRouteShape();
  addRoutingCredit();
  wire();

  const rawSeed = rawParam(location.search, 'stops');
  const seed = parseSeed(rawSeed);
  // Strip only our own parameter's query so unrelated params (utm and the
  // like) survive a plain visit.
  if (rawSeed !== null) stripSeedQuery();
  let stashed = false;
  let restored = false;
  if (seed) {
    stashed = stashDraft(seed);
    applySeed(seed);
  } else {
    restored = restoreDraft();
  }
  dom.title.value = state.title;
  syncRadio(dom.formatSeg, state.format);
  syncRadio(dom.speedSeg, state.speed);
  syncRadio(dom.styleRow, state.themeId);
  if (dom.routeSeg) syncRadio(dom.routeSeg, state.routeStyle);
  syncPlayButton();
  commit();

  if (seed) {
    toast('Trip loaded from the map',
      stashed ? { label: 'Restore previous', onAction: restorePrevious } : undefined);
  } else if (restored) {
    toast('Restored your draft', { label: 'Start fresh', onAction: startFresh });
  }

  Promise.resolve().then(detectExportSupport).then(function (support) {
    if (support) exportSupport = support;
    syncExportButtons();
  }).catch(function () { /* keep the optimistic default */ });

  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    window.__reel = {
      getState: function () { return project(); },
      getTimeline: function () { return timeline; },
      getRoads: function () {
        const pending = [];
        roadJobs.forEach(function (job, key) { pending.push(key); });
        return {
          style: state.routeStyle,
          have: Object.keys(state.roads),
          pending: pending,
          failed: Array.from(roadFailed.keys()),
          pausedFor: Math.max(0, roadPauseUntil - Date.now())
        };
      },
      syncRoads: syncRoads,
      THEMES: THEMES,
      renderFrame: renderFrame,
      buildTimeline: buildTimeline,
      exportVideo: exportVideo
    };
  }
}

init();
