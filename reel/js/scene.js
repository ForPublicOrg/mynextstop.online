/**
 * scene.js
 * Camera, timeline and renderer for the reel. This is the facade the UI and the
 * exporter both talk to.
 *
 * Rendering is a pure function of time: renderFrame draws frame `t` with no
 * reference to the wall clock, so the preview and the export are identical.
 *
 * Drawing space is always `timeline.dims`. The caller sets a transform first,
 * for preview scaling or for the export canvas, and renderFrame never touches
 * it.
 */

import {
  lonLatToWorld,
  safeLatLng,
  haversineKm,
  buildLegPath,
  buildRoadPath,
  pathPointAt,
  easeInOutCubic,
  easeInOutSine,
  easeOutBack
} from './geo.js?v=e5';
import { roadKey } from './routes.js?v=e5';
import { composeTheme, roundRectPath } from './themes.js?v=e5';
import { MODE_META, drawVehicle } from './vehicles.js?v=e5';
import { modelFor, normalizeDesigns, drawModel, project, PX_PER_M } from './models.js?v=e5';

/** Frames per second for every timeline and export. */
export const FPS = 30;

/** The three export shapes. */
export const FORMATS = {
  '9x16': { w: 1080, h: 1920, label: 'Reels 9:16' },
  '1x1': { w: 1080, h: 1080, label: 'Square 1:1' },
  '16x9': { w: 1920, h: 1080, label: 'Wide 16:9' }
};

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';

/**
 * Camera floor. At 1.5 the whole world, all 360 degrees of it, fits inside
 * the padded width of a 1080 px frame, so a round the world trip can still be
 * framed whole at the outro. Tiles stop at zoom 2 and are drawn scaled down
 * below it.
 */
const ZOOM_MIN = 1.5;
const ZOOM_MAX = 11.5;
const HOLD_ZOOM_CAP = 9.8;
const HOLD_ZOOM_LIFT = 2;
const HOLD_ZOOM_FLOOR = 0.5;
const TRAVEL_ZOOM_BREATH = 0.12;

const SPEED_MULTIPLIER = { relaxed: 1.3, normal: 1, fast: 0.72 };

/**
 * Longest reel, in seconds. Reels, TikTok and Shorts all take ninety seconds
 * now, and only a trip with a great many stops gets anywhere near it.
 */
const MAX_DURATION = 90;

/**
 * The per leg choreography is never squeezed below this fraction of itself,
 * whatever the cap says. Past this point a leg is a blink, and a reel a little
 * over the cap beats one nobody can follow.
 */
const LEG_SQUEEZE_FLOOR = 0.25;

/** Base durations in seconds, at normal speed. */
const D_INTRO = 2;
const D_CAMOUT = 0.8;
const D_ARRIVE = 0.75;
const D_HOLD = 0.6;
const D_OUTRO_MOVE = 1;
// The closing shot of the whole trip. Long enough to read every stop while
// the camera drifts and a light runs the route; never squeezed by MAX_DURATION.
const D_OUTRO_HOLD = 4.2;
const OUTRO_DRIFT = 0.16;
const D_FREEZE = 0.4;
const D_POP = 0.45;
const D_CHIP_FADE = 0.3;
const D_PULSE = 0.6;
const D_VEHICLE_IN = 0.15;
const D_VEHICLE_OUT = 0.25;

const CHIP_MAX_CHARS = 24;
const ELLIPSIS = '…';

/**
 * Keep-out insets per format, in unit pixels, for every layer that has to stay
 * readable once the video is posted.
 *
 * On a phone taller than 16:9 the Reels player scales a 9:16 file up to fill
 * the screen height, which shaves a strip off each side; the top and bottom
 * are shown whole (checked on real uploads, Sep 2026). So the sides carry a
 * wide inset and the top and bottom only the margin the frame itself needs:
 * chips stay under the header line at the top, and the credits keep a small
 * edge margin at the bottom. Square and wide frames are not posted that way,
 * so they keep a modest margin all round.
 *
 * `rail` is the width of a right hand action column, measured from the right
 * edge, applied between half height and the bottom inset. Unused for now: the
 * uploads showed cropping, not covering, and a rail band pulls the route off
 * centre.
 */
const SAFE = {
  '9x16': { top: 180, bottom: 40, left: 120, right: 120, rail: 0 },
  '1x1': { top: 48, bottom: 40, left: 48, right: 48, rail: 0 },
  '16x9': { top: 48, bottom: 40, left: 48, right: 48, rail: 0 }
};

/** Height of the credit lines above their baseline, plus a gap, in unit pixels. */
const CREDIT_CLEAR = 36;

/**
 * Keep-out rectangles for a frame: the four edge bands and the action rail,
 * in drawing pixels. A label that touches any of them is off limits. The
 * bottom band is raised by the credits' own height so labels stay off them.
 *
 * @param {{w: number, h: number}} dims Frame size in pixels.
 * @param {{top: number, bottom: number, left: number, right: number, rail: number}} safe Insets in unit pixels.
 * @param {number} u Unit scale.
 * @returns {{left: number, top: number, w: number, h: number}[]} Rectangles.
 */
function keepOutRects(dims, safe, u) {
  const rects = [
    { left: 0, top: 0, w: dims.w, h: safe.top * u },
    { left: 0, top: dims.h - (safe.bottom + CREDIT_CLEAR) * u, w: dims.w, h: (safe.bottom + CREDIT_CLEAR) * u },
    { left: 0, top: 0, w: safe.left * u, h: dims.h },
    { left: dims.w - safe.right * u, top: 0, w: safe.right * u, h: dims.h }
  ];
  if (safe.rail > 0) {
    const top = dims.h * 0.5;
    rects.push({ left: dims.w - safe.rail * u, top: top, w: safe.rail * u, h: dims.h - safe.bottom * u - top });
  }
  return rects;
}

/**
 * Screen distance, in unit pixels, at or under which the route gradient is
 * anchored entirely across the route's own diagonal rather than from the route
 * start to the vehicle head.
 */
const GRADIENT_ANCHOR_NEAR = 24;

/**
 * Screen distance, in unit pixels, where that re-anchoring begins. Between the
 * two the anchors ease across on a smoothstep, so a closing loop never pops.
 * The ramp has to start well before the near distance: a start to head axis
 * only a few dozen pixels long already clamps most of the route to the end
 * colour, so switching late would still read as a jump.
 */
const GRADIENT_ANCHOR_FAR = 300;

/**
 * Screen error budget, in drawing space pixels, for picking a road detail tier.
 * The coarsest tier whose own tolerance stays under this at the current scale
 * is the one that gets drawn, so a zoomed out road sheds jitter while keeping
 * its corridor and a zoomed in road keeps every bend.
 */
const LEVEL_PX_BUDGET = 0.8;

/** Fraction of the drawn portion of a road leg that fades out at the tip. */
const FEATHER_FRACTION = 0.035;

/**
 * How straight the feather window has to run before it is painted.
 *
 * The tip fade is a linear gradient along the chord from the junction to the
 * head, and a canvas gradient colours each pixel by its projection onto that
 * chord. If the road doubles back inside the window, a switchback folded into
 * the last few percent, the far arm projects back towards the junction and the
 * fade inverts: the line fades out into the bend and back in after it, ending
 * at close to full opacity in a hard cap. Below this chord over arc length
 * ratio the window is shrunk to its own chord until it runs straight enough,
 * which keeps opacity falling all the way to the tip. A fold of ninety degrees
 * sits at 0.707, so this triggers a little before the fade can invert.
 */
const FEATHER_MIN_STRAIGHTNESS = 0.8;

/** How many times to shrink the feather window before giving up on it. */
const FEATHER_SHRINK_STEPS = 4;

/**
 * Chord window for a road vehicle's heading, as a screen distance either side
 * of the vehicle, in drawing space pixels.
 *
 * Roughly the length of the vehicle icon. Measured against real OSRM traces:
 * a leg is animated in around ninety frames, so a two hundred kilometre drive
 * covers two kilometres of road per frame and passes whole city junctions
 * between one frame and the next. A window smaller than the icon leaves the
 * worst frame of Delhi to Agra turning 57 degrees and Agra to Jaipur turning
 * 179 degrees, which is the spin this window exists to prevent. At this size
 * the same two legs peak at 12 degrees per frame.
 */
const HEADING_WINDOW_PX = 60;

/**
 * The window for deciding which way a ground vehicle faces, as a multiple of
 * the heading window. Facing is a binary, and a road running more or less
 * straight north would flip it on every wobble across vertical if it read
 * the same narrow window the heading does. A chord this long settles it.
 */
const FACING_WINDOW_MULT = 5;


const MODE_IDS = new Set(MODE_META.map(function (m) { return m.id; }));

/* ------------------------------------------------------------------ utils */

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function lerp(a, b, p) {
  return a + (b - a) * p;
}

/**
 * Scale applied to shadow sizes for the frame being drawn.
 *
 * Canvas 2D shadow attributes live in device space and ignore the current
 * transform, so a preview scaled to 0.35 would otherwise show glows three times
 * fatter than the export. renderFrame sets this once per frame and every shadow
 * in the module goes through it, which keeps preview and export identical.
 * Rendering is synchronous, so one module level value is safe.
 */
let shadowScale = 1;

/**
 * Read the horizontal scale of a context's current transform.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @returns {number} Scale factor, 1 when it cannot be determined.
 */
function transformScaleOf(ctx) {
  if (typeof ctx.getTransform !== 'function') return 1;
  let m = null;
  try {
    m = ctx.getTransform();
  } catch (err) {
    return 1;
  }
  const s = m && Number.isFinite(m.a) ? Math.abs(m.a) : 0;
  return s > 0 ? s : 1;
}

/**
 * Set shadow sizes in drawing space units, corrected for the frame transform.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {number} blur Blur radius in drawing space.
 * @param {number} offX Horizontal offset in drawing space.
 * @param {number} offY Vertical offset in drawing space.
 * @returns {void}
 */
function setShadow(ctx, blur, offX, offY) {
  ctx.shadowBlur = blur * shadowScale;
  ctx.shadowOffsetX = offX * shadowScale;
  ctx.shadowOffsetY = offY * shadowScale;
}

/**
 * Turn every shadow attribute off.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @returns {void}
 */
function clearShadow(ctx) {
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.shadowColor = 'transparent';
}

/**
 * Group a number with commas, rounded to a whole value.
 * @param {number} n Value.
 * @returns {string} For example '1,240'.
 */
function groupNumber(n) {
  const rounded = Math.round(Math.abs(n));
  const digits = String(rounded);
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits.charAt(i);
  }
  return (n < 0 ? '-' : '') + out;
}

/**
 * Trim a label to a character budget, adding a single character ellipsis.
 *
 * Counting is by code point, not by UTF-16 unit, so a label that ends on an
 * emoji is never cut through the middle of a surrogate pair and left rendering
 * a replacement box.
 *
 * @param {string} text Source label.
 * @param {number} max Maximum characters including the ellipsis.
 * @returns {string} Trimmed label.
 */
function ellipsize(text, max) {
  const s = String(text == null ? '' : text).trim();
  if (s.length <= max) return s;
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return cps.slice(0, max - 1).join('').replace(/\s+$/, '') + ELLIPSIS;
}

/**
 * Trim text to a measured width, adding an ellipsis when anything was dropped.
 * The context must already carry the font the text will be drawn with.
 * @param {CanvasRenderingContext2D} ctx Context with the final font set.
 * @param {string} text Source text.
 * @param {number} maxW Available width in drawing space.
 * @returns {string} Text that measures at or below maxW where possible.
 */
