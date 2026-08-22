/**
 * routes.js
 * Real road geometry for road legs (car, motorbike, bus, bicycle, on foot),
 * fetched from the FOSSGIS OSRM routers (the same public service
 * openstreetmap.org uses).
 *
 * Nothing here touches the DOM. localStorage is reached through a guarded
 * accessor, so the module still imports and runs in a plain node process.
 *
 * The contract is deliberately blunt: fetchRoad either returns a clean, already
 * simplified route or it throws. Every caller is expected to fall back to the
 * stylized arc on a throw, so an offline browser, a slow router or an absurd
 * detour can never break a preview or an export.
 */

import { haversineKm, safeLatLng, douglasPeuckerIndices } from './geo.js';

/**
 * Router endpoints, one per supported profile. The profile segment of the
 * path is a placeholder osrm-routed ignores (each instance serves one profile),
 * so every URL uses the same word openstreetmap.org itself sends.
 */
const ENDPOINTS = {
  car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
  bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/',
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/'
};

/** The leg modes each profile routes. Every other mode keeps its arc. */
const PROFILE_OF_MODE = {
  car: 'car',
  moto: 'car',
  bus: 'car',
  cycle: 'bike',
  // The old id for the bicycle, still in drafts saved before 'cycle' existed.
  bike: 'bike',
  walk: 'foot'
};

/** Query string shared by every profile. */
const QUERY = '?overview=full&geometries=polyline6';

/**
 * Our own deadline, on top of whatever the caller's signal does.
 *
 * Generous on purpose. A long route with overview=full is a few hundred
 * kilobytes on a slow mobile link, and when the router is busy it does not
 * answer 429, it simply holds the connection. Six seconds turned both of
 * those into "no road" for the rest of the session.
 */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Legs longer than this, as the crow flies, never reach the router at all: a
 * Delhi to Lisbon "drive" is not a road trip, and nobody cycles or walks
 * across a subcontinent in one leg.
 */
const MAX_LEG_KM = { car: 2000, bike: 1500, foot: 300 };

/** Point budget for a stored route. */
const MAX_POINTS = 600;

/** localStorage key for the persisted cache. */
const STORAGE_KEY = 'mns-reel-roads-v1';

/** How many routes the cache keeps, least recently used first out. */
const CACHE_MAX = 40;

/** Coordinate precision used in cache keys. */
const KEY_DECIMALS = 4;

/** Coordinate precision sent to the router. */
const URL_DECIMALS = 6;

/**
 * How far a decoded end point may sit from its stop.
 *
 * The router snaps each stop to the nearest piece of its network, and a good
 * share of the places people put in a reel are not on one: a lake, a pass, a
 * trailhead village, a beach. The path pins its ends to the stops anyway, so a
 * snap this far away renders as a short straight run off the road to the pin,
 * which is exactly what the last stretch of such a trip is. The allowance
 * grows with the leg, between these two bounds, so a pin in open desert or on
 * an island that snaps to a road a hundred kilometres away still falls back to
 * the arc instead of drawing a spike across the map.
 */
const ENDPOINT_MIN_KM = 10;
const ENDPOINT_MAX_KM = 40;

/** Fraction of the straight line the allowance tracks between those bounds. */
const ENDPOINT_FRACTION = 0.2;

/** How far the traced polyline may drift from the router's own distance. */
const LENGTH_FACTOR = 1.5;

/** Absolute slack on the length check, so sub-kilometre hops are not rejected. */
const LENGTH_SLACK_KM = 1;

/* ------------------------------------------------------------------ shapes */

/**
 * The router profile a leg mode maps to.
 * @param {string} mode A MODE_META id from vehicles.js.
 * @returns {string|null} 'car', 'bike' or 'foot', or null for a mode that
 *   keeps its stylized arc (plane, train, boat).
 */
