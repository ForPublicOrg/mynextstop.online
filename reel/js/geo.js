/**
 * geo.js
 * Web Mercator math and leg path building for the reel renderer.
 *
 * World units: at zoom 0 the whole world is a 1.0 x 1.0 square. The pixel
 * scale at fractional zoom z is `256 * 2 ** z` pixels per world unit.
 *
 * Longitudes are unwrapped, never wrapped. A path that crosses the
 * antimeridian keeps growing past x = 1 (or below x = 0) so the camera can
 * follow it without ever jumping across the world.
 *
 * No DOM access. Pure functions only.
 */

/** Latitude limit of the Web Mercator projection, in degrees. */
export const MAX_MERCATOR_LAT = 85.05112877980659;

/** Number of segments used to sample one leg path. */
export const LEG_SEGMENTS = 128;

/** Number of sampled points per leg path (segments + 1). */
export const LEG_POINTS = LEG_SEGMENTS + 1;

const DEG = Math.PI / 180;
const EARTH_RADIUS_KM = 6371.0088;

/** Bow of the fallback plane arc, as a fraction of chord length. */
const PLANE_BOW = 0.1;

/** Bow of ground leg arcs, as a fraction of chord length. */
const GROUND_BOW = 0.12;

/**
 * A great circle flatter than this fraction of its own chord is considered
 * visually straight, so a hand made bow replaces it.
 */
const FLAT_GREAT_CIRCLE = 0.02;

/**
 * Project a longitude and latitude to Web Mercator world units.
 * Longitude is not wrapped: a value of 237.58 returns x = 1.16, which is what
 * keeps antimeridian routes continuous.
 * @param {number} lon Longitude in degrees, may fall outside [-180, 180].
 * @param {number} lat Latitude in degrees, clamped to the Mercator limit.
 * @returns {{x: number, y: number}} World unit position.
 */
export function lonLatToWorld(lon, lat) {
  const safeLat = lat > MAX_MERCATOR_LAT
    ? MAX_MERCATOR_LAT
    : (lat < -MAX_MERCATOR_LAT ? -MAX_MERCATOR_LAT : lat);
  const s = Math.sin(safeLat * DEG);
  return {
    x: (lon + 180) / 360,
    y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
  };
}

/**
 * Great circle distance between two points, in kilometres.
 * @param {{lat: number, lng: number}} a First point.
 * @param {{lat: number, lng: number}} b Second point.
 * @returns {number} Distance in kilometres.
 */
export function haversineKm(a, b) {
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lng - a.lng) * DEG;
  const sLat = Math.sin(dLat / 2);
  const sLon = Math.sin(dLon / 2);
  const h = sLat * sLat + Math.cos(lat1) * Math.cos(lat2) * sLon * sLon;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(Math.max(0, h))));
}

/**
 * Symmetric cubic ease, used for every camera move.
 * @param {number} p Progress, clamped to [0, 1].
 * @returns {number} Eased progress.
 */