function truncateToWidth(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  const cps = Array.from(text);
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const width = ctx.measureText(cps.slice(0, mid).join('') + ELLIPSIS).width;
    if (width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  if (lo <= 0) return ELLIPSIS;
  return cps.slice(0, lo).join('').replace(/\s+$/, '') + ELLIPSIS;
}

/**
 * Rough perceived lightness test, used to pick a contrast shadow.
 * @param {string} color A hex or rgb/rgba color string.
 * @returns {boolean} True when the color reads as light.
 */
function isLightColor(color) {
  const c = String(color == null ? '' : color).trim();
  let r = 0;
  let g = 0;
  let b = 0;
  if (c.charAt(0) === '#') {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    const v = parseInt(hex.slice(0, 6), 16);
    if (isNaN(v)) return false;
    r = (v >> 16) & 255;
    g = (v >> 8) & 255;
    b = v & 255;
  } else {
    const m = c.match(/-?\d+(\.\d+)?/g);
    if (!m || m.length < 3) return false;
    r = Number(m[0]);
    g = Number(m[1]);
    b = Number(m[2]);
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}

/**
 * The red, green and blue of a colour string.
 *
 * Anything unparseable reads as black, which is what the callers want: a
 * missing theme colour should not throw mid frame.
 *
 * @param {string} color A hex or rgb/rgba colour string.
 * @returns {{r: number, g: number, b: number}} Channels in [0, 255].
 */
function rgbOf(color) {
  const c = String(color == null ? '' : color).trim();
  let r = 0;
  let g = 0;
  let b = 0;
  if (c.charAt(0) === '#') {
    let hex = c.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    }
    const v = parseInt(hex.slice(0, 6), 16);
    if (!isNaN(v)) {
      r = (v >> 16) & 255;
      g = (v >> 8) & 255;
      b = v & 255;
    }
  } else {
    const m = c.match(/-?\d*\.?\d+/g);
    if (m && m.length >= 3) {
      r = Math.round(Number(m[0])) || 0;
      g = Math.round(Number(m[1])) || 0;
      b = Math.round(Number(m[2])) || 0;
    }
  }
  return { r: r, g: g, b: b };
}

/**
 * The same colour at a different opacity.
 *
 * The feathered tip of a road fades to `withAlpha(colour, 0)` rather than to a
 * generic transparent, because a gradient that runs to transparent black would
 * dirty the last few pixels of a light coloured route on its way out.
 *
 * @param {string} color A hex or rgb/rgba colour string.
 * @param {number} alpha Target opacity in [0, 1].
 * @returns {string} An rgba() string.
 */
function withAlpha(color, alpha) {
  const c = rgbOf(color);
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
}

/**
 * A colour part way between two others, mixed in RGB.
 *
 * This is the same interpolation a canvas linear gradient performs between two
 * stops, so sampling a gradient at a point and painting that colour there
 * leaves no seam.
 *
 * @param {string} a Colour at p = 0.
 * @param {string} b Colour at p = 1.
 * @param {number} p Blend position, clamped to [0, 1].
 * @returns {string} An rgb() string.
 */
function mixColor(a, b, p) {
  const ca = rgbOf(a);
  const cb = rgbOf(b);
  const k = clamp01(p);
  return 'rgb(' +
    Math.round(lerp(ca.r, cb.r, k)) + ',' +
    Math.round(lerp(ca.g, cb.g, k)) + ',' +
    Math.round(lerp(ca.b, cb.b, k)) + ')';
}

/**
 * Where a point falls along a gradient axis.
 *
 * Canvas clamps a linear gradient to its end stops outside the axis, so this
 * clamps too and the two agree everywhere.
 *
 * @param {number} ax Axis start x, in pixels.
 * @param {number} ay Axis start y, in pixels.
 * @param {number} bx Axis end x, in pixels.
 * @param {number} by Axis end y, in pixels.
 * @param {number} px Point x, in pixels.
 * @param {number} py Point y, in pixels.
 * @returns {number} Position along the axis in [0, 1].
 */
function axisParam(ax, ay, bx, by, px, py) {
  const dx = bx - ax;
  const dy = by - ay;
  const d2 = dx * dx + dy * dy;
  if (!(d2 > 0)) return 0;
  return clamp01(((px - ax) * dx + (py - ay) * dy) / d2);
}

/**
 * Axis aligned bounds of a list of world points.
 * @param {Array<{x: number, y: number}>} pts Points.
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}} Bounds.
 */
function boundsOf(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}

/* ----------------------------------------------------------------- camera */

/**
 * Camera that frames a world bounds inside padded dimensions.
 *
 * Screen mapping is `sx = (wx - cx) * 256 * 2 ** zoom + dims.w / 2`. The centre
 * offsets shift the framed content so it sits inside the padding rather than in
 * the middle of the canvas.
 *
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} bounds World bounds.
 * @param {{w: number, h: number}} dims Drawing space size.
 * @param {{top: number, right: number, bottom: number, left: number}} pad Padding in pixels.
 * @returns {{cx: number, cy: number, zoom: number}} A camera.
 */
function fitZoom(bounds, dims, pad) {
  const dx = Math.max(1e-7, bounds.maxX - bounds.minX);
  const dy = Math.max(1e-7, bounds.maxY - bounds.minY);
  const availW = Math.max(1, dims.w - pad.left - pad.right);
  const availH = Math.max(1, dims.h - pad.top - pad.bottom);
  const zoom = clamp(
    Math.log2(Math.min(availW / (dx * 256), availH / (dy * 256))),
    ZOOM_MIN,
    ZOOM_MAX
  );
  const scale = 256 * Math.pow(2, zoom);
  return {
    cx: (bounds.minX + bounds.maxX) / 2 - (pad.left - pad.right) / (2 * scale),
    cy: (bounds.minY + bounds.maxY) / 2 - (pad.top - pad.bottom) / (2 * scale),
    zoom: zoom
  };
}

/**
 * The camera at a point in time.
 * @param {object} tl A timeline from buildTimeline.
 * @param {number} t Seconds.
 * @returns {{cx: number, cy: number, zoom: number}} Interpolated camera.
 */
function cameraAt(tl, t) {
  const segs = tl.segments;
  let seg = segs[segs.length - 1];
  for (let i = 0; i < segs.length; i++) {
    if (t < segs[i].t1) {
      seg = segs[i];
      break;
    }
  }
  const span = Math.max(1e-6, seg.t1 - seg.t0);
  const p = clamp01((t - seg.t0) / span);

  if (seg.kind === 'move') {
    const e = easeInOutCubic(p);
    return {
      cx: lerp(seg.from.cx, seg.to.cx, e),
      cy: lerp(seg.from.cy, seg.to.cy, e),
      zoom: lerp(seg.from.zoom, seg.to.zoom, e)
    };
  }
  if (seg.kind === 'travel') {
    return {
      cx: seg.cam.cx,
      cy: seg.cam.cy,
      zoom: seg.cam.zoom - TRAVEL_ZOOM_BREATH * Math.sin(Math.PI * p)
    };
  }
  const drift = seg.drift ? seg.drift * (seg.settled ? 1 : easeInOutSine(p)) : 0;
  return { cx: seg.cam.cx, cy: seg.cam.cy, zoom: seg.cam.zoom + drift };
}

/* --------------------------------------------------------------- timeline */

/**
 * Total great circle distance across a list of stops.
 * @param {Array<{lat: number, lng: number}>} stops Stops in order.
 * @returns {number} Kilometres.
 */
export function totalKm(stops) {
  const list = Array.isArray(stops) ? stops : [];
  let sum = 0;
  for (let i = 1; i < list.length; i++) sum += haversineKm(list[i - 1], list[i]);
  return sum;
}

/**
 * The path for one leg: a real road when the project carries one, else the
 * stylized arc.
 *
 * A road that fails to build for any reason falls back to the arc rather than
 * taking the timeline down with it. Road geometry arrives over the network, so
 * it is never trusted to be well formed.
 *
 * @param {object} a Start stop.
 * @param {object} b End stop.
 * @param {string} mode Leg mode.
 * @param {object|null} roads Map of road key to { coords, km }, may be null.
 * @returns {object} A path from buildRoadPath or buildLegPath.
 */
function legPathFor(a, b, mode, roads) {
  if (roads) {
    const key = roadKey(a, b, mode);
    const road = key ? roads[key] : null;
    if (road && Array.isArray(road.coords) && road.coords.length >= 2) {
      try {
        const path = buildRoadPath(a, b, road);
        if (path && path.pts.length >= 2 && path.len > 0) return path;
      } catch (err) {
        // Fall through to the arc.
      }
    }
  }
  return buildLegPath(a, b, mode);
}

/**
 * Build the full animation plan for a project.
 *
 * Stop positions are chained through the leg paths rather than projected
 * independently, so a route that crosses the antimeridian keeps one continuous
 * set of world coordinates and the camera never jumps across the map.
 *
 * An optional `project.roads` maps a routes.js road key to `{ coords, km }`.
 * Drive and ride legs with an entry follow the real road, and take their
 * distance and their travel duration from the router's kilometres. Every other
 * leg is built exactly as before.
 *
 * @param {object} project A Project: stops, modes, themeId, format, speed,
 *   title, and optionally roads.
 * @returns {object} A timeline. Treat it as read only.
 * @throws {Error} 'need-stops' when there are fewer than two stops.
 */
export function buildTimeline(project) {
  const p = project || {};
  const stops = Array.isArray(p.stops) ? p.stops : [];
  if (stops.length < 2) throw new Error('need-stops');

  const theme = composeTheme(p.themeId, p.mapId);
  const is3d = p.view === '3d';
  const format = FORMATS[p.format] ? p.format : '9x16';
  const dims = { w: FORMATS[format].w, h: FORMATS[format].h };
  const u = Math.min(dims.w, dims.h) / 1080;
  const safe = SAFE[format];
  const speed = SPEED_MULTIPLIER[p.speed] || 1;
  const modes = Array.isArray(p.modes) ? p.modes : [];

  // Camera padding: the route itself never enters a keep-out band, with room
  // for the pin on top. Today every inset sits inside the percentages, so
  // this only matters if SAFE grows.
  const clear = 40 * u;
  const pad = {
    top: Math.max(dims.h * 0.14, safe.top * u + clear),
    bottom: Math.max(dims.h * 0.22, safe.bottom * u + clear),
    left: Math.max(dims.w * 0.16, safe.left * u + clear),
    right: Math.max(dims.w * 0.16, Math.max(safe.right, safe.rail) * u + clear)
  };

  // Legs, with world coordinates chained so longitudes stay continuous. The
  // first stop is clamped the same way buildLegPath clamps every other one, so
  // one corrupt draft coordinate cannot poison the whole chain.
  const roads = (p.roads && typeof p.roads === 'object') ? p.roads : null;

  const first = safeLatLng(stops[0]);
  const world = [lonLatToWorld(first.lng, first.lat)];
  const legs = [];
  const everyPoint = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const mode = MODE_IDS.has(modes[i]) ? modes[i] : 'car';
    const path = legPathFor(stops[i], stops[i + 1], mode, roads);
    // Detail levels hold the very same point objects as the base path, so one
    // pass over pts translates the whole path, levels included. Translating
    // twice would drag the coarse tiers off the road.
    const shift = world[i].x - path.pts[0].x;
    if (shift !== 0) {
      for (let k = 0; k < path.pts.length; k++) path.pts[k].x += shift;
    }
    const last = path.pts[path.pts.length - 1];
    world.push({ x: last.x, y: last.y });
    legs.push({ mode: mode, km: path.km, path: path, fit: fitZoom(boundsOf(path.pts), dims, pad) });
    for (let k = 0; k < path.pts.length; k++) everyPoint.push(path.pts[k]);
  }
  const allBounds = boundsOf(everyPoint);
  const fitAll = fitZoom(allBounds, dims, pad);

  // Resting camera over each stop, pulled in from the leg that reaches it.
  const holds = world.map(function (w, s) {
    const baseZoom = legs[Math.max(0, s - 1)].fit.zoom;
    let z = Math.min(baseZoom + HOLD_ZOOM_LIFT, HOLD_ZOOM_CAP);
    if (z < baseZoom + HOLD_ZOOM_FLOOR) z = baseZoom + HOLD_ZOOM_FLOOR;
    return { cx: w.x, cy: w.y, zoom: clamp(z, ZOOM_MIN, ZOOM_MAX) };
  });

  // Durations.
  const legCount = legs.length;
  let travel = legs.map(function (leg) {
    const raw = leg.mode === 'plane'
      ? clamp(1.4 + leg.km / 2500, 1.8, 3.4)
      : clamp(1.4 + leg.km / 800, 1.8, 3.2);
    return raw * speed;
  });
  let camOutDur = D_CAMOUT * speed;
  let arriveDur = D_ARRIVE * speed;
  let holdDur = D_HOLD * speed;
  let outroHoldDur = D_OUTRO_HOLD * speed;

  const introDur = D_INTRO * speed;
  const outroMoveDur = (is3d ? OUTRO_MOVE_3D : D_OUTRO_MOVE) * speed;
  const freezeDur = D_FREEZE * speed;

  // The opening and closing beats are fixed. Everything per leg, the pull
  // out, the travel, the arrival and the hold, gives way together by one
  // factor when the trip would run past the cap, so a thirty stop reel keeps
  // the rhythm of a three stop one, only quicker. Squeezing only the travel
  // and the hold, as this once did, left the pull out and arrival alone, and
  // those two by themselves overran the cap past twenty legs.
  const fixed = introDur + outroMoveDur + outroHoldDur + freezeDur;
  let flex = legCount * (camOutDur + arriveDur + holdDur);
  for (let i = 0; i < travel.length; i++) flex += travel[i];
  if (fixed + flex > MAX_DURATION && flex > 0) {
    const k = Math.max(LEG_SQUEEZE_FLOOR, (MAX_DURATION - fixed) / flex);
    if (k < 1) {
      travel = travel.map(function (v) { return v * k; });
      camOutDur *= k;
      arriveDur *= k;
      holdDur *= k;
    }
  }

  // Segments and events.
  const segments = [];
  const legTimes = [];
  const pinPop = new Array(stops.length).fill(0);
  const chipIn = new Array(stops.length).fill(0);
  const chipOut = new Array(stops.length).fill(null);

  // The tilted camera rides along each leg, so its resting views carry a
  // bearing (the way the next leg sets off) and a pitch as well.
  let holds3 = null;
  let wide3 = null;
  if (is3d) {
    for (let i = 0; i < legCount; i++) {
      legs[i].follow = clamp(Math.min(legs[i].fit.zoom + FOLLOW_LIFT, holds[i + 1].zoom), ZOOM_MIN, ZOOM_MAX);
    }
    holds3 = holds.map(function (h, s) {
      return {
        cx: h.cx,
        cy: h.cy,
        zoom: h.zoom,
        pitch: PITCH_HOLD,
        bearing: legBearing(legs[Math.max(0, s - 1)])
      };
    });
    // The closing shot is the flat overview itself: straight down, north up.
    wide3 = { cx: fitAll.cx, cy: fitAll.cy, zoom: fitAll.zoom, pitch: 0, bearing: 0 };
  }
  const follow3 = function (i, f) {
    if (!is3d) return null;
    // The same centre camera3At rides during travel, so the hand-over is seamless.
    const pt = glideCentre(legs[i], f);
    return { cx: pt.x, cy: pt.y, zoom: legs[i].follow, pitch: PITCH_FOLLOW, bearing: legBearing(legs[i]) };
  };

  segments.push({ kind: 'static', t0: 0, t1: introDur, cam: holds[0], a3: is3d ? holds3[0] : null, spin: [-ORBIT_INTRO, 0] });
  pinPop[0] = 0.9 * speed;
  chipIn[0] = 1.1 * speed;

  let cursor = introDur;
  for (let i = 0; i < legCount; i++) {
    const camOut0 = cursor;
    const travel0 = camOut0 + camOutDur;
    const travel1 = travel0 + travel[i];
    const arrive1 = travel1 + arriveDur;
    const hold1 = arrive1 + holdDur;

    segments.push({ kind: 'move', t0: camOut0, t1: travel0, from: holds[i], to: legs[i].fit, a3: is3d ? holds3[i] : null, b3: follow3(i, 0) });
    segments.push({ kind: 'travel', t0: travel0, t1: travel1, cam: legs[i].fit, leg: i });
    segments.push({ kind: 'move', t0: travel1, t1: arrive1, from: legs[i].fit, to: holds[i + 1], a3: follow3(i, 1), b3: is3d ? holds3[i + 1] : null });
    segments.push({ kind: 'static', t0: arrive1, t1: hold1, cam: holds[i + 1], a3: is3d ? holds3[i + 1] : null });

    legTimes.push({
      camOut0: camOut0,
      travel0: travel0,
      travel1: travel1,
      arrive0: travel1,
      arrive1: arrive1,
      hold1: hold1
    });
    pinPop[i + 1] = travel1 + 0.05 * speed;
    chipIn[i + 1] = travel1 + 0.2 * speed;

    // Chips older than this leg step aside while it plays.
    for (let s = 0; s < i; s++) {
      if (chipOut[s] === null) chipOut[s] = camOut0;
    }
    cursor = hold1;
  }

  const outroMove0 = cursor;
  const outroMove1 = outroMove0 + outroMoveDur;
  const duration = outroMove1 + outroHoldDur + freezeDur;
  segments.push({ kind: 'move', t0: outroMove0, t1: outroMove1, from: holds[legCount], to: fitAll, a3: is3d ? holds3[legCount] : null, b3: wide3 });
  // The closing hold drifts in a touch, the same in both views; the freeze
  // at the very end holds that last frame still.
  const outroHold1 = outroMove1 + outroHoldDur;
  segments.push({ kind: 'static', t0: outroMove1, t1: outroHold1, cam: fitAll, a3: wide3, drift: OUTRO_DRIFT });
  segments.push({ kind: 'static', t0: outroHold1, t1: duration, cam: fitAll, a3: wide3, drift: OUTRO_DRIFT, settled: true });

  return {
    project: p,
    theme: theme,
    is3d: is3d,
    designs: normalizeDesigns(p.designs),
    format: format,
    dims: dims,
    u: u,
    safe: safe,
    keepOut: keepOutRects(dims, safe, u),
    speed: speed,
    duration: duration,
    stops: stops,
    world: world,
    legs: legs,
    fitAll: fitAll,
    bounds: allBounds,
    holds: holds,
    segments: segments,
    // Summed from the legs, so a road leg contributes its real driving
    // distance. With every leg an arc this is the straight line total, exactly
    // as before.
    km: legs.reduce(function (sum, leg) { return sum + leg.km; }, 0),
    times: { legs: legTimes, pinPop: pinPop, chipIn: chipIn, chipOut: chipOut },
    outro: { move0: outroMove0, move1: outroMove1, holdEnd: outroMove1 + outroHoldDur },
    title: {
      in0: 0.25 * speed,
      in1: 0.75 * speed,
      out0: 1.55 * speed,
      out1: 2.05 * speed
    },
    popDur: D_POP * speed,
    chipFade: D_CHIP_FADE * speed,
    pulseDur: D_PULSE * speed,
    vehicleIn: D_VEHICLE_IN * speed,
    vehicleOut: D_VEHICLE_OUT * speed
  };
}