export function roadProfile(mode) {
  if (typeof mode !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(PROFILE_OF_MODE, mode) ? PROFILE_OF_MODE[mode] : null;
}

/**
 * Round a coordinate for use inside a cache key.
 * @param {number} v Degrees.
 * @returns {string} Fixed precision text.
 */
function keyNum(v) {
  return Number(v).toFixed(KEY_DECIMALS);
}

/**
 * The cache key for one leg.
 *
 * Direction matters: a route from A to B is not always the reverse of B to A
 * once one way streets are involved, so the pair is never sorted.
 *
 * @param {{lat: number, lng: number}} a Start stop.
 * @param {{lat: number, lng: number}} b End stop.
 * @param {string} mode Leg mode.
 * @returns {string|null} A key, or null when the leg has no road profile.
 */
export function roadKey(a, b, mode) {
  const profile = roadProfile(mode);
  if (!profile) return null;
  if (!a || !b) return null;
  const la = Number(a.lat);
  const na = Number(a.lng);
  const lb = Number(b.lat);
  const nb = Number(b.lng);
  if (!Number.isFinite(la) || !Number.isFinite(na)) return null;
  if (!Number.isFinite(lb) || !Number.isFinite(nb)) return null;
  return profile + '|' + keyNum(la) + ',' + keyNum(na) + '|' + keyNum(lb) + ',' + keyNum(nb);
}

/* ---------------------------------------------------------------- decoding */

/**
 * Decode an OSRM polyline6 geometry string.
 *
 * Same algorithm as Google's encoded polyline, at 1e-6 precision instead of
 * 1e-5. Written out rather than pulled in, because the build has no
 * dependencies and this is twenty lines.
 *
 * The decoder fails closed. A chunk that runs off the end of the string, or
 * that ends with its continuation bit still set, means the geometry was
 * truncated somewhere between the router and us: the whole result is discarded
 * rather than committing a half read delta, which would otherwise land as a
 * plausible looking kink that no later sanity check can see.
 *
 * @param {string} str Encoded geometry.
 * @returns {Array<number[]>} Points as [lng, lat] pairs, empty when malformed.
 */
function decodePolyline6(str) {
  const out = [];
  const len = str.length;
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < len) {
    let shift = 0;
    let result = 0;
    let byte = 0;
    do {
      if (index >= len) return [];
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0;
    result = 0;
    do {
      if (index >= len) return [];
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    out.push([lng / 1e6, lat / 1e6]);
  }
  return out;
}

/* -------------------------------------------------------------- simplifying */

/**
 * Thin a road polyline down to the point budget.
 *
 * Douglas-Peucker runs in degrees with longitude scaled by cos(midLat), so the
 * tolerance means roughly the same ground distance in both axes. The tolerance
 * doubles until the result fits, which keeps the shape as detailed as the
 * budget allows rather than fixing an arbitrary distance.
 *
 * The first tolerance is sized from the trace's own bounding box rather than
 * from a fixed 1e-6 degrees, so a long leg converges in two or three passes
 * instead of ten or more full passes over tens of thousands of raw points.
 *
 * @param {Array<number[]>} coords Points as [lng, lat].
 * @param {number} maxPoints Point budget.
 * @returns {Array<number[]>} The same array when it already fits, else a subset.
 */
function simplifyCoords(coords, maxPoints) {
  if (coords.length <= maxPoints) return coords;

  const midLat = coords[Math.floor(coords.length / 2)][1];
  const kx = Math.max(0.05, Math.cos(midLat * Math.PI / 180));
  const projected = new Array(coords.length);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < coords.length; i++) {
    const x = coords[i][0] * kx;
    const y = coords[i][1];
    projected[i] = { x: x, y: y };
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // An error of a few thousandths of the route's own extent is well under a
  // pixel at any zoom the reel uses, so this seed is still finer than the
  // budget usually needs: the doubling loop below does the rest.
  const diagonal = Math.hypot(maxX - minX, maxY - minY);
  let tol = Math.max(1e-9, diagonal / (8 * maxPoints));
  let kept = null;
  for (let step = 0; step < 44; step++) {
    const idx = douglasPeuckerIndices(projected, tol);
    if (idx.length <= maxPoints) {
      kept = idx;
      break;
    }
    tol *= 2;
  }
  // Unreachable in practice: by here the tolerance spans the globe.
  if (!kept) return [coords[0], coords[coords.length - 1]];

  // A seed that undershoots leaves budget unspent, which would quietly coarsen
  // long routes. A few halvings buy that detail back and still cost far fewer
  // passes than climbing all the way from a fixed 1e-6 degrees.
  for (let step = 0; step < 3 && kept.length * 2 <= maxPoints; step++) {
    tol /= 2;
    const finer = douglasPeuckerIndices(projected, tol);
    if (finer.length > maxPoints) break;
    kept = finer;
  }

  const out = new Array(kept.length);
  for (let i = 0; i < kept.length; i++) out[i] = coords[kept[i]];
  return out;
}

/* ----------------------------------------------------------------- fetching */

/**
 * Build an AbortError the same way fetch does.
 * @returns {Error} An error whose name is 'AbortError'.
 */
function abortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('Aborted', 'AbortError');
  }
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Every coordinate finite and inside the world.
 * @param {Array<number[]>} coords Points as [lng, lat].
 * @returns {boolean} True when the whole list is usable.
 */
function coordsAreSane(coords) {
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    if (!c || c.length < 2) return false;
    const lng = c[0];
    const lat = c[1];
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
    if (lat < -90 || lat > 90) return false;
    if (lng < -180 || lng > 180) return false;
  }
  return true;
}