export function easeInOutCubic(p) {
  const t = p <= 0 ? 0 : (p >= 1 ? 1 : p);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Gentle sine ease, used for vehicle travel along a leg.
 * @param {number} p Progress, clamped to [0, 1].
 * @returns {number} Eased progress.
 */
export function easeInOutSine(p) {
  const t = p <= 0 ? 0 : (p >= 1 ? 1 : p);
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/**
 * Overshooting ease used for pin pops. Peaks near 1.10 around p = 0.7.
 * @param {number} p Progress, clamped to [0, 1].
 * @returns {number} Eased progress, may exceed 1 before settling.
 */
export function easeOutBack(p) {
  const t = p <= 0 ? 0 : (p >= 1 ? 1 : p);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const k = t - 1;
  return 1 + c3 * k * k * k + c1 * k * k;
}

/**
 * Shift `lon` by whole turns so it lands within 180 degrees of `ref`.
 *
 * The reduction is a single fmod rather than a loop: a corrupt coordinate of
 * 1e21 would otherwise spin forever, because subtracting 360 from a float that
 * large is a no op.
 *
 * @param {number} ref Reference longitude in degrees.
 * @param {number} lon Longitude to unwrap.
 * @returns {number} Unwrapped longitude.
 */
function unwrapLon(ref, lon) {
  const raw = lon - ref;
  if (!Number.isFinite(raw)) return ref;
  let d = ((raw % 360) + 540) % 360 - 180;
  // Keep an exact half turn pointing the way it was handed in.
  if (d === -180 && raw > 0) d = 180;
  return ref + d;
}

/**
 * Clamp a coordinate pair into the range the projection can express.
 *
 * Defense in depth for a hand edited or corrupted draft: a non-finite value
 * becomes 0, latitude is clamped to the Mercator limit, and longitude is folded
 * into [-180, 180) so no downstream loop or projection ever sees an absurd
 * magnitude.
 *
 * @param {{lat: number, lng: number}} point A stop like object.
 * @returns {{lat: number, lng: number}} A safe copy.
 */
export function safeLatLng(point) {
  const src = point || {};
  let lat = Number(src.lat);
  let lng = Number(src.lng);
  if (!Number.isFinite(lat)) lat = 0;
  if (!Number.isFinite(lng)) lng = 0;
  if (lat > MAX_MERCATOR_LAT) lat = MAX_MERCATOR_LAT;
  else if (lat < -MAX_MERCATOR_LAT) lat = -MAX_MERCATOR_LAT;
  lng = ((lng % 360) + 540) % 360 - 180;
  return { lat: lat, lng: lng };
}

/**
 * Unit sphere vector for a geographic position.
 * @param {number} lat Latitude in degrees.
 * @param {number} lon Longitude in degrees.
 * @returns {{x: number, y: number, z: number}} Unit vector.
 */
function unitVec(lat, lon) {
  const la = lat * DEG;
  const lo = lon * DEG;
  const c = Math.cos(la);
  return { x: c * Math.cos(lo), y: c * Math.sin(lo), z: Math.sin(la) };
}

/**
 * Sample a great circle between two positions as world unit points.
 * Returns null when the two points are coincident or antipodal, where the
 * great circle is not uniquely defined.
 * @param {number} latA Start latitude.
 * @param {number} lonA Start longitude, already unwrapped.
 * @param {number} latB End latitude.
 * @param {number} lonB End longitude, already unwrapped relative to lonA.
 * @returns {Array<{x: number, y: number}>|null} Sampled points, or null.
 */
function greatCirclePoints(latA, lonA, latB, lonB) {
  const a = unitVec(latA, lonA);
  const b = unitVec(latB, lonB);
  let dot = a.x * b.x + a.y * b.y + a.z * b.z;
  if (dot > 1) dot = 1;
  if (dot < -1) dot = -1;
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  if (sinOmega < 1e-9) return null;

  const pts = new Array(LEG_POINTS);
  let prevLon = lonA;
  for (let i = 0; i < LEG_POINTS; i++) {
    const f = i / LEG_SEGMENTS;
    const s0 = Math.sin((1 - f) * omega) / sinOmega;
    const s1 = Math.sin(f * omega) / sinOmega;
    const vx = a.x * s0 + b.x * s1;
    const vy = a.y * s0 + b.y * s1;
    const vz = a.z * s0 + b.z * s1;
    const lat = Math.atan2(vz, Math.sqrt(vx * vx + vy * vy)) / DEG;
    const lon = unwrapLon(prevLon, Math.atan2(vy, vx) / DEG);
    prevLon = lon;
    pts[i] = lonLatToWorld(lon, lat);
  }
  // Pin the ends to the exact inputs so joins between legs are seamless.
  pts[0] = lonLatToWorld(lonA, latA);
  pts[LEG_POINTS - 1] = lonLatToWorld(lonB, latB);
  return pts;
}

/**
 * Largest perpendicular distance from the sampled points to their own chord.
 * @param {Array<{x: number, y: number}>} pts Sampled points.
 * @returns {number} Deviation in world units.
 */
function maxChordDeviation(pts) {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-12) return 0;
  let worst = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const d = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * Sample a quadratic bezier whose control point bows away from the chord.
 * The bow always points up on screen, meaning towards negative y.
 * @param {{x: number, y: number}} p0 Start point in world units.
 * @param {{x: number, y: number}} p1 End point in world units.
 * @param {number} bow Bow height as a fraction of chord length.
 * @returns {Array<{x: number, y: number}>} Sampled points.
 */
function bezierPoints(p0, p1, bow) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.sqrt(dx * dx + dy * dy);

  if (len < 1e-12) {
    // Two stops on the same spot. Emit an exactly degenerate path so the
    // cumulative length is a true zero and the renderer takes its guarded
    // branch instead of chasing rounding noise for a heading.
    const flat = new Array(LEG_POINTS);
    for (let i = 0; i < LEG_POINTS; i++) flat[i] = { x: p0.x, y: p0.y };
    return flat;
  }

  let nx;
  let ny;
  {
    nx = -dy / len;
    ny = dx / len;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    } else if (ny === 0 && nx < 0) {
      // Vertical chord: no up or down choice exists, so bow right for a
      // stable, repeatable result.
      nx = -nx;
    }
  }

  const off = bow * len;
  const cx = (p0.x + p1.x) / 2 + nx * off;
  const cy = (p0.y + p1.y) / 2 + ny * off;

  const pts = new Array(LEG_POINTS);
  for (let i = 0; i < LEG_POINTS; i++) {
    const t = i / LEG_SEGMENTS;
    const it = 1 - t;
    const a = it * it;
    const b = 2 * it * t;
    const c = t * t;
    pts[i] = { x: a * p0.x + b * cx + c * p1.x, y: a * p0.y + b * cy + c * p1.y };
  }
  pts[0] = { x: p0.x, y: p0.y };
  pts[LEG_POINTS - 1] = { x: p1.x, y: p1.y };
  return pts;
}