/* ------------------------------------------------------------- 3D camera */

// The tilted view is a ground plane seen through a pinhole camera. The map is
// rendered flat, in a few tiers of falling resolution, into offscreen canvases
// turned to the camera bearing, then laid onto the frame in thin horizontal
// bands, each band scaled for its own distance. Sky and haze hide where the
// ground runs out. Pins, labels and the vehicle are drawn upright on top.

const DEG = Math.PI / 180;
const PITCH_HOLD = 56 * DEG;
const PITCH_FOLLOW = 50 * DEG;
const PITCH_WIDE = 34 * DEG;
/** Focal length as a multiple of the frame height (or three quarters of a wide frame). */
const FOCAL = 1.2;
/** Ground pixels per screen pixel where the far ground ends in haze. */
const S_MAX = 3;
/** Ground scale where the haze starts to gather. */
const HAZE_FROM = 1.7;
/** Ground scale edges between render tiers; tier k renders at 1 / 2^k. */
const TIER_EDGES = [1.3, 2.1];
/**
 * Tile levels each tier drops below the flat view's choice. Tilted ground is
 * foreshortened, so the flat view's double density would be thrown away; this
 * keeps about one tile texel per screen pixel and a third of the tiles.
 */
const TIER_TILE_DROP = [1, 1, 2];
/** How much closer than the leg fit the camera rides while following. */
const FOLLOW_LIFT = 0.75;
const FOLLOW_BREATH = 0.28;
/** The chase camera sits a little off the leg's line, so the vehicle shows its side. */
const FOLLOW_SIDE = 0.32;
/** Models read larger on the tilted view, where they are the hero of the shot. */
const MODEL_BOOST_3D = 1.3;
const ORBIT_INTRO = 0.4;
/**
 * Below this pitch the tilted camera is looking straight down, so the frame is
 * drawn by the flat renderer: the 3D reel ends exactly like the 2D one.
 */
const FLAT_PITCH = 0.2 * DEG;
/** Under this pitch the ground is barely foreshortened: tier 0 keeps full tile density. */
const FULL_TILE_PITCH = 25 * DEG;
/** The tilt up into the closing overview takes a little longer than a flat pull out. */
const OUTRO_MOVE_3D = 1.6;
/** Pin head height above the ground, in drawing units at unit scale. */
const PIN_HEIGHT = 38;
/** The 2D view draws models from a fixed three quarter camera. */
const SPRITE_PITCH = 50 * DEG;
const SPRITE_SCALE = 0.7;

/**
 * The chase camera glides along the leg blurred by a Gaussian this wide, as a
 * fraction of the leg, so only the leg's broad sweep moves it, never a bend.
 */
const GLIDE_SIGMA = 0.1;
/** Vehicle position is averaged over this much road: corners round off. */
const POSE_POS_PX = 14;
/** Vehicle heading runs between points this far behind and ahead: about one car length. */
const POSE_HEADING_PX = 48;
/**
 * At speed a vehicle covers several hairpins per frame, so each window also
 * spans at least this many frames of travel: tight while it creeps out of a
 * stop, wide at full speed, where the bends would only read as jitter.
 */
const POSE_POS_FRAMES = 1.2;
const POSE_HEADING_FRAMES = 3;
/**
 * The heading is also averaged over this many frames either side, so even a
 * U turn right at a stop sweeps round over several frames.
 */
const HEADING_SPAN = 4;
/** Lean reads the heading change across this many frames either side. */
const LEAN_SPAN = 2;

/**
 * A point on a path averaged over a window either side of f, with a triangle
 * kernel, so a zigzag road reads as one easy line. The window shrinks to
 * nothing at the ends, so f = 0 and f = 1 land exactly on the stops.
 * Pure in f.
 * @param {object} path A leg path.
 * @param {number} f Fraction along the leg.
 * @param {number} w Half window, as a fraction of the leg.
 * @returns {{x: number, y: number}} World point.
 */
function smoothPointAt(path, f, w) {
  const half = Math.min(w, f, 1 - f);
  if (!(half > 1e-6)) return pathPointAt(path, clamp01(f));
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let i = -4; i <= 4; i++) {
    const wt = 1 - Math.abs(i) * 0.2;
    const pt = pathPointAt(path, clamp01(f + (i / 4) * half));
    sx += pt.x * wt;
    sy += pt.y * wt;
    sw += wt;
  }
  return { x: sx / sw, y: sy / sw };
}

/**
 * A screen distance as a fraction of a leg.
 * @param {object} path A leg path.
 * @param {number} px Drawing space pixels.
 * @param {number} scale Pixels per world unit.
 * @returns {number} Fraction of the leg.
 */
function legFrac(path, px, scale) {
  const lenPx = path.len * scale;
  return lenPx > 0 ? px / lenPx : 0;
}

/**
 * Where the vehicle is and which way it points. On a road the position rounds
 * the polyline's corners and the heading runs from a point a car length
 * behind to one a car length ahead, so a hairpin turns the vehicle through
 * the bend instead of snapping it at each vertex. Arcs are smooth already.
 * Pure in f.
 * @param {object} leg A timeline leg.
 * @param {number} f Fraction along the leg.
 * @param {{scale: number}} view Projection.
 * @param {number} u Unit scale.
 * @param {number} step Fraction of the leg covered in one frame right now.
 * @returns {{x: number, y: number, angle: number}} World point and heading.
 */
function vehiclePose(leg, f, view, u, step) {
  const path = leg.path;
  if (path.kind !== 'road') {
    const pt = pathPointAt(path, f);
    return { x: pt.x, y: pt.y, angle: pt.angle };
  }
  const pos = smoothPointAt(path, f, Math.max(legFrac(path, POSE_POS_PX * u, view.scale), POSE_POS_FRAMES * step));
  const h = Math.max(legFrac(path, POSE_HEADING_PX * u, view.scale), POSE_HEADING_FRAMES * step);
  const w = h / 2;
  const a = smoothPointAt(path, clamp01(f - h), w);
  const b = smoothPointAt(path, clamp01(f + h), w);
  const angle = (a.x === b.x && a.y === b.y) ? pathPointAt(path, f).angle : Math.atan2(b.y - a.y, b.x - a.x);
  return { x: pos.x, y: pos.y, angle: angle };
}

/**
 * Where the chase camera looks along a leg: the road blurred by a wide
 * Gaussian, so the vehicle weaves through the bends while the frame glides.
 * Samples past either end pile up on the stop, which keeps the line calm
 * leaving and reaching it. Pure in f.
 * @param {object} leg A timeline leg.
 * @param {number} f Fraction along the leg.
 * @returns {{x: number, y: number}} World point.
 */
function glideCentre(leg, f) {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let i = -8; i <= 8; i++) {
    const o = i / 8 * 2.2;
    const wt = Math.exp(-0.5 * o * o);
    const pt = pathPointAt(leg.path, clamp01(f + o * GLIDE_SIGMA));
    sx += pt.x * wt;
    sy += pt.y * wt;
    sw += wt;
  }
  return { x: sx / sw, y: sy / sw };
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function lerpAngle(a, b, p) {
  return a + wrapAngle(b - a) * p;
}

/**
 * The one compass bearing the camera holds for a whole leg: start to end, or
 * start to the middle of a leg that comes back on itself. The map only ever
 * turns between legs, eased, never while the vehicle is moving.
 * @param {object} leg A timeline leg.
 * @returns {number} Radians clockwise from north.
 */
function legBearing(leg) {
  const pts = leg.path.pts;
  const a = pts[0];
  let b = pts[pts.length - 1];
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(chord > (leg.path.len || 0) * 0.15)) b = glideCentre(leg, 0.5);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return (dx === 0 && dy === 0 ? 0 : Math.atan2(dx, -dy)) + FOLLOW_SIDE;
}

/**
 * The tilted camera at a point in time. Pure in t, like cameraAt.
 * @param {object} tl Timeline.
 * @param {number} t Seconds.
 * @returns {{cx: number, cy: number, zoom: number, pitch: number, bearing: number}}
 */