/**
 * Ground distance walked by a polyline.
 * @param {Array<number[]>} coords Points as [lng, lat].
 * @returns {number} Kilometres.
 */
function polylineKm(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const p = coords[i - 1];
    const q = coords[i];
    total += haversineKm({ lat: p[1], lng: p[0] }, { lat: q[1], lng: q[0] });
  }
  return total;
}

/**
 * This geometry really is the road between these two stops.
 *
 * Three questions the point count and world bounds checks cannot answer:
 * does the line start and end at the stops (the router snaps waypoints to the
 * network with no radius limit, so a pin in a desert or on a small island can
 * come back attached to a road a hundred kilometres away, which then renders
 * as a dead straight spike), is the distance a plausible detour, and does the
 * geometry agree with the distance the router reported for it.
 *
 * @param {Array<number[]>} coords Points as [lng, lat].
 * @param {number} km The router's driving distance.
 * @param {{lat: number, lng: number}} a Start stop.
 * @param {{lat: number, lng: number}} b End stop.
 * @returns {boolean} True when the route belongs to this leg.
 */
function roadFitsLeg(coords, km, a, b) {
  if (!Array.isArray(coords) || coords.length < 2) return false;
  if (!Number.isFinite(km) || km < 0) return false;

  const sa = safeLatLng(a);
  const sb = safeLatLng(b);
  const straight = haversineKm(sa, sb);
  if (!Number.isFinite(straight)) return false;

  // A road that wanders four times further than the crow flies, or eighty
  // kilometres past it on a short hop, is a ferry chain or a routing accident,
  // not a drive worth animating.
  if (km > Math.max(4 * straight, straight + 80)) return false;

  const near = Math.min(ENDPOINT_MAX_KM, Math.max(ENDPOINT_MIN_KM, ENDPOINT_FRACTION * straight));
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (haversineKm({ lat: first[1], lng: first[0] }, sa) > near) return false;
  if (haversineKm({ lat: last[1], lng: last[0] }, sb) > near) return false;

  const traced = polylineKm(coords);
  if (!Number.isFinite(traced)) return false;
  const low = Math.min(km, traced);
  const high = Math.max(km, traced);
  if (high > LENGTH_FACTOR * low + LENGTH_SLACK_KM) return false;

  return true;
}

/**
 * Ask the router for the road between two stops.
 *
 * Throws on every failure path, with a short machine readable message:
 * 'no-profile', 'too-long', 'timeout', 'http-<status>', 'router-error',
 * 'bad-route', or an AbortError when the caller's signal fired.
 *
 * @param {{lat: number, lng: number}} a Start stop.
 * @param {{lat: number, lng: number}} b End stop.
 * @param {string} mode Leg mode, must map to a profile (see roadProfile).
 * @param {{signal?: AbortSignal}} [options] Caller's abort signal.
 * @returns {Promise<{coords: Array<number[]>, km: number}>} Road geometry as
 *   [lng, lat] pairs, and the router's driving distance in kilometres.
 */