/**
 * Build the drawable path for one leg of a trip.
 *
 * The end longitude is first unwrapped to within 180 degrees of the start, and
 * every sampled x stays continuous from there, so a Tokyo to San Francisco leg
 * runs eastward past x = 1 instead of snapping back across the map.
 *
 * Plane legs use a great circle. When that great circle is visually flat, less
 * than 2 percent of its chord, a 10 percent bezier bow replaces it so short and
 * equatorial flights still arc. Ground legs always use a 12 percent bow.
 *
 * @param {{lat: number, lng: number}} a Start stop.
 * @param {{lat: number, lng: number}} b End stop.
 * @param {string} mode One of 'plane', 'car', 'train', 'boat', 'bike'.
 * @returns {{pts: Array<{x: number, y: number}>, cum: Float64Array, len: number, km: number}}
 *   Sampled points, cumulative arc length per point, total length in world
 *   units, and the great circle distance in kilometres.
 */
export function buildLegPath(a, b, mode) {
  const sa = safeLatLng(a);
  const sb = safeLatLng(b);
  const lonA = sa.lng;
  const lonB = unwrapLon(lonA, sb.lng);
  const p0 = lonLatToWorld(lonA, sa.lat);
  const p1 = lonLatToWorld(lonB, sb.lat);

  let pts = null;
  if (mode === 'plane') {
    const gc = greatCirclePoints(sa.lat, lonA, sb.lat, lonB);
    if (gc) {
      const chord = Math.sqrt((p1.x - p0.x) * (p1.x - p0.x) + (p1.y - p0.y) * (p1.y - p0.y));
      if (maxChordDeviation(gc) >= FLAT_GREAT_CIRCLE * chord) pts = gc;
    }
  }
  if (!pts) pts = bezierPoints(p0, p1, mode === 'plane' ? PLANE_BOW : GROUND_BOW);

  const cum = new Float64Array(LEG_POINTS);
  for (let i = 1; i < LEG_POINTS; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }

  return { pts, cum, len: cum[LEG_POINTS - 1], km: haversineKm(sa, sb), kind: 'arc' };
}

/* -------------------------------------------------------------- road paths */

/**
 * Zoom levels the road simplification tiers are tuned for. The tolerance of a
 * tier is the world unit size of 0.75 screen pixels at that zoom.
 */
const ROAD_LEVEL_ZOOMS = [4, 6, 8, 10];

/** Point budget bounds for a resampled road path. */
const ROAD_MIN_POINTS = 128;
const ROAD_MAX_POINTS = 768;

/**
 * Douglas-Peucker on a polyline, returned as the indices that survive.
 *
 * The distance test is to the segment rather than to the infinite line, which
 * matters on switchbacks: a hairpin that doubles back would otherwise measure
 * as near zero deviation from a line it is nowhere near.
 *
 * Runs on an explicit stack, so a ten thousand point trace cannot blow the call
 * stack on a pathological input.
 *
 * The output is nested in the tolerance: a larger tolerance always returns a
 * subset of what a smaller one returns, because the same split test decides the
 * recursion in both. That is what lets the renderer treat the tiers as levels
 * of detail over one shared point array.
 *
 * @param {Array<{x: number, y: number}>} pts Polyline points.
 * @param {number} tolerance Maximum deviation, in the same units as the points.
 * @returns {number[]} Ascending indices into pts, always including both ends.
 */