function camera3At(tl, t) {
  const segs = tl.segments;
  let seg = segs[segs.length - 1];
  for (let i = 0; i < segs.length; i++) {
    if (t < segs[i].t1) {
      seg = segs[i];
      break;
    }
  }
  const p = clamp01((t - seg.t0) / Math.max(1e-6, seg.t1 - seg.t0));

  if (seg.kind === 'travel') {
    const leg = tl.legs[seg.leg];
    const f = legProgress(tl, seg.leg, t);
    const rise = Math.sin(Math.PI * p);
    const zoom = leg.follow - FOLLOW_BREATH * rise;
    const pt = glideCentre(leg, f);
    return {
      cx: pt.x,
      cy: pt.y,
      zoom: zoom,
      pitch: PITCH_FOLLOW - 4 * DEG * rise,
      bearing: legBearing(leg)
    };
  }
  if (seg.kind === 'move') {
    const e = easeInOutCubic(p);
    const a = seg.a3;
    const b = seg.b3;
    return {
      cx: lerp(a.cx, b.cx, e),
      cy: lerp(a.cy, b.cy, e),
      zoom: lerp(a.zoom, b.zoom, e),
      pitch: lerp(a.pitch, b.pitch, e),
      bearing: lerpAngle(a.bearing, b.bearing, e)
    };
  }
  const c = seg.a3;
  const e = seg.settled ? 1 : easeInOutSine(p);
  return {
    cx: c.cx,
    cy: c.cy,
    zoom: c.zoom + (seg.drift ? seg.drift * e : 0),
    pitch: c.pitch,
    bearing: c.bearing + (seg.spin ? lerp(seg.spin[0], seg.spin[1], e) : 0)
  };
}

/** Screen row the focus sits on: lower as the camera tilts, so more road shows ahead. */
function focusRow(dims, pitch) {
  return dims.h * (0.5 + 0.12 * clamp01((pitch - PITCH_WIDE) / (PITCH_HOLD - PITCH_WIDE)));
}

/**
 * Everything one tilted frame needs to know about its ground: projection
 * constants, where the ground ends, and the render tiers with their extents
 * in the ground frame (gx right, gy away from the viewer, ground pixels).
 * @param {object} tl Timeline.
 * @param {{zoom: number, pitch: number, bearing: number}} cam Tilted camera.
 * @returns {object} Layout.
 */
function groundLayout(tl, cam) {
  const dims = tl.dims;
  const sin = Math.sin(cam.pitch);
  const cos = Math.cos(cam.pitch);
  // Landscape frames would see a very wide fan of ground; a longer lens there
  // keeps the tile load near the portrait one.
  const f = FOCAL * Math.max(dims.h, 0.75 * dims.w);
  const fc = f * cos;
  const fy = focusRow(dims, cam.pitch);
  const sAt = function (v) {
    const d = fc + v * sin;
    return d > 0 ? fc / d : Infinity;
  };
  const gyOf = function (sc) { return (f * (sc - 1)) / sin; };
  const sBot = sAt(dims.h - fy);
  const sTop = Math.min(S_MAX, sAt(-fy));

  const tiers = [];
  let lo = sBot;
  for (let k = 0; k <= TIER_EDGES.length && lo < sTop; k++) {
    const edge = k < TIER_EDGES.length ? TIER_EDGES[k] : Infinity;
    if (edge <= lo) continue;
    const hi = Math.min(edge, sTop);
    tiers.push({
      k: k,
      sLo: lo,
      sHi: hi,
      gyLo: gyOf(lo / 1.03),
      gyHi: gyOf(hi * 1.03),
      halfW: (dims.w / 2) * hi * 1.03 + 2
    });
    lo = hi;
  }

  return {
    f: f,
    fc: fc,
    sin: sin,
    cos: cos,
    fy: fy,
    w2: dims.w / 2,
    cutY: fy + (fc * (1 / S_MAX - 1)) / sin,
    hazeY: fy + (fc * (1 / HAZE_FROM - 1)) / sin,
    tiers: tiers,
    scale: 256 * Math.pow(2, cam.zoom),
    cb: Math.cos(cam.bearing),
    sb: Math.sin(cam.bearing)
  };
}

/**
 * Visit the tiles one ground tier covers, at the tier's own tile level.
 * @param {object} tl Timeline.
 * @param {{cx: number, cy: number, zoom: number}} cam Tilted camera.
 * @param {object} lay From groundLayout.
 * @param {object} tier One of lay.tiers.
 * @param {function(number, number, number, number): void} visit (z, x unwrapped, y, n).
 * @returns {void}
 */
function forEachTierTile(tl, cam, lay, tier, visit) {
  const spec = tl.theme.tiles;
  const drop = tier.k === 0 && cam.pitch < FULL_TILE_PITCH ? 0 : TIER_TILE_DROP[tier.k];
  const zt = clamp(Math.round(cam.zoom) + spec.zoomBias - drop, spec.minZoom, spec.maxZoom);
  const n = Math.pow(2, zt);
  const sc = lay.scale;
  const cb = lay.cb;
  const sb = lay.sb;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const corners = [[-tier.halfW, tier.gyLo], [tier.halfW, tier.gyLo], [tier.halfW, tier.gyHi], [-tier.halfW, tier.gyHi]];
  for (let i = 0; i < 4; i++) {
    const gx = corners[i][0];
    const gy = corners[i][1];
    const wx = cam.cx + (gx * cb + gy * sb) / sc;
    const wy = cam.cy + (gx * sb - gy * cb) / sc;
    minX = Math.min(minX, wx);
    maxX = Math.max(maxX, wx);
    minY = Math.min(minY, wy);
    maxY = Math.max(maxY, wy);
  }
  const x0 = Math.floor(minX * n);
  const x1 = Math.min(x0 + 80, Math.floor(maxX * n));
  const y0 = Math.max(0, Math.floor(minY * n));
  const y1 = Math.min(n - 1, y0 + 80, Math.floor(maxY * n));
  const rad = (sc / n) * 0.7072;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const dx = ((tx + 0.5) / n - cam.cx) * sc;
      const dy = ((ty + 0.5) / n - cam.cy) * sc;
      const gx = dx * cb + dy * sb;
      const gy = dx * sb - dy * cb;
      if (gy < tier.gyLo - rad || gy > tier.gyHi + rad) continue;
      // The tier is a trapezoid, narrow near the viewer: skip its empty corners.
      const half = Math.min(tier.halfW, lay.w2 * (1 + ((gy + rad) * lay.sin) / lay.f) * 1.03 + 2);
      if (gx < -half - rad || gx > half + rad) continue;
      visit(zt, tx, ty, n);
    }
  }
}

const TIER_CANVAS = [];

function tierCanvas(k, w, h) {
  let cv = TIER_CANVAS[k];
  if (!cv) {
    cv = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(w, h);
    TIER_CANVAS[k] = cv;
  }
  // Grow only: resizing clears and reallocates, and every frame draws inside
  // its own top left rectangle anyway.
  if (cv.width < w) cv.width = w;
  if (cv.height < h) cv.height = h;
  return cv;
}

/** Paint one ground tier: tiles, theme tint, routes and landing rings. */
function renderTier(tl, cam, lay, tier, tiles, t, view, outScale) {
  const dims = tl.dims;
  const r = Math.pow(2, -tier.k) * outScale;
  const w = Math.max(1, Math.ceil(2 * tier.halfW * r));
  const h = Math.max(1, Math.ceil((tier.gyHi - tier.gyLo) * r));
  const cv = tierCanvas(tier.k, w, h);
  const c = cv.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.setLineDash([]);
  clearShadow(c);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.fillStyle = tl.theme.bg;
  c.fillRect(0, 0, w, h);

  // Flat drawing space to tier pixels: about the frame centre, turned so the
  // camera bearing points up, scaled to the tier.
  const cb = lay.cb;
  const sb = lay.sb;
  c.setTransform(
    r * cb, -r * sb, r * sb, r * cb,
    r * (tier.halfW - (cb * dims.w) / 2 - (sb * dims.h) / 2),
    r * (tier.gyHi + (sb * dims.w) / 2 - (cb * dims.h) / 2)
  );

  if (tiles && typeof tiles.get === 'function') {
    const spec = tiles.spec || tl.theme.tiles;
    forEachTierTile(tl, cam, lay, tier, function (z, tx, ty, n) {
      const span = lay.scale / n;
      drawTileOrAncestor(c, tiles, spec, z, tx, ty, tx * span + view.ox, ty * span + view.oy, span + 0.75 / r);
    });
  }

  if (tl.theme.overlay) {
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = tl.theme.overlay.blend;
    c.fillStyle = tl.theme.overlay.color;
    c.fillRect(0, 0, w, h);
    c.restore();
  }

  const keep = shadowScale;
  shadowScale = r;
  drawTrails(c, tl, t, view);
  drawSweep(c, tl, t, view);
  drawPulses(c, tl, t, view);
  shadowScale = keep;
  return { cv: cv, r: r };
}

/** Lay the tiers onto the frame, one thin band per distance. */
function warpGround(ctx, tl, lay, out) {
  const dims = tl.dims;
  const gyAt = function (row) {
    const v = row - lay.fy;
    return (-v * lay.f) / (lay.fc + v * lay.sin);
  };
  // Plain bilinear: the high quality path picks a different filter per band
  // as the band's own scale changes, and the bands show as stripes.
  const quality = ctx.imageSmoothingQuality;
  ctx.imageSmoothingQuality = 'low';
  let y = Math.max(0, Math.floor(lay.cutY));
  while (y < dims.h) {
    const s0 = lay.fc / (lay.fc + (y - lay.fy) * lay.sin);
    // Bands stay thin where the scale changes fast, so their edges never step.
    const step = Math.max(1, Math.min(6, Math.round((0.004 * lay.fc) / (s0 * lay.sin))));
    const y1 = Math.min(dims.h, y + step);
    const sm = lay.fc / (lay.fc + ((y + y1) / 2 - lay.fy) * lay.sin);
    let ti = 0;
    while (ti < lay.tiers.length - 1 && sm > lay.tiers[ti].sHi) ti++;
    const tier = lay.tiers[ti];
    const o = out[ti];
    const g0 = gyAt(y);
    const g1 = gyAt(y1 + 0.6);
    const half = (dims.w / 2) * sm;
    ctx.drawImage(o.cv, (tier.halfW - half) * o.r, (tier.gyHi - g0) * o.r, 2 * half * o.r, (g0 - g1) * o.r, 0, y, dims.w, y1 + 0.6 - y);
    y = y1;
  }
  ctx.imageSmoothingQuality = quality;
}