export async function fetchRoad(a, b, mode, options) {
  const opts = options || {};
  const profile = roadProfile(mode);
  if (!profile) throw new Error('no-profile');

  const sa = safeLatLng(a);
  const sb = safeLatLng(b);
  const straight = haversineKm(sa, sb);
  if (!Number.isFinite(straight)) throw new Error('bad-route');
  // The cap is checked before anything goes out on the wire, so the router
  // is never asked a question whose answer would be thrown away.
  if (straight > MAX_LEG_KM[profile]) throw new Error('too-long');

  const url = ENDPOINTS[profile] +
    sa.lng.toFixed(URL_DECIMALS) + ',' + sa.lat.toFixed(URL_DECIMALS) + ';' +
    sb.lng.toFixed(URL_DECIMALS) + ',' + sb.lat.toFixed(URL_DECIMALS) +
    QUERY;

  const outer = opts.signal || null;
  if (outer && outer.aborted) throw abortError();

  const ctrl = new AbortController();
  let timedOut = false;
  const onOuterAbort = function () { ctrl.abort(); };
  const timer = setTimeout(function () {
    timedOut = true;
    ctrl.abort();
  }, REQUEST_TIMEOUT_MS);
  if (outer) outer.addEventListener('abort', onOuterAbort);

  let json = null;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'default'
    });
    if (!res.ok) throw new Error('http-' + res.status);
    json = await res.json();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      if (outer && outer.aborted) throw err;
      if (timedOut) throw new Error('timeout');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onOuterAbort);
  }

  if (!json || json.code !== 'Ok' || !Array.isArray(json.routes) || !json.routes.length) {
    throw new Error('router-error');
  }
  const route = json.routes[0];
  if (!route || typeof route.geometry !== 'string') throw new Error('router-error');

  const km = Number(route.distance) / 1000;
  if (!Number.isFinite(km) || km < 0) throw new Error('bad-route');

  const decoded = decodePolyline6(route.geometry);
  if (decoded.length < 2 || !coordsAreSane(decoded)) throw new Error('bad-route');

  // Validate what we are about to return and cache, not the raw trace, so a
  // route that passes here also passes the identical check in cachedRoad on
  // the next session instead of being refetched every time.
  const coords = simplifyCoords(decoded, MAX_POINTS);
  if (!roadFitsLeg(coords, km, sa, sb)) throw new Error('bad-route');

  return { coords: coords, km: km };
}

/* -------------------------------------------------------------------- cache */

/** key -> { coords, km }, in least recently used order. */
const memory = new Map();

/**
 * Keys this session threw out as not matching their own leg. They are never
 * merged back in from storage, otherwise a rejected row written by another tab
 * would return on the next persist.
 */
const rejected = new Set();

let hydrated = false;

/**
 * localStorage, or null when it is missing or blocked.
 * @returns {Storage|null} The storage area.
 */
function storageArea() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return localStorage;
  } catch (err) {
    return null;
  }
}

/**
 * One route entry survived the JSON round trip intact.
 * @param {*} value Parsed entry value.
 * @returns {boolean} True when it is usable.
 */
function entryIsSane(value) {
  if (!value || typeof value !== 'object') return false;
  if (!Number.isFinite(value.km) || value.km < 0) return false;
  if (!Array.isArray(value.coords) || value.coords.length < 2) return false;
  if (value.coords.length > MAX_POINTS) return false;
  return coordsAreSane(value.coords);
}

/**
 * Read the persisted cache once per session.
 * @returns {void}
 */
function hydrate() {
  if (hydrated) return;
  hydrated = true;
  const area = storageArea();
  if (!area) return;
  let raw = null;
  try {
    raw = area.getItem(STORAGE_KEY);
  } catch (err) {
    return;
  }
  if (!raw) return;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return;
  }
  const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : null;
  if (!entries) return;
  for (let i = 0; i < entries.length; i++) {
    const row = entries[i];
    if (!Array.isArray(row) || row.length < 2) continue;
    if (typeof row[0] !== 'string' || !row[0]) continue;
    if (!entryIsSane(row[1])) continue;
    memory.set(row[0], { coords: row[1].coords, km: row[1].km });
    if (memory.size > CACHE_MAX) memory.delete(memory.keys().next().value);
  }
}

/**
 * The two stops a cache key names.
 * @param {string} key A key from roadKey.
 * @returns {{a: {lat: number, lng: number}, b: {lat: number, lng: number}}|null}
 *   The pair, or null when the key is not one of ours.
 */