export function douglasPeuckerIndices(pts, tolerance) {
  const n = pts.length;
  if (n <= 2) {
    const all = [];
    for (let i = 0; i < n; i++) all.push(i);
    return all;
  }

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = Math.max(0, tolerance) * Math.max(0, tolerance);
  const stack = [0, n - 1];

  while (stack.length) {
    const last = stack.pop();
    const first = stack.pop();
    if (last - first < 2) continue;

    const a = pts[first];
    const b = pts[last];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dd = dx * dx + dy * dy;

    let bestI = -1;
    let bestD = -1;
    for (let i = first + 1; i < last; i++) {
      const p = pts[i];
      let ex;
      let ey;
      if (dd > 0) {
        let u = ((p.x - a.x) * dx + (p.y - a.y) * dy) / dd;
        if (u < 0) u = 0;
        else if (u > 1) u = 1;
        ex = a.x + dx * u - p.x;
        ey = a.y + dy * u - p.y;
      } else {
        ex = p.x - a.x;
        ey = p.y - a.y;
      }
      const d = ex * ex + ey * ey;
      if (d > bestD) {
        bestD = d;
        bestI = i;
      }
    }

    if (bestI > 0 && bestD > tol2) {
      keep[bestI] = 1;
      stack.push(first, bestI, bestI, last);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Cumulative arc length of a point list.
 * @param {Array<{x: number, y: number}>} pts Points.
 * @returns {Float64Array} Cumulative length per point, starting at zero.
 */
function cumulative(pts) {
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  return cum;
}

/**
 * Resample a polyline to evenly spaced points along its own arc length.
 *
 * Even spacing is what makes the draw-on read as steady driving: the trail
 * grows the same distance every frame no matter how the source trace bunched
 * its vertices around junctions.
 *
 * @param {Array<{x: number, y: number}>} pts Source points.
 * @param {number} n Output point count, at least two.
 * @returns {Array<{x: number, y: number}>} Fresh points, never shared with pts.
 */
function resampleUniform(pts, n) {
  const cum = cumulative(pts);
  const total = cum[cum.length - 1];
  const out = new Array(n);

  if (!(total > 0)) {
    for (let i = 0; i < n; i++) out[i] = { x: pts[0].x, y: pts[0].y };
    return out;
  }

  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = total * (i / (n - 1));
    while (j < pts.length - 2 && cum[j + 1] < target) j++;
    const segLen = cum[j + 1] - cum[j];
    const s = segLen > 1e-15 ? (target - cum[j]) / segLen : 0;
    out[i] = {
      x: pts[j].x + (pts[j + 1].x - pts[j].x) * s,
      y: pts[j].y + (pts[j + 1].y - pts[j].y) * s
    };
  }
  out[0] = { x: pts[0].x, y: pts[0].y };
  out[n - 1] = { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  return out;
}

/**
 * Build the drawable path for a leg that follows a real road.
 *
 * Same shape as buildLegPath, plus `levels`: four progressively coarser
 * simplifications of the same points, each carrying its own cumulative lengths
 * so a partly drawn trail stays arc-length correct whichever one the renderer
 * picks. Level points are the very same objects as the base points, which keeps
 * memory flat and lets a caller translate the whole path by walking `pts` alone.
 *
 * The first and last points are pinned to the stops themselves rather than to
 * the router's snapped ends, so pins, chips and the route always agree and
 * switching between road and stylized shapes never moves a pin.
 *
 * @param {{lat: number, lng: number}} a Start stop.
 * @param {{lat: number, lng: number}} b End stop.
 * @param {{coords: Array<number[]>, km: number}} road A road from routes.js.
 * @returns {{pts: Array<{x: number, y: number}>, cum: Float64Array, len: number,
 *   km: number, kind: string, levels: Array<{maxErr: number, pts: Array<{x: number, y: number}>,
 *   cum: Float64Array, len: number}>}} A road path.
 */
export function buildRoadPath(a, b, road) {
  const sa = safeLatLng(a);
  const sb = safeLatLng(b);
  const coords = (road && Array.isArray(road.coords)) ? road.coords : [];

  // Project the trace, unwrapping each longitude against the one before it so
  // a road that crosses the antimeridian keeps one continuous set of x values.
  const raw = [lonLatToWorld(sa.lng, sa.lat)];
  let prevLon = sa.lng;
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    if (!c || c.length < 2) continue;
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const lon = unwrapLon(prevLon, lng);
    prevLon = lon;
    const p = lonLatToWorld(lon, lat);
    const last = raw[raw.length - 1];
    if (Math.abs(p.x - last.x) < 1e-12 && Math.abs(p.y - last.y) < 1e-12) continue;
    raw.push(p);
  }
  const endLon = unwrapLon(prevLon, sb.lng);
  const end = lonLatToWorld(endLon, sb.lat);
  const tail = raw[raw.length - 1];
  if (Math.abs(end.x - tail.x) >= 1e-12 || Math.abs(end.y - tail.y) >= 1e-12) raw.push(end);
  if (raw.length < 2) raw.push({ x: raw[0].x, y: raw[0].y });

  const routerKm = (road && Number.isFinite(road.km) && road.km >= 0)
    ? road.km
    : haversineKm(sa, sb);

  let n = Math.round(96 + routerKm / 3);
  if (!Number.isFinite(n)) n = ROAD_MIN_POINTS;
  n = n < ROAD_MIN_POINTS ? ROAD_MIN_POINTS : (n > ROAD_MAX_POINTS ? ROAD_MAX_POINTS : n);

  const pts = resampleUniform(raw, n);
  const cum = cumulative(pts);

  // Coarsest tier first, so the renderer can take the first tier whose error
  // budget fits the current scale and stop looking.
  //
  // A tier's cumulative lengths are the base path's at the points it kept,
  // not the lengths of its own chords. The vehicle is placed by fraction of
  // the base path, and the trail is stroked by fraction of whichever tier is
  // drawn; measuring the tier's shorter chords would put the tip of the trail
  // behind the vehicle by however much length the dropped bends held, and
  // have it jump whenever the camera crossed a tier threshold.
  const levels = [];
  for (let i = 0; i < ROAD_LEVEL_ZOOMS.length; i++) {
    const maxErr = 0.75 / (256 * Math.pow(2, ROAD_LEVEL_ZOOMS[i]));
    const idx = douglasPeuckerIndices(pts, maxErr);
    const lpts = new Array(idx.length);
    const lcum = new Float64Array(idx.length);
    for (let k = 0; k < idx.length; k++) {
      lpts[k] = pts[idx[k]];
      lcum[k] = cum[idx[k]];
    }
    levels.push({
      maxErr: maxErr,
      pts: lpts,
      cum: lcum,
      len: lcum[lcum.length - 1]
    });
  }

  return {
    pts: pts,
    cum: cum,
    len: cum[cum.length - 1],
    km: routerKm,
    kind: 'road',
    levels: levels
  };
}

/**
 * Position and heading at a fraction of a path, parameterised by arc length so
 * the vehicle moves at an even speed along curved legs.
 * @param {{pts: Array<{x: number, y: number}>, cum: Float64Array, len: number}} path
 *   A path from buildLegPath.
 * @param {number} f Fraction along the path, clamped to [0, 1].
 * @returns {{x: number, y: number, angle: number}} World position and the
 *   local tangent angle in screen aligned radians.
 */
export function pathPointAt(path, f) {
  const pts = path.pts;
  const cum = path.cum;
  const n = pts.length;
  const total = cum[n - 1];

  if (!(total > 0)) {
    return { x: pts[0].x, y: pts[0].y, angle: 0 };
  }

  const ff = f <= 0 ? 0 : (f >= 1 ? 1 : f);
  const target = ff * total;

  // Last index whose cumulative length is at or below the target.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  let i = lo;
  if (i > n - 2) i = n - 2;

  const segLen = cum[i + 1] - cum[i];
  const s = segLen > 1e-15 ? (target - cum[i]) / segLen : 0;
  const a = pts[i];
  const b = pts[i + 1];

  // A zero length segment carries no heading, so look outward for one.
  let ai = i;
  while (ai < n - 2 && cum[ai + 1] - cum[ai] <= 1e-15) ai++;
  while (ai > 0 && cum[ai + 1] - cum[ai] <= 1e-15) ai--;
  const ta = pts[ai];
  const tb = pts[ai + 1];

  return {
    x: a.x + (b.x - a.x) * s,
    y: a.y + (b.y - a.y) * s,
    angle: Math.atan2(tb.y - ta.y, tb.x - ta.x)
  };
}