/** Sky above the far edge of the ground, and haze where the ground fades into it. */
function drawSky(ctx, tl, lay) {
  const dims = tl.dims;
  const sky = tl.theme.sky || ['#9ccbe0', '#e4ecee'];
  const cut = lay.cutY;
  if (cut > 0) {
    const g = ctx.createLinearGradient(0, 0, 0, cut);
    g.addColorStop(0, sky[0]);
    g.addColorStop(1, sky[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, dims.w, cut + 1);
  }
  if (lay.hazeY > 0 && lay.hazeY > cut) {
    const g = ctx.createLinearGradient(0, cut, 0, lay.hazeY);
    g.addColorStop(0, withAlpha(sky[1], 1));
    g.addColorStop(0.3, withAlpha(sky[1], 0.62));
    g.addColorStop(0.65, withAlpha(sky[1], 0.2));
    g.addColorStop(1, withAlpha(sky[1], 0));
    ctx.fillStyle = g;
    const top = Math.max(0, cut);
    ctx.fillRect(0, top, dims.w, lay.hazeY - top);
  }
}

/**
 * The whole tilted ground for one frame. Returns the view the upright layers
 * project through.
 */
function drawGround3d(ctx, tl, t, tiles, cam) {
  const dims = tl.dims;
  const lay = groundLayout(tl, cam);
  const view = {
    scale: lay.scale,
    ox: dims.w / 2 - cam.cx * lay.scale,
    oy: dims.h / 2 - cam.cy * lay.scale
  };
  // A preview canvas is smaller than drawing space; the tiers need not be.
  const outScale = Math.min(1, shadowScale);
  const out = lay.tiers.map(function (tier) {
    return renderTier(tl, cam, lay, tier, tiles, t, view, outScale);
  });
  warpGround(ctx, tl, lay, out);
  drawSky(ctx, tl, lay);
  drawVignette(ctx, tl);
  view.p3 = { f: lay.f, sin: lay.sin, cos: lay.cos, sx: dims.w / 2, sy: lay.fy, cb: lay.cb, sb: lay.sb, W: dims.w, H: dims.h, cutY: lay.cutY, pitch: cam.pitch };
  return view;
}

/**
 * A world point on screen, tilted or flat.
 * @param {object} view Flat view, with `p3` when tilted.
 * @param {number} wx World x.
 * @param {number} wy World y.
 * @param {number} z Height in drawing units.
 * @returns {{x: number, y: number, k: number, ok: boolean, gx?: number, gy?: number}}
 */
function screenOf(view, wx, wy, z) {
  const X = wx * view.scale + view.ox;
  const Y = wy * view.scale + view.oy;
  const p = view.p3;
  if (!p) return { x: X, y: Y, k: 1, ok: Number.isFinite(X) && Number.isFinite(Y) };
  const dx = X - p.W / 2;
  const dy = Y - p.H / 2;
  const gx = dx * p.cb + dy * p.sb;
  const gy = dx * p.sb - dy * p.cb;
  const r = project(p, gx, gy, z || 0);
  r.ok = r.d > p.f * 0.2 && Number.isFinite(r.x) && Number.isFinite(r.y);
  r.gx = gx;
  r.gy = gy;
  return r;
}

/**
 * Closing flourish: a light runs the whole route once while the overview
 * holds, brightest at its head.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tl Timeline.
 * @param {number} t Seconds.
 * @param {{scale: number, ox: number, oy: number}} view Flat projection.
 * @returns {void}
 */
function drawSweep(ctx, tl, t, view) {
  const o = tl.outro;
  const span = o.holdEnd - o.move1;
  const p = (t - o.move1 - 0.12 * span) / (0.72 * span);
  if (!(p > 0 && p < 1)) return;
  const legs = tl.legs;
  let total = 0;
  for (let i = 0; i < legs.length; i++) total += legs[i].path.len || 0;
  if (!(total > 0)) return;

  const route = tl.theme.route;
  const base = route.color || (route.gradient ? route.gradient[1] : '#ffffff');
  const color = isLightColor(base) ? '#ffd76a' : '#ffffff';
  const head = easeInOutSine(p) * total;
  const tail = total * 0.22;
  const fade = Math.sin(Math.PI * p);
  const u = tl.u;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  // Three slices of tail, each brighter toward the head.
  for (let q = 0; q < 3; q++) {
    const from = head - tail * (1 - q / 3);
    const to = head - tail * (1 - (q + 1) / 3);
    let acc = 0;
    for (let i = 0; i < legs.length; i++) {
      const len = legs[i].path.len || 0;
      const a = Math.max(from, acc);
      const b = Math.min(to, acc + len);
      if (b > a && len > 0) {
        const geom = legs[i].path.kind === 'road' ? pickLevel(legs[i].path, view.scale) : legs[i].path;
        const f0 = (a - acc) / len;
        const f1 = (b - acc) / len;
        ctx.globalAlpha = 0.16 * (q + 1) * fade;
        ctx.lineWidth = route.width * 2.6 * u;
        traceGeom(ctx, geom, f0, f1, view);
        ctx.stroke();
        ctx.globalAlpha = 0.32 * (q + 1) * fade;
        ctx.lineWidth = route.width * 0.6 * u;
        traceGeom(ctx, geom, f0, f1, view);
        ctx.stroke();
      }
      acc += len;
    }
  }
  ctx.restore();
}

/* -------------------------------------------------------------- tile plan */

/**
 * Visible tile window for a camera.
 * @param {{cx: number, cy: number, zoom: number}} cam Camera.
 * @param {{w: number, h: number}} dims Drawing space size.
 * @param {object} spec A theme's tiles spec.
 * @returns {{zt: number, n: number, scale: number, span: number, x0: number, x1: number, y0: number, y1: number}}
 *   Integer tile zoom, world tile count, pixel scale, tile span in output
 *   pixels, and the inclusive tile index range.
 */
function tileWindow(cam, dims, spec) {
  const zt = clamp(Math.round(cam.zoom) + spec.zoomBias, spec.minZoom, spec.maxZoom);
  const n = Math.pow(2, zt);
  const scale = 256 * Math.pow(2, cam.zoom);
  const span = 256 * Math.pow(2, cam.zoom - zt);
  const halfW = dims.w / 2 / scale;
  const halfH = dims.h / 2 / scale;

  let x0 = Math.floor((cam.cx - halfW) * n);
  let x1 = Math.floor((cam.cx + halfW) * n);
  let y0 = Math.max(0, Math.floor((cam.cy - halfH) * n));
  let y1 = Math.min(n - 1, Math.floor((cam.cy + halfH) * n));
  // Safety rail so a degenerate camera can never ask for thousands of tiles.
  if (x1 - x0 > 63) x1 = x0 + 63;
  if (y1 - y0 > 63) y1 = y0 + 63;

  return { zt: zt, n: n, scale: scale, span: span, x0: x0, x1: x1, y0: y0, y1: y1 };
}

/**
 * Walk the primary-zoom tiles one frame draws, in draw order.
 *
 * The single place the per-frame tile math lives: evaluate the camera at
 * `frame / FPS`, take that camera's tile window, and visit every wrapped tile
 * index in it. planTiles and tilesForFrame both go through here so a plan entry
 * and a frame's residency check can never disagree.
 *
 * Ancestor fallback tiles are deliberately not visited. They are a fallback
 * drawTiles reaches for, never something a frame is entitled to expect.
 *
 * @param {object} timeline A timeline from buildTimeline.
 * @param {number} frame Frame index at FPS.
 * @param {function(number, number, number): void} visit Called with (z, x, y).
 * @returns {void}
 */
function forEachFrameTile(timeline, frame, visit) {
  const t = clamp(frame / FPS, 0, timeline.duration);
  const c3 = timeline.is3d ? camera3At(timeline, t) : null;
  if (c3 && c3.pitch > FLAT_PITCH) {
    const lay = groundLayout(timeline, c3);
    for (let k = 0; k < lay.tiers.length; k++) {
      forEachTierTile(timeline, c3, lay, lay.tiers[k], function (z, tx, ty, n) {
        visit(z, ((tx % n) + n) % n, ty);
      });
    }
    return;
  }
  const cam = cameraAt(timeline, t);
  const win = tileWindow(cam, timeline.dims, timeline.theme.tiles);

  for (let ty = win.y0; ty <= win.y1; ty++) {
    for (let tx = win.x0; tx <= win.x1; tx++) {
      visit(win.zt, ((tx % win.n) + win.n) % win.n, ty);
    }
  }
}

/**
 * Every tile the timeline will ask for, in the order it first needs them.
 *
 * Walks one frame at a time at FPS and unions the visible tile rectangle at
 * each frame's chosen tile zoom, so a prefetch fills the screen from the first
 * frame outward rather than in scan order.
 *
 * Each entry carries `firstFrame`, the index of the frame that first needs the
 * tile, so a caller can prefetch the plan in windows that track the frames it
 * is about to encode instead of loading the whole trip at once.
 *
 * @param {object} timeline A timeline from buildTimeline.
 * @returns {Array<{z: number, x: number, y: number, firstFrame: number}>} Unique tiles.
 */
export function planTiles(timeline) {
  const frames = Math.ceil(timeline.duration * FPS);
  const seen = new Set();
  const out = [];

  for (let f = 0; f <= frames; f++) {
    const at = f;
    forEachFrameTile(timeline, at, function (z, x, y) {
      const key = z + '/' + x + '/' + y;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ z: z, x: x, y: y, firstFrame: at });
    });
  }
  return out;
}

/**
 * The primary-zoom tiles renderFrame would try to draw at one frame.
 *
 * Same camera and zoom-bias math planTiles steps through, for exactly one
 * frame, so an encode loop can gate a frame on those tiles being resident
 * before it draws. Ancestor fallbacks are not listed: a frame whose primary
 * tiles are resident never needs them.
 *
 * @param {object} timeline A timeline from buildTimeline.
 * @param {number} frame Frame index at FPS, clamped to the timeline.
 * @returns {Array<{z: number, x: number, y: number}>} Unique tiles, draw order.
 */
export function tilesForFrame(timeline, frame) {
  const seen = new Set();
  const out = [];

  forEachFrameTile(timeline, frame, function (z, x, y) {
    const key = z + '/' + x + '/' + y;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ z: z, x: x, y: y });
  });
  return out;
}

/* --------------------------------------------------------------- renderer */

/**
 * Progress along a leg at a point in time, eased.
 * @param {object} tl Timeline.
 * @param {number} i Leg index.
 * @param {number} t Seconds.
 * @returns {number} 0 before the leg, 1 after it.
 */
function legProgress(tl, i, t) {
  const L = tl.times.legs[i];
  if (t >= L.travel1) return 1;
  if (t <= L.travel0) return 0;
  return easeInOutSine((t - L.travel0) / Math.max(1e-6, L.travel1 - L.travel0));
}

/**
 * The vehicle on screen at a point in time, if any.
 * @param {object} tl Timeline.
 * @param {number} t Seconds.
 * @returns {{leg: number, p: number, f: number, alpha: number}|null} Active leg
 *   index, raw progress, eased progress, and opacity.
 */
function activeVehicle(tl, t) {
  for (let i = 0; i < tl.legs.length; i++) {
    const L = tl.times.legs[i];
    if (t < L.travel0) return null;
    if (t <= L.travel1 + tl.vehicleOut) {
      const p = clamp01((t - L.travel0) / Math.max(1e-6, L.travel1 - L.travel0));
      let alpha = 1;
      if (t < L.travel0 + tl.vehicleIn) alpha = clamp01((t - L.travel0) / tl.vehicleIn);
      else if (t > L.travel1) alpha = clamp01(1 - (t - L.travel1) / tl.vehicleOut);
      return { leg: i, p: p, f: easeInOutSine(p), alpha: alpha };
    }
  }
  return null;
}

/**
 * Chip opacity for a stop.
 * @param {object} tl Timeline.
 * @param {number} s Stop index.
 * @param {number} t Seconds.
 * @returns {number} Opacity in [0, 1].
 */
function chipAlpha(tl, s, t) {
  const inAt = tl.times.chipIn[s];
  if (t < inAt) return 0;
  let a = clamp01((t - inAt) / Math.max(1e-6, tl.chipFade));
  const outAt = tl.times.chipOut[s];
  if (outAt !== null && t > outAt) {
    a = Math.min(a, clamp01(1 - (t - outAt) / Math.max(1e-6, tl.chipFade)));
  }
  if (t > tl.outro.move0) {
    const back = clamp01((t - tl.outro.move0) / Math.max(1e-6, tl.outro.move1 - tl.outro.move0));
    if (back > a) a = back;
  }
  return a;
}

/**
 * Title card opacity.
 * @param {object} tl Timeline.
 * @param {number} t Seconds.
 * @returns {number} Opacity in [0, 1].
 */
function titleAlpha(tl, t) {
  const T = tl.title;
  if (t <= T.in0) return 0;
  if (t < T.in1) return easeInOutCubic((t - T.in0) / Math.max(1e-6, T.in1 - T.in0));
  if (t <= T.out0) return 1;
  if (t < T.out1) return 1 - easeInOutCubic((t - T.out0) / Math.max(1e-6, T.out1 - T.out0));
  return 0;
}

/**
 * Dash pattern for a leg, scaled to the frame.
 * @param {object} route Theme route block.
 * @param {string} mode Leg mode.
 * @param {number} u Unit scale.
 * @returns {number[]} Dash array, empty for a solid line.
 */
function dashFor(route, mode, u) {
  const d = (mode === 'plane' && route.planeDash) ? route.planeDash : route.dash;
  if (!d || !d.length) return [];
  return d.map(function (v) { return v * u; });
}

/**
 * Trace a slice of a path, by arc length fraction, into the current path.
 *
 * Both ends are interpolated, so a slice starts and stops exactly where it was
 * asked to rather than at the nearest vertex.
 *
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {{pts: Array<{x: number, y: number}>, cum: Float64Array}} geom A path
 *   or one of its detail levels.
 * @param {number} f0 Fraction where the slice starts.
 * @param {number} f1 Fraction where the slice ends.
 * @param {{scale: number, ox: number, oy: number}} view Projection.
 * @returns {void}
 */
function traceGeom(ctx, geom, f0, f1, view) {
  const pts = geom.pts;
  const cum = geom.cum;
  const total = cum[cum.length - 1];
  const start = pathPointAt(geom, f0);

  ctx.beginPath();
  ctx.moveTo(start.x * view.scale + view.ox, start.y * view.scale + view.oy);

  if (total > 0) {
    const from = f0 * total;
    const to = f1 * total;
    for (let i = 1; i < pts.length; i++) {
      if (cum[i] <= from) continue;
      if (cum[i] >= to) break;
      ctx.lineTo(pts[i].x * view.scale + view.ox, pts[i].y * view.scale + view.oy);
    }
  }

  const end = pathPointAt(geom, f1);
  ctx.lineTo(end.x * view.scale + view.ox, end.y * view.scale + view.oy);
}

/**
 * The detail tier to draw a road leg at, for the current camera scale.
 *
 * Coarsest tier that still lands inside the pixel budget wins. Below the
 * coarsest tier's own threshold the base points are drawn, which is what
 * happens whenever the camera is close enough for the bends to matter.
 *
 * @param {object} path A path from buildRoadPath, or any path.
 * @param {number} scale Pixels per world unit at the current camera.
 * @returns {object} A geometry with pts, cum and len.
 */
function pickLevel(path, scale) {
  const levels = path && path.levels;
  if (!levels || !levels.length) return path;
  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i];
    if (lv.pts.length >= 2 && lv.maxErr * scale <= LEVEL_PX_BUDGET) return lv;
  }
  return path;
}