function keyStops(key) {
  const parts = String(key).split('|');
  if (parts.length !== 3) return null;
  if (!Object.prototype.hasOwnProperty.call(ENDPOINTS, parts[0])) return null;
  const ends = [];
  for (let i = 1; i < 3; i++) {
    const nums = parts[i].split(',');
    if (nums.length !== 2) return null;
    const lat = Number(nums[0]);
    const lng = Number(nums[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    ends.push({ lat: lat, lng: lng });
  }
  return { a: ends[0], b: ends[1] };
}

/**
 * Rows another tab wrote since we hydrated, ones this tab knows nothing about.
 *
 * Without this, the last tab to write wins the whole key and silently throws
 * away every route its siblings cached, which means refetching them next
 * session for no reason. The router is a free public service, so that matters.
 *
 * @returns {Array<Array>} Rows as [key, value], oldest first.
 */
function foreignRows() {
  const area = storageArea();
  if (!area) return [];
  let raw = null;
  try {
    raw = area.getItem(STORAGE_KEY);
  } catch (err) {
    return [];
  }
  if (!raw) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return [];
  }
  const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : null;
  if (!entries) return [];

  const rows = [];
  const seen = new Set();
  for (let i = 0; i < entries.length; i++) {
    const row = entries[i];
    if (!Array.isArray(row) || row.length < 2) continue;
    const key = row[0];
    if (typeof key !== 'string' || !key) continue;
    if (seen.has(key) || memory.has(key) || rejected.has(key)) continue;
    if (!entryIsSane(row[1])) continue;
    // A key names its own two stops, so a foreign row can be held to exactly
    // the same standard as one of ours instead of being copied on trust.
    const stops = keyStops(key);
    if (!stops || !roadFitsLeg(row[1].coords, row[1].km, stops.a, stops.b)) continue;
    seen.add(key);
    rows.push([key, { coords: row[1].coords, km: row[1].km }]);
  }
  return rows;
}

/**
 * Write the cache back out, dropping entries rather than failing on quota.
 * @returns {void}
 */
function persist() {
  const area = storageArea();
  if (!area) return;

  // Another tab's rows go first, so when the cap or a quota error bites, this
  // tab's own freshly used routes are the ones that survive.
  const rows = foreignRows();
  memory.forEach(function (value, key) { rows.push([key, value]); });
  if (rows.length > CACHE_MAX) rows.splice(0, rows.length - CACHE_MAX);

  for (let attempt = 0; attempt < 3 && rows.length; attempt++) {
    try {
      area.setItem(STORAGE_KEY, JSON.stringify({ v: 1, entries: rows }));
      return;
    } catch (err) {
      // Almost always a quota error. Halve the payload and try again, then
      // give up quietly: the cache is an optimisation, never a requirement.
      rows.splice(0, Math.max(1, Math.floor(rows.length / 2)));
    }
  }
  try {
    area.removeItem(STORAGE_KEY);
  } catch (err) {
    // Nothing sensible left to do.
  }
}

/**
 * Look a road up without touching the network.
 *
 * A hit is re-validated against the two stops with exactly the rules fetchRoad
 * applies. localStorage is shared with every other same origin script and
 * survives across sessions, so a row whose key names this leg is not proof
 * that its geometry does: a cache hit otherwise bypasses the fetch path
 * forever, and a bad entry would never heal.
 *
 * @param {{lat: number, lng: number}} a Start stop.
 * @param {{lat: number, lng: number}} b End stop.
 * @param {string} mode Leg mode.
 * @returns {{coords: Array<number[]>, km: number}|null} The cached route, or null.
 */
export function cachedRoad(a, b, mode) {
  const key = roadKey(a, b, mode);
  if (!key) return null;
  hydrate();
  const value = memory.get(key);
  if (!value) return null;
  if (!roadFitsLeg(value.coords, value.km, a, b)) {
    memory.delete(key);
    rejected.add(key);
    persist();
    return null;
  }
  // Touch it so the least recently used entry is the one that gets dropped.
  memory.delete(key);
  memory.set(key, value);
  return value;
}

/**
 * Put a road into the cache, in memory and in localStorage.
 * @param {string} key A key from roadKey.
 * @param {{coords: Array<number[]>, km: number}} value Road geometry.
 * @returns {void}
 */
export function storeRoad(key, value) {
  if (typeof key !== 'string' || !key) return;
  if (!entryIsSane(value)) return;
  hydrate();
  rejected.delete(key);
  if (memory.has(key)) memory.delete(key);
  memory.set(key, { coords: value.coords, km: value.km });
  while (memory.size > CACHE_MAX) memory.delete(memory.keys().next().value);
  persist();
}