/**
 * Stroke one layer of a leg's trail: the glow underlay, the casing, or the
 * main line.
 *
 * With `feather` set, the last few percent of the drawn portion is stroked
 * separately with a gradient that runs out to transparent, so the leading tip
 * dissolves instead of ending in a cap. On a solid layer the two sub strokes
 * meet with butt caps on purpose: a round cap at the junction would overlap
 * the feather and double composite it into a visible bead on the semi
 * transparent casings. A dashed layer keeps round caps instead, because the
 * cap style there applies to every dash and has to match the completed leg.
 *
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {{pts: Array<{x: number, y: number}>, cum: Float64Array}} geom Geometry to trace.
 * @param {{scale: number, ox: number, oy: number}} view Projection.
 * @param {number} f Fraction of the leg drawn so far.
 * @param {boolean} feather Fade the tip out.
 * @param {{stroke: (string|CanvasGradient), tip: string, width: number,
 *   alpha: number, dash: number[], glow: ({color: string, blur: number}|null),
 *   tipAxis: ({from: string, to: string, ax: number, ay: number, bx: number,
 *   by: number}|undefined)}} style
 *   Paint for this layer. `tip` must be a solid colour, even when `stroke` is a
 *   gradient. With `tipAxis` the tip colour is sampled off that gradient axis at
 *   the junction instead, which is what keeps a moving gradient seamless.
 * @returns {void}
 */
function strokeLayer(ctx, geom, view, f, feather, style) {
  ctx.globalAlpha = style.alpha;
  ctx.lineWidth = style.width;
  ctx.setLineDash(style.dash);
  ctx.lineDashOffset = 0;

  const applyGlow = function () {
    if (!style.glow) return;
    ctx.shadowColor = style.glow.color;
    setShadow(ctx, style.glow.blur, 0, 0);
  };

  if (!feather) {
    ctx.lineCap = 'round';
    traceGeom(ctx, geom, 0, f, view);
    ctx.strokeStyle = style.stroke;
    applyGlow();
    ctx.stroke();
    clearShadow(ctx);
    return;
  }

  const pb = pathPointAt(geom, f);
  const total = geom.cum[geom.cum.length - 1];
  let fSolid = f * (1 - FEATHER_FRACTION);
  let pa = pathPointAt(geom, fSolid);

  // Pull the junction in until the window runs roughly straight, so a hairpin
  // folded inside it cannot invert the fade. Shrinking to the chord converges
  // in a step or two: either the bend falls outside the smaller window, or the
  // head sits on the bend itself and the feather shrinks away, which at worst
  // costs the fade on that frame and never paints an opacity that climbs back
  // up towards the tip.
  for (let i = 0; i < FEATHER_SHRINK_STEPS; i++) {
    const arc = (f - fSolid) * total;
    if (!(arc > 0)) break;
    const chord = Math.sqrt((pb.x - pa.x) * (pb.x - pa.x) + (pb.y - pa.y) * (pb.y - pa.y));
    if (chord >= FEATHER_MIN_STRAIGHTNESS * arc) break;
    fSolid = f - chord / total;
    pa = pathPointAt(geom, fSolid);
  }

  const ax = pa.x * view.scale + view.ox;
  const ay = pa.y * view.scale + view.oy;
  const bx = pb.x * view.scale + view.ox;
  const by = pb.y * view.scale + view.oy;

  // Butt caps keep the junction from double compositing into a bead, but a
  // canvas line cap applies to every dash, not just the ends of the stroke. On
  // a dashed theme that would shorten every dash of an animating leg and snap
  // them all back at completion, so a dashed layer keeps the round caps it
  // draws with when it is done: the bead the butt cap avoids needs the junction
  // to land on a dash end, which it almost never does.
  ctx.lineCap = style.dash.length ? 'round' : 'butt';
  traceGeom(ctx, geom, 0, fSolid, view);
  ctx.strokeStyle = style.stroke;
  applyGlow();
  ctx.stroke();
  clearShadow(ctx);

  // Sub pixel tip: a gradient between two coincident points is a flat colour,
  // and there is nothing left to fade anyway.
  if (Math.abs(bx - ax) < 0.01 && Math.abs(by - ay) < 0.01) return;

  // On a gradient theme the body of the line is painted with a route wide
  // gradient whose anchors move, so a fixed tip colour meets it in a seam at
  // the junction. Sample that same gradient at the junction instead and the
  // feather picks up exactly where the solid stroke left off.
  const tip = style.tipAxis
    ? mixColor(
      style.tipAxis.from,
      style.tipAxis.to,
      axisParam(style.tipAxis.ax, style.tipAxis.ay, style.tipAxis.bx, style.tipAxis.by, ax, ay)
    )
    : style.tip;

  const grad = ctx.createLinearGradient(ax, ay, bx, by);
  grad.addColorStop(0, tip);
  grad.addColorStop(1, withAlpha(tip, 0));

  // Carry the dash phase across the join so a dashed theme does not restart
  // its pattern at the tip.
  if (style.dash.length) {
    ctx.lineDashOffset = fSolid * total * view.scale;
  }
  traceGeom(ctx, geom, fSolid, f, view);
  ctx.strokeStyle = grad;
  applyGlow();
  ctx.stroke();
  clearShadow(ctx);
  ctx.lineDashOffset = 0;
}

/**
 * Draw one tile, falling back to the matching quadrant of an ancestor tile.
 *
 * A tile that has not arrived yet would leave bare theme background in the
 * frame, which during an export is encoded and gone. One zoom up covers the
 * same ground at half the detail, two zooms up at a quarter, and either reads
 * far better than a blank patch.
 *
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tiles A TileCache.
 * @param {object} spec The cache's tiles spec.
 * @param {number} z Tile zoom.
 * @param {number} tx Tile column, possibly outside the world and wrapped by the cache.
 * @param {number} ty Tile row.
 * @param {number} dx Destination left edge.
 * @param {number} dy Destination top edge.
 * @param {number} size Destination size, including the seam bleed.
 * @returns {void}
 */
function drawTileOrAncestor(ctx, tiles, spec, z, tx, ty, dx, dy, size) {
  const img = tiles.get(z, tx, ty);
  if (img) {
    ctx.drawImage(img, dx, dy, size, size);
    return;
  }

  const minZoom = Number.isFinite(spec.minZoom) ? spec.minZoom : 0;
  for (let up = 1; up <= 2; up++) {
    const az = z - up;
    if (az < minZoom || az < 0) return;
    const step = up === 1 ? 2 : 4;
    const anc = tiles.get(az, Math.floor(tx / step), Math.floor(ty / step));
    if (!anc) continue;

    const src = anc.naturalWidth > 0 ? anc.naturalWidth : (spec.size || 256);
    const part = src / step;
    let sx = (((tx % step) + step) % step) * part;
    let sy = (((ty % step) + step) % step) * part;
    let sw = part;
    let sh = part;
    if (sx < 0) sx = 0;
    if (sy < 0) sy = 0;
    if (sx + sw > src) sw = src - sx;
    if (sy + sh > src) sh = src - sy;
    if (!(sw > 0) || !(sh > 0)) return;

    ctx.drawImage(anc, sx, sy, sw, sh, dx, dy, size, size);
    return;
  }
}

/**
 * Layer 2: the raster basemap.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tl Timeline.
 * @param {{cx: number, cy: number, zoom: number}} cam Camera.
 * @param {object|null} tiles A TileCache, or null to skip tiles.
 * @returns {void}
 */
function drawTiles(ctx, tl, cam, tiles) {
  if (!tiles || typeof tiles.get !== 'function') return;
  const dims = tl.dims;
  const spec = tiles.spec || tl.theme.tiles;
  const win = tileWindow(cam, dims, tl.theme.tiles);
  const ox = dims.w / 2 - cam.cx * win.scale;
  const oy = dims.h / 2 - cam.cy * win.scale;
  // Half a pixel of overdraw hides the hairline seams between neighbours.
  const size = win.span + 0.5;

  for (let ty = win.y0; ty <= win.y1; ty++) {
    const sy = (ty / win.n) * win.scale + oy;
    for (let tx = win.x0; tx <= win.x1; tx++) {
      drawTileOrAncestor(
        ctx,
        tiles,
        spec,
        win.zt,
        tx,
        ty,
        (tx / win.n) * win.scale + ox,
        sy,
        size
      );
    }
  }
}

/**
 * Layer 3: theme tint and edge darkening.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tl Timeline.
 * @returns {void}
 */
function drawWash(ctx, tl) {
  const dims = tl.dims;
  const theme = tl.theme;

  if (theme.overlay) {
    ctx.save();
    ctx.globalCompositeOperation = theme.overlay.blend;
    ctx.fillStyle = theme.overlay.color;
    ctx.fillRect(0, 0, dims.w, dims.h);
    ctx.restore();
  }

  drawVignette(ctx, tl);
}

/**
 * Edge darkening, for themes that have it.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tl Timeline.
 * @returns {void}
 */
function drawVignette(ctx, tl) {
  const dims = tl.dims;
  const theme = tl.theme;
  if (theme.vignette > 0) {
    const cx = dims.w / 2;
    const cy = dims.h / 2;
    const r = Math.sqrt(dims.w * dims.w + dims.h * dims.h) / 2;
    const g = ctx.createRadialGradient(cx, cy, r * 0.42, cx, cy, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.62, 'rgba(0,0,0,' + (theme.vignette * 0.26).toFixed(4) + ')');
    g.addColorStop(1, 'rgba(0,0,0,' + theme.vignette.toFixed(4) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, dims.w, dims.h);
  }
}

/**
 * Layer 4: the route drawn so far.
 *
 * A road leg draws from the coarsest detail tier that still holds under a pixel
 * of error at the current scale, under an optional wide soft glow, and its
 * leading tip feathers out while the leg is animating. Arc legs draw exactly as
 * they always have.
 *
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tl Timeline.
 * @param {number} t Seconds.
 * @param {{scale: number, ox: number, oy: number}} view Projection.
 * @returns {void}
 */
function drawTrails(ctx, tl, t, view) {
  const route = tl.theme.route;
  const legs = tl.legs;
  const u = tl.u;

  const progress = new Array(legs.length);
  let head = null;
  for (let i = 0; i < legs.length; i++) {
    progress[i] = legProgress(tl, i, t);
    if (progress[i] > 0) head = pathPointAt(legs[i].path, progress[i]);
  }
  if (!head) return;

  let stroke;
  let tipAxis;
  if (route.gradient) {
    const start = legs[0].path.pts[0];
    const x0 = start.x * view.scale + view.ox;
    const y0 = start.y * view.scale + view.oy;
    const x1 = head.x * view.scale + view.ox;
    const y1 = head.y * view.scale + view.oy;

    // On a round trip the head comes back onto the start, and a gradient with
    // both ends in the same place is a flat colour. As the two converge, ease
    // the anchors out to the diagonal of the whole route instead, so a closed
    // loop keeps both colours and nothing pops on the way there.
    let ax = x0;
    let ay = y0;
    let bx = x1;
    let by = y1;
    const b = tl.bounds;
    const near = GRADIENT_ANCHOR_NEAR * u;
    const far = GRADIENT_ANCHOR_FAR * u;
    const gap = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
    if (gap < far && b && (b.maxX > b.minX || b.maxY > b.minY)) {
      const s = clamp01((far - gap) / (far - near));
      const k = s * s * (3 - 2 * s);
      ax = lerp(x0, b.minX * view.scale + view.ox, k);
      ay = lerp(y0, b.minY * view.scale + view.oy, k);
      bx = lerp(x1, b.maxX * view.scale + view.ox, k);
      by = lerp(y1, b.maxY * view.scale + view.oy, k);
    }

    if (Math.abs(bx - ax) < 0.5 && Math.abs(by - ay) < 0.5) {
      stroke = route.gradient[0];
    } else {
      const g = ctx.createLinearGradient(ax, ay, bx, by);
      g.addColorStop(0, route.gradient[0]);
      g.addColorStop(1, route.gradient[1]);
      stroke = g;
      tipAxis = {
        from: route.gradient[0],
        to: route.gradient[1],
        ax: ax,
        ay: ay,
        bx: bx,
        by: by
      };
    }
  } else {
    stroke = route.color || '#ffffff';
  }

  // A gradient theme has no single route colour. The feather samples the live
  // gradient at the junction through tipAxis; this stays as the fallback for
  // the frames where the anchors collapse and the body is a flat colour.
  const tipColor = route.color || (route.gradient ? route.gradient[0] : '#ffffff');
  const mainGlow = route.glow ? { color: route.glow.color, blur: route.glow.blur * u } : null;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (let i = 0; i < legs.length; i++) {
    const f = progress[i];
    if (f <= 0) continue;
    const leg = legs[i];
    const dash = dashFor(route, leg.mode, u);
    const isRoad = leg.path.kind === 'road';
    const geom = isRoad ? pickLevel(leg.path, view.scale) : leg.path;
    const feather = isRoad && f < 1;

    // The glow underlay is a wide low alpha stroke, never a shadow: cheaper,
    // print crisp, and it survives an export at any scale. It stays solid even
    // on a dashed theme, because it reads as the road corridor, not a line.
    if (isRoad && route.roadGlow) {
      strokeLayer(ctx, geom, view, f, feather, {
        stroke: route.roadGlow.color,
        tip: route.roadGlow.color,
        width: route.width * route.roadGlow.widthMult * u,
        alpha: route.roadGlow.alpha,
        dash: [],
        glow: null
      });
    }

    if (route.casing) {
      strokeLayer(ctx, geom, view, f, feather, {
        stroke: route.casing.color,
        tip: route.casing.color,
        width: route.casing.width * u,
        alpha: 1,
        dash: dash,
        glow: null
      });
    }

    strokeLayer(ctx, geom, view, f, feather, {
      stroke: stroke,
      tip: tipColor,
      tipAxis: tipAxis,
      width: route.width * u,
      alpha: 1,
      dash: dash,
      glow: mainGlow
    });
  }

  ctx.restore();
}

/**
 * Layer 5: the ring that expands out of each pin as it lands.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tl Timeline.
 * @param {number} t Seconds.
 * @param {{scale: number, ox: number, oy: number}} view Projection.
 * @returns {void}
 */
function drawPulses(ctx, tl, t, view) {
  const u = tl.u;
  ctx.save();
  for (let s = 0; s < tl.world.length; s++) {
    const at = tl.times.pinPop[s];
    if (t < at || t >= at + tl.pulseDur) continue;
    const p = (t - at) / tl.pulseDur;
    const grow = 1 - (1 - p) * (1 - p);
    ctx.globalAlpha = 0.5 * (1 - p);
    ctx.strokeStyle = tl.theme.pin.fill;
    ctx.lineWidth = 3 * u;
    ctx.beginPath();
    ctx.arc(
      tl.world[s].x * view.scale + view.ox,
      tl.world[s].y * view.scale + view.oy,
      lerp(10 * u, 34 * u, grow),
      0,
      Math.PI * 2
    );
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Layer 6: the stop markers.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tl Timeline.
 * @param {number} t Seconds.
 * @param {{scale: number, ox: number, oy: number}} view Projection.
 * @returns {void}
 */
function drawPins(ctx, tl, t, view) {
  const u = tl.u;
  const pin = tl.theme.pin;

  ctx.save();
  for (let s = 0; s < tl.world.length; s++) {
    const at = tl.times.pinPop[s];
    if (t < at) continue;
    const k = easeOutBack(clamp01((t - at) / tl.popDur));
    if (k <= 0) continue;
    let x = tl.world[s].x * view.scale + view.ox;
    let y = tl.world[s].y * view.scale + view.oy;
    let r = 10 * u * k;

    // Tilted, a pin stands on a short stem over its own ground shadow.
    if (view.p3) {
      const base = screenOf(view, tl.world[s].x, tl.world[s].y, 0);
      if (!base.ok || base.y < view.p3.cutY) continue;
      const kk = clamp(base.k, 0.45, 1.6);
      // How tilted the view is: the stem, its shadow and the larger head
      // fade into the flat pin as the camera levels out.
      const tilt = clamp01(view.p3.pitch / PITCH_FOLLOW);
      const head = screenOf(view, tl.world[s].x, tl.world[s].y, PIN_HEIGHT * u * k);
      ctx.fillStyle = 'rgba(0,0,0,' + (0.26 * tilt).toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(base.x, base.y, 9 * u * kk, 9 * u * kk * view.p3.cos, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineCap = 'round';
      ctx.strokeStyle = pin.ring;
      ctx.lineWidth = 6 * u * kk;
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(head.x, head.y);
      ctx.stroke();
      ctx.strokeStyle = pin.fill;
      ctx.lineWidth = 3 * u * kk;
      ctx.stroke();
      x = head.x;
      y = head.y;
      r = (10 + 2 * tilt) * u * k * kk;
    }

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.shadowColor = 'rgba(0,0,0,.28)';
    setShadow(ctx, 9 * u, 0, 2 * u);
    ctx.fillStyle = pin.fill;
    ctx.fill();
    clearShadow(ctx);
    ctx.lineWidth = 3.5 * u;
    ctx.strokeStyle = pin.ring;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Which way a ground vehicle faces, from the chord across a wide window
 * either side of it. Pure in `f`.
 *
 * @param {object} path A timeline leg path.
 * @param {number} f Fraction along the leg.
 * @param {{scale: number, ox: number, oy: number}} view Projection.
 * @param {number} angle Heading to fall back on when the chord is degenerate.
 * @returns {boolean} True when the vehicle faces left.
 */
function facingAt(path, f, view, angle) {
  const lenPx = path.len * view.scale;
  const raw = lenPx > 0 ? (FACING_WINDOW_MULT * HEADING_WINDOW_PX) / lenPx : 0.5;
  const w = clamp(raw, 0.02, 0.5);
  const back = pathPointAt(path, clamp01(f - w));
  const fwd = pathPointAt(path, clamp01(f + w));
  const dx = fwd.x - back.x;
  if (dx !== 0) return dx < 0;
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return Math.abs(a) > Math.PI / 2;
}

/**
 * The vehicle's place, heading and rate of turn at one moment of a leg.
 * Position comes from vehiclePose; the heading is averaged over a few frames
 * either side, so a hairpin, even a U turn right at a stop, sweeps the
 * vehicle round instead of snapping it. Pure in t.
 * @param {object} tl Timeline.
 * @param {{leg: number, p: number, f: number}} act From activeVehicle.
 * @param {{scale: number}} view Projection.
 * @returns {{x: number, y: number, angle: number, turn: number, travel: number}}
 *   World point, heading, heading change across the lean window, and the
 *   leg's travel time in seconds.
 */
function vehicleMotion(tl, act, view) {
  const leg = tl.legs[act.leg];
  const u = tl.u;
  // How much of the leg one frame covers at a moment of the eased travel.
  const LT = tl.times.legs[act.leg];
  const T = Math.max(1e-3, LT.travel1 - LT.travel0);
  const stepAt = function (p) { return ((Math.PI / 2) * Math.sin(Math.PI * p)) / (T * FPS); };
  const pos = vehiclePose(leg, act.f, view, u, stepAt(act.p));
  // Headings a few frames either side, still pure in t, unwrapped into one
  // continuous run and averaged. Averaging the angles, not unit vectors,
  // turns a hairpin into an even sweep: opposite vectors would cancel and
  // flip the result in a single frame.
  const reach = HEADING_SPAN + LEAN_SPAN;
  const heads = [];
  for (let k = -reach; k <= reach; k++) {
    const pk = clamp01(act.p + k / (T * FPS));
    const a = vehiclePose(leg, easeInOutSine(pk), view, u, stepAt(pk)).angle;
    heads.push(heads.length ? heads[heads.length - 1] + wrapAngle(a - heads[heads.length - 1]) : a);
  }
  const headingAround = function (c) {
    let sum = 0;
    let sw = 0;
    for (let k = -HEADING_SPAN; k <= HEADING_SPAN; k++) {
      const wt = HEADING_SPAN + 1 - Math.abs(k);
      sum += heads[c + k + reach] * wt;
      sw += wt;
    }
    return sum / sw;
  };
  return {
    x: pos.x,
    y: pos.y,
    angle: headingAround(0),
    turn: headingAround(LEAN_SPAN) - headingAround(-LEAN_SPAN),
    travel: T
  };
}

/**
 * Layer 7: the travelling vehicle and its ground shadow.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tl Timeline.
 * @param {number} t Seconds.
 * @param {{scale: number, ox: number, oy: number}} view Projection.
 * @returns {void}
 */
function drawVehicleLayer(ctx, tl, t, view) {
  const act = activeVehicle(tl, t);
  if (!act) return;

  const leg = tl.legs[act.leg];
  const u = tl.u;
  const pt = vehicleMotion(tl, act, view);
  const angle = pt.angle;
  const p3 = view.p3;
  const model = modelFor(leg.mode, tl.designs);

  if (model) {
    // A real model: turned to the road, wheels rolling, two wheelers leaning
    // into the bends. Flat, it is seen from a fixed three quarter camera.
    let cam;
    let gx = 0;
    let gy = 0;
    let ppm = PX_PER_M * u;
    if (p3) {
      const at = screenOf(view, pt.x, pt.y, 0);
      if (!at.ok) return;
      cam = p3;
      gx = at.gx;
      gy = at.gy;
      ppm *= MODEL_BOOST_3D;
    } else {
      cam = {
        f: 2400 * u,
        sin: Math.sin(SPRITE_PITCH),
        cos: Math.cos(SPRITE_PITCH),
        sx: pt.x * view.scale + view.ox,
        sy: pt.y * view.scale + view.oy
      };
      ppm *= SPRITE_SCALE;
    }
    const turn = pt.turn;
    const leanMax = leg.mode === 'moto' ? 0.42 : (leg.mode === 'cycle' ? 0.3 : 0);
    const spin = act.f * pt.travel * 11;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const cb = p3 ? p3.cb : 1;
    const sb = p3 ? p3.sb : 0;
    drawModel(ctx, model, cam, {
      gx: gx,
      gy: gy,
      hx: ca * cb + sa * sb,
      hy: ca * sb - sa * cb,
      ppm: ppm,
      spin: spin,
      lean: clamp(-turn * 1.2, -leanMax, leanMax) * act.alpha,
      bob: leg.mode === 'car' ? 0.012 * Math.sin(spin * 0.9) : 0,
      alpha: act.alpha,
      // Flat and on a dark map, a faint halo keeps a dark vehicle readable.
      halo: p3 || isLightColor(tl.theme.bg) ? null : 'rgba(255,255,255,.16)'
    });
    return;
  }

  const flying = leg.mode === 'plane';
  const lift = flying ? Math.sin(Math.PI * act.p) : 0;
  let x = pt.x * view.scale + view.ox;
  let y = pt.y * view.scale + view.oy;
  let sx = x;
  let sy = y + (flying ? 22 * u * lift : 4 * u);
  let ang = angle;
  let kk = 1;
  let faceLeft = flying ? undefined : facingAt(leg.path, act.f, view, angle);
  if (p3) {
    // Tilted, an icon floats over its own shadow, a plane by its altitude.
    const h = (flying ? 110 * lift : 8) * u;
    const base = screenOf(view, pt.x, pt.y, 0);
    const up = screenOf(view, pt.x, pt.y, h);
    const ahead = screenOf(view, pt.x + (Math.cos(angle) * 6) / view.scale, pt.y + (Math.sin(angle) * 6) / view.scale, h);
    if (!base.ok || !up.ok) return;
    kk = clamp(base.k, 0.5, 1.6);
    sx = base.x;
    sy = base.y;
    x = up.x;
    y = up.y;
    ang = Math.atan2(ahead.y - up.y, ahead.x - up.x);
    faceLeft = undefined;
  }

  ctx.save();
  ctx.globalAlpha = (flying ? 0.3 * (1 - 0.65 * lift) : 0.22) * act.alpha;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.ellipse(
    sx,
    sy,
    18 * u * kk * (1 - 0.25 * lift),
    7 * u * kk * (1 - 0.25 * lift),
    0,
    0,
    Math.PI * 2
  );
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = act.alpha;
  drawVehicle(
    ctx,
    leg.mode,
    tl.theme,
    x,
    y,
    ang,
    u * kk * (flying ? 1 + 0.4 * lift : 1),
    faceLeft
  );
  ctx.restore();
}

/**
 * Do two chip rectangles overlap, allowing for a breathing gap.
 * @param {{left: number, top: number, w: number, h: number}} r Candidate.
 * @param {Array<{left: number, top: number, w: number, h: number}>} placed Already placed.
 * @param {number} gap Extra spacing.
 * @returns {boolean} True on any overlap.
 */
function collides(r, placed, gap) {
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    if (r.left < p.left + p.w + gap &&
      r.left + r.w + gap > p.left &&
      r.top < p.top + p.h + gap &&
      r.top + r.h + gap > p.top) return true;
  }
  return false;
}

/**
 * Paint one label chip with its tail.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tl Timeline.
 * @param {{left: number, top: number, w: number, h: number, side: string}} r
 *   Placement. `side` is where the chip sits relative to its pin: 'above',
 *   'below', 'right' or 'left'. The tail points back at the pin.
 * @param {number} px Pin x in drawing space, used to aim the tail.
 * @param {number} py Pin y in drawing space, used to aim the tail.
 * @param {string} text Label text, already ellipsized.
 * @param {number} alpha Opacity.
 * @param {number} fs Font size in drawing space.
 * @returns {void}
 */
function drawChip(ctx, tl, r, px, py, text, alpha, fs) {
  const u = tl.u;
  const chip = tl.theme.chip;
  const tailW = 9 * u;
  const tailH = 12 * u;
  const tx = clamp(px, r.left + 20 * u, r.left + r.w - 20 * u);
  const ty = clamp(py, r.top + 14 * u, r.top + r.h - 14 * u);

  ctx.save();
  ctx.globalAlpha = alpha;

  ctx.beginPath();
  roundRectPath(ctx, r.left, r.top, r.w, r.h, 16 * u);
  if (r.side === 'below') {
    ctx.moveTo(tx - tailW, r.top);
    ctx.lineTo(tx + tailW, r.top);
    ctx.lineTo(tx, r.top - tailH);
  } else if (r.side === 'right') {
    ctx.moveTo(r.left, ty - tailW);
    ctx.lineTo(r.left, ty + tailW);
    ctx.lineTo(r.left - tailH, ty);
  } else if (r.side === 'left') {
    ctx.moveTo(r.left + r.w, ty - tailW);
    ctx.lineTo(r.left + r.w, ty + tailW);
    ctx.lineTo(r.left + r.w + tailH, ty);
  } else {
    ctx.moveTo(tx - tailW, r.top + r.h);
    ctx.lineTo(tx + tailW, r.top + r.h);
    ctx.lineTo(tx, r.top + r.h + tailH);
  }
  ctx.closePath();
  ctx.shadowColor = 'rgba(0,0,0,.18)';
  setShadow(ctx, 12 * u, 0, 3 * u);
  ctx.fillStyle = chip.bg;
  ctx.fill();
  clearShadow(ctx);

  ctx.fillStyle = chip.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + fs + 'px ' + (chip.serif ? SERIF : SANS);
  ctx.fillText(text, r.left + r.w / 2, r.top + r.h / 2 + 1 * u);
  ctx.restore();
}

/**
 * Layer 8: stop labels.
 *
 * Each chip tries four places in turn, above, below, right and left of its
 * pin, and takes the first that is inside the frame, clear of the top strip
 * the platform overlays cover, and clear of every chip already placed. A
 * trip with thirty stops brings every label back at the outro, and with only
 * above and below to choose from most of them used to lose out to a
 * neighbour and vanish.
 *
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tl Timeline.
 * @param {number} t Seconds.
 * @param {{scale: number, ox: number, oy: number}} view Projection.
 * @returns {void}
 */
function drawChips(ctx, tl, t, view) {
  const u = tl.u;
  const dims = tl.dims;
  const chip = tl.theme.chip;
  const fs = chip.serif ? 32 * u : 34 * u;
  const padX = 20 * u;
  const padY = 12 * u;
  const pinR = 10 * u;
  const gap = 16 * u;
  const safe = tl.safe;
  const margin = Math.max(safe.left, safe.right) * u;
  const keepOut = tl.keepOut;
  const placed = [];

  // Inside the frame, and clear of every band the Reels player crops or
  // covers (see SAFE). The credits live on the bottom band's upper edge, so
  // this keeps labels off them as well.
  const inFrame = function (r) {
    if (r.left < 0 || r.top < 0 || r.left + r.w > dims.w || r.top + r.h > dims.h) return false;
    return !collides(r, keepOut, 0);
  };

  ctx.save();
  ctx.font = '600 ' + fs + 'px ' + (chip.serif ? SERIF : SANS);

  for (let s = 0; s < tl.stops.length; s++) {
    const alpha = chipAlpha(tl, s, t);
    if (alpha <= 0.01) continue;

    const anchor = screenOf(view, tl.world[s].x, tl.world[s].y, view.p3 ? PIN_HEIGHT * u : 0);
    if (!anchor.ok || (view.p3 && anchor.y < view.p3.cutY)) continue;
    const px = anchor.x;
    const py = anchor.y;
    // The horizontal clamp below keeps a chip on screen for a pin near the
    // edge. A pin past the edge would get a chip hugging it with a tail aimed
    // at nothing, so that case is culled on the pin before anything is sized.
    if (px < -pinR || px > dims.w + pinR) continue;

    const stop = tl.stops[s];
    const text = ellipsize(stop.label || stop.name || '', CHIP_MAX_CHARS);
    if (!text) continue;

    const w = ctx.measureText(text).width + padX * 2;
    const h = fs + padY * 2;
    // Above and below slide along the pin so an edge pin still gets its
    // label; right and left sit where they sit, and fall through if that is
    // off the frame.
    const left = clamp(px - w / 2, margin, Math.max(margin, dims.w - margin - w));
    const candidates = [
      { left: left, top: py - pinR - gap - h, w: w, h: h, side: 'above' },
      { left: left, top: py + pinR + gap, w: w, h: h, side: 'below' },
      { left: px + pinR + gap, top: py - h / 2, w: w, h: h, side: 'right' },
      { left: px - pinR - gap - w, top: py - h / 2, w: w, h: h, side: 'left' }
    ];

    let rect = null;
    for (let c = 0; c < candidates.length; c++) {
      const r = candidates[c];
      if (!inFrame(r)) continue;
      if (collides(r, placed, 6 * u)) continue;
      rect = r;
      break;
    }
    if (!rect) continue;

    placed.push(rect);
    drawChip(ctx, tl, rect, px, py, text, alpha, fs);
  }

  ctx.restore();
}

/**
 * Split a heading over at most two balanced lines.
 * @param {CanvasRenderingContext2D} ctx Context with the heading font set.
 * @param {string} text Heading.
 * @param {number} maxW Available width.
 * @returns {string[]} One or two lines.
 */
function wrapToTwoLines(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2) return [text];
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const score = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
    if (!best || score < best.score) best = { score: score, lines: [a, b] };
  }
  return best.lines;
}

/**
 * Layer 9: the opening title card.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tl Timeline.
 * @param {number} alpha Opacity.
 * @returns {void}
 */
function drawTitleCard(ctx, tl, alpha) {
  const u = tl.u;
  const dims = tl.dims;
  const theme = tl.theme;
  const stops = tl.stops;
  const fam = theme.chip.serif ? SERIF : SANS;

  const maxCardW = Math.min(dims.w * 0.82, dims.w - (tl.safe.left + tl.safe.right) * u);
  const padX = 48 * u;
  const padY = 36 * u;
  const innerMax = maxCardW - padX * 2;

  const given = String(tl.project.title == null ? '' : tl.project.title).trim();
  const first = stops[0].label || stops[0].name || '';
  const last = stops[stops.length - 1].label || stops[stops.length - 1].name || '';
  const heading = given || (first + ' to ' + last);

  let size = 64 * u;
  let lines = [heading];
  for (let guard = 0; guard < 30; guard++) {
    ctx.font = '700 ' + size + 'px ' + fam;
    lines = wrapToTwoLines(ctx, heading, innerMax);
    let widest = 0;
    for (let i = 0; i < lines.length; i++) {
      widest = Math.max(widest, ctx.measureText(lines[i]).width);
    }
    if (widest <= innerMax || size <= 30 * u) break;
    size *= 0.94;
  }

  ctx.font = '700 ' + size + 'px ' + fam;
  let widest = 0;
  for (let i = 0; i < lines.length; i++) {
    widest = Math.max(widest, ctx.measureText(lines[i]).width);
  }

  // A single long word cannot be wrapped and the fit loop bottoms out at 30u,
  // so trim what is left to the card rather than letting it run off the frame.
  if (widest > innerMax) {
    widest = 0;
    for (let i = 0; i < lines.length; i++) {
      lines[i] = truncateToWidth(ctx, lines[i], innerMax);
      widest = Math.max(widest, ctx.measureText(lines[i]).width);
    }
  }

  const subSize = 30 * u;
  const sub = stops.length + (stops.length === 1 ? ' stop, ' : ' stops, ') + groupNumber(tl.km) + ' km';
  ctx.font = '500 ' + subSize + 'px ' + fam;
  const subW = ctx.measureText(sub).width;

  const lineH = size * 1.16;
  const innerGap = 16 * u;
  const cardW = Math.min(maxCardW, Math.min(innerMax, Math.max(widest, subW)) + padX * 2);
  const cardH = padY * 2 + lines.length * lineH + innerGap + subSize * 1.1;
  const left = dims.w / 2 - cardW / 2;
  // The intro camera centres the first stop. A tall frame has room for the
  // card well above it; a square or wide one does not, so the card rides
  // higher there and the pin, its pulse and its chip stay in the clear.
  const tall = dims.h >= dims.w * 1.3;
  const top = dims.h * (tall ? 0.38 : 0.27) - cardH / 2;

  ctx.save();
  ctx.globalAlpha = alpha;

  ctx.beginPath();
  roundRectPath(ctx, left, top, cardW, cardH, 28 * u);
  ctx.shadowColor = 'rgba(0,0,0,.22)';
  setShadow(ctx, 30 * u, 0, 8 * u);
  ctx.fillStyle = theme.card.bg;
  ctx.fill();
  clearShadow(ctx);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = left + cardW / 2;
  let y = top + padY + lineH / 2;

  ctx.font = '700 ' + size + 'px ' + fam;
  ctx.fillStyle = theme.card.ink;
  if (theme.card.glow) {
    ctx.shadowColor = theme.card.glow;
    setShadow(ctx, 22 * u, 0, 0);
  }
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], cx, y);
    y += lineH;
  }
  clearShadow(ctx);

  ctx.font = '500 ' + subSize + 'px ' + fam;
  ctx.fillStyle = theme.card.sub;
  ctx.fillText(sub, cx, y - lineH / 2 + innerGap + subSize * 0.55);

  ctx.restore();
}

/**
 * Layer 10: the brand credit.
 *
 * Quiet corner text in the bottom left, on the same baseline and in the same
 * register as the map data credit opposite it, so the two corners mirror each
 * other. It borrows that credit's ink and contrast shadow, which keeps it
 * legible over light and dark imagery on every theme.
 *
 * Both credits sit inside the side insets: the Reels player shaves the sides
 * of a 9:16 file on tall phones, and text 20 px from the edge was being cut.
 *
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tl Timeline.
 * @returns {void}
 */
function drawWatermark(ctx, tl) {
  const u = tl.u;
  const dims = tl.dims;
  const ink = tl.theme.chip.ink;

  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.font = '500 ' + (20 * u) + 'px ' + SANS;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = isLightColor(ink) ? 'rgba(0,0,0,.7)' : 'rgba(255,255,255,.7)';
  setShadow(ctx, 0, u, u);
  ctx.fillStyle = ink;
  ctx.fillText('mynextstop.online', tl.safe.left * u, dims.h - tl.safe.bottom * u);
  ctx.restore();
}

/**
 * Layer 11: the map data credit.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} tl Timeline.
 * @returns {void}
 */
function drawAttribution(ctx, tl) {
  const u = tl.u;
  const dims = tl.dims;
  const ink = tl.theme.chip.ink;

  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.font = '400 ' + (17 * u) + 'px ' + SANS;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = isLightColor(ink) ? 'rgba(0,0,0,.7)' : 'rgba(255,255,255,.7)';
  setShadow(ctx, 0, u, u);
  ctx.fillStyle = ink;
  const inset = Math.max(tl.safe.right, tl.safe.rail) * u;
  ctx.fillText(tl.theme.attribution, dims.w - inset, dims.h - tl.safe.bottom * u);
  ctx.restore();
}

/**
 * Draw one complete frame.
 *
 * The context transform must already map drawing space to `timeline.dims`.
 * Time is clamped to the timeline, and nothing here reads the clock, so the
 * same `t` always produces the same pixels.
 *
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} timeline A timeline from buildTimeline.
 * @param {number} t Seconds from the start.
 * @param {object|null} tiles A TileCache, or null to render without a basemap.
 * @returns {void}
 */
export function renderFrame(ctx, timeline, t, tiles) {
  const tl = timeline;
  const dims = tl.dims;
  const time = t <= 0 ? 0 : (t >= tl.duration ? tl.duration : t);

  // Shadows ignore the transform, so every shadow size in this frame is
  // corrected by the transform's own scale. Preview and export then match.
  shadowScale = transformScaleOf(ctx);

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.setLineDash([]);
  clearShadow(ctx);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = tl.theme.bg;
  ctx.fillRect(0, 0, dims.w, dims.h);

  let view;
  const cam3 = tl.is3d ? camera3At(tl, time) : null;
  if (cam3 && cam3.pitch > FLAT_PITCH) {
    view = drawGround3d(ctx, tl, time, tiles, cam3);
  } else {
    const cam = cameraAt(tl, time);
    const scale = 256 * Math.pow(2, cam.zoom);
    view = {
      scale: scale,
      ox: dims.w / 2 - cam.cx * scale,
      oy: dims.h / 2 - cam.cy * scale
    };
    drawTiles(ctx, tl, cam, tiles);
    drawWash(ctx, tl);
    drawTrails(ctx, tl, time, view);
    drawSweep(ctx, tl, time, view);
    drawPulses(ctx, tl, time, view);
  }
  drawPins(ctx, tl, time, view);
  drawVehicleLayer(ctx, tl, time, view);
  drawChips(ctx, tl, time, view);

  const ta = titleAlpha(tl, time);
  if (ta > 0.001) drawTitleCard(ctx, tl, ta);

  drawWatermark(ctx, tl);
  drawAttribution(ctx, tl);

  ctx.restore();
}

/**
 * Size a preview canvas and hand back a context ready for renderFrame.
 *
 * The backing store is sized to the CSS width times devicePixelRatio, capped at
 * 2, and the transform is set so drawing space equals `timeline.dims`.
 *
 * @param {HTMLCanvasElement} canvas The preview canvas.
 * @param {object} timeline A timeline from buildTimeline.
 * @param {number} cssWidth Layout width in CSS pixels.
 * @returns {CanvasRenderingContext2D} A context with the transform applied.
 */
export function setupPreviewCanvas(canvas, timeline, cssWidth) {
  const dims = timeline.dims;
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const width = Math.max(1, Math.round(cssWidth));
  const height = Math.max(1, Math.round(width * (dims.h / dims.w)));

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';

  const ctx = canvas.getContext('2d', { alpha: false });
  // Scale each axis to its own rounded backing size. A single scale taken from
  // the width can leave the last row of device pixels unpainted, and on an
  // opaque context that row shows up as a black hairline under the frame. The
  // aspect error this trades it for is under a tenth of a percent.
  ctx.setTransform(canvas.width / dims.w, 0, 0, canvas.height / dims.h, 0, 0);
  return ctx;
}
