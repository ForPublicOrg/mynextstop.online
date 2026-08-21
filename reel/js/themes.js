/**
 * themes.js
 * The five reel looks, plus the vector card art used by the style picker.
 *
 * Every numeric size in a theme is a pre unit value: the renderer multiplies
 * it by `u = min(dims.w, dims.h) / 1080` so a 9:16 reel and a 16:9 wide export
 * carry the same visual density.
 *
 * No DOM access beyond the canvas context handed to paintSwatch.
 */

const CARTO_SUBDOMAINS = ['a', 'b', 'c', 'd'];
const CARTO_ATTRIBUTION = '© OpenStreetMap contributors © CARTO';
const ESRI_ATTRIBUTION = '© Esri, Maxar, Earthstar Geographics';

/**
 * Build a Carto raster tile template.
 * @param {string} path Style path, for example 'rastertiles/voyager_nolabels'.
 * @returns {{template: string, subdomains: string[], size: number, zoomBias: number, minZoom: number, maxZoom: number}}
 *   A tiles spec.
 */
function cartoTiles(path) {
  return {
    template: 'https://{s}.basemaps.cartocdn.com/' + path + '/{z}/{x}/{y}@2x.png',
    subdomains: CARTO_SUBDOMAINS.slice(),
    size: 512,
    zoomBias: 0,
    minZoom: 2,
    maxZoom: 19
  };
}

/** Default theme id, used when a project carries an unknown theme. */
export const DEFAULT_THEME = 'voyage';

/**
 * The five themes.
 *
 * Route notes: `dash` applies to every leg mode, `planeDash` applies only to
 * plane legs and wins over `dash` when both are present. A `gradient` runs from
 * the first stop of the route to the current vehicle head and takes precedence
 * over `color`.
 *
 * `roadGlow` is the wide soft underlay drawn beneath legs that follow a real
 * road: `{ color, widthMult, alpha }`, stroked at `route.width * widthMult`
 * with no shadow, because a wide low alpha stroke is the glow. It is null on
 * the themes that already glow through shadowBlur.
 *
 * @type {Object<string, object>}
 */
export const THEMES = {
  voyage: {
    id: 'voyage',
    name: 'Voyage',
    tiles: cartoTiles('rastertiles/voyager_nolabels'),
    bg: '#e8ecec',
    overlay: null,
    vignette: 0,
    route: {
      color: '#0e7a6c',
      gradient: null,
      width: 10,
      casing: { color: '#ffffff', width: 16 },
      glow: null,
      roadGlow: { color: '#0e7a6c', widthMult: 2.4, alpha: 0.16 },
      dash: null,
      planeDash: [1, 26]
    },
    vehicle: { fill: '#0e7a6c', stroke: '#ffffff' },
    pin: { fill: '#0e7a6c', ring: '#ffffff' },
    chip: { bg: '#ffffff', ink: '#1b1e22', serif: false },
    card: { bg: 'rgba(255,255,255,.94)', ink: '#12161a', sub: '#5b6470', glow: null },
    watermark: { bg: 'rgba(255,255,255,.80)', ink: '#3d464f' },
    attribution: CARTO_ATTRIBUTION,
    swatch: { top: '#eef2f1', bottom: '#dbe4e2' }
  },

  noir: {
    id: 'noir',
    name: 'Noir',
    tiles: cartoTiles('dark_nolabels'),
    bg: '#14171a',
    overlay: null,
    vignette: 0.35,
    route: {
      color: '#f5b42a',
      gradient: null,
      width: 9,
      casing: { color: 'rgba(0,0,0,.55)', width: 15 },
      glow: null,
      roadGlow: { color: '#f5b42a', widthMult: 2.4, alpha: 0.18 },
      dash: null,
      planeDash: [1, 24]
    },
    vehicle: { fill: '#f5b42a', stroke: 'rgba(0,0,0,.85)' },
    pin: { fill: '#f5b42a', ring: '#f8fafc' },
    chip: { bg: '#1e2126', ink: '#f3f4f6', serif: false },
    card: { bg: 'rgba(20,23,26,.94)', ink: '#f8fafc', sub: '#a3aab4', glow: null },
    watermark: { bg: 'rgba(30,33,38,.82)', ink: '#d5dae0' },
    attribution: CARTO_ATTRIBUTION,
    swatch: { top: '#23272c', bottom: '#101315' }
  },

  vintage: {
    id: 'vintage',
    name: 'Vintage',
    tiles: cartoTiles('light_nolabels'),
    bg: '#efe7d6',
    overlay: { color: 'rgba(226,200,152,.35)', blend: 'multiply' },
    vignette: 0.28,
    route: {
      color: '#b3382c',
      gradient: null,
      width: 8,
      casing: { color: 'rgba(255,250,238,.9)', width: 14 },
      glow: null,
      roadGlow: { color: '#b3382c', widthMult: 2.2, alpha: 0.1 },
      dash: [22, 16],
      planeDash: [22, 16]
    },
    vehicle: { fill: '#b3382c', stroke: '#fffaee' },
    pin: { fill: '#b3382c', ring: '#fffaee' },
    chip: { bg: '#f7efdd', ink: '#41321f', serif: true },
    card: { bg: 'rgba(247,239,221,.94)', ink: '#3a2c1a', sub: '#7a6647', glow: null },
    watermark: { bg: 'rgba(247,239,221,.82)', ink: '#5b4a30' },
    attribution: CARTO_ATTRIBUTION,
    swatch: { top: '#f4ecdb', bottom: '#e2d3b4' }
  },

  satellite: {
    id: 'satellite',
    name: 'Satellite',
    tiles: {
      template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      subdomains: [],
      size: 256,
      zoomBias: 1,
      minZoom: 2,
      maxZoom: 18
    },
    bg: '#0b0e12',
    overlay: null,
    vignette: 0.3,
    route: {
      color: '#ffffff',
      gradient: null,
      width: 9,
      casing: { color: 'rgba(0,0,0,.35)', width: 15 },
      glow: { color: 'rgba(255,255,255,.8)', blur: 14 },
      // Already glows through shadowBlur. A second underlay would double it.
      roadGlow: null,
      dash: null,
      planeDash: [1, 24]
    },
    vehicle: { fill: '#ffffff', stroke: 'rgba(0,0,0,.55)' },
    pin: { fill: '#ffffff', ring: 'rgba(0,0,0,.55)' },
    chip: { bg: 'rgba(10,14,20,.82)', ink: '#ffffff', serif: false },
    card: { bg: 'rgba(10,14,20,.94)', ink: '#ffffff', sub: '#c4cdd6', glow: null },
    watermark: { bg: 'rgba(10,14,20,.78)', ink: '#e8eef4' },
    attribution: ESRI_ATTRIBUTION,
    swatch: { top: '#23343f', bottom: '#0b0e12' }
  },

  neon: {
    id: 'neon',
    name: 'Neon',
    tiles: cartoTiles('dark_nolabels'),
    bg: '#0b1020',
    overlay: { color: 'rgba(20,16,64,.35)', blend: 'overlay' },
    vignette: 0.4,
    route: {
      color: null,
      gradient: ['#22d3ee', '#e879f9'],
      width: 9,
      casing: null,
      glow: { color: 'rgba(103,232,249,.9)', blur: 18 },
      // Already glows through shadowBlur. A second underlay would double it.
      roadGlow: null,
      dash: null,
      planeDash: null
    },
    vehicle: { fill: '#e0f2fe', stroke: 'rgba(11,16,32,.9)' },
    pin: { fill: '#22d3ee', ring: '#f0f9ff' },
    chip: { bg: 'rgba(11,16,32,.88)', ink: '#e0f2fe', serif: false },
    card: { bg: 'rgba(11,16,32,.94)', ink: '#e0f2fe', sub: '#7dd3fc', glow: 'rgba(103,232,249,.9)' },
    watermark: { bg: 'rgba(11,16,32,.82)', ink: '#a5f3fc' },
    attribution: CARTO_ATTRIBUTION,
    swatch: { top: '#1a1e46', bottom: '#0b1020' }
  }
};

/**
 * Trace a rounded rectangle. Used instead of ctx.roundRect, which is missing on
 * older Safari and older Chromium.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {number} x Left edge.
 * @param {number} y Top edge.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} r Corner radius, clamped to half the shorter side.
 * @returns {void}
 */
export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Scale a dash pattern.
 * @param {number[]|null} dash Source pattern.
 * @param {number} k Multiplier.
 * @returns {number[]} Scaled pattern, empty when there is no dash.
 */
function scaleDash(dash, k) {
  if (!dash || !dash.length) return [];
  return dash.map(function (v) { return v * k; });
}

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
 * Paint the style picker card art for a theme.
 *
 * Draws no tiles: a background wash, one route sample in the theme's exact
 * route style, one pin and one small chip. Everything is vector, so it stays
 * crisp when the caller has scaled the context by devicePixelRatio.
 *
 * @param {CanvasRenderingContext2D} ctx Target context, already scaled to CSS pixels.
 * @param {object} theme A member of THEMES.
 * @param {number} w Card width in CSS pixels.
 * @param {number} h Card height in CSS pixels.
 * @returns {void}
 */
export function paintSwatch(ctx, theme, w, h) {
  const s = w / 96;
  const route = theme.route;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();

  // Background wash.
  const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
  bgGrad.addColorStop(0, theme.swatch.top);
  bgGrad.addColorStop(1, theme.swatch.bottom);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  if (theme.overlay) {
    ctx.globalCompositeOperation = theme.overlay.blend;
    ctx.fillStyle = theme.overlay.color;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }

  // Route sample: one confident curve across the card.
  const ax = w * 0.14;
  const ay = h * 0.74;
  const bx = w * 0.78;
  const by = h * 0.32;
  const cx = w * 0.30;
  const cy = h * 0.26;

  const mainW = 3.4 * s;
  const k = route.width > 0 ? mainW / route.width : s;
  const dash = scaleDash(route.dash, k);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (route.casing) {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(cx, cy, bx, by);
    ctx.setLineDash(dash);
    ctx.strokeStyle = route.casing.color;
    ctx.lineWidth = route.casing.width * k;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(cx, cy, bx, by);
  ctx.setLineDash(dash);
  if (route.gradient) {
    const g = ctx.createLinearGradient(ax, ay, bx, by);
    g.addColorStop(0, route.gradient[0]);
    g.addColorStop(1, route.gradient[1]);
    ctx.strokeStyle = g;
  } else {
    ctx.strokeStyle = route.color || '#ffffff';
  }
  ctx.lineWidth = mainW;
  if (route.glow) {
    // shadowBlur ignores the current transform, so a dpr-scaled card would
    // otherwise glow dpr times fatter than a 1x one. Correct it the way
    // scene.js corrects its own shadows.
    ctx.shadowColor = route.glow.color;
    ctx.shadowBlur = route.glow.blur * k * transformScaleOf(ctx);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  ctx.setLineDash([]);

  // Pin at the head of the route.
  ctx.beginPath();
  ctx.arc(bx, by, 4.2 * s, 0, Math.PI * 2);
  ctx.fillStyle = theme.pin.fill;
  ctx.fill();
  ctx.lineWidth = 1.6 * s;
  ctx.strokeStyle = theme.pin.ring;
  ctx.stroke();

  // Small chip near the start of the route.
  const chipW = 30 * s;
  const chipH = 11 * s;
  const chipX = Math.min(w - chipW - 5 * s, Math.max(5 * s, ax - chipW * 0.28));
  const chipY = ay + 7 * s;
  ctx.beginPath();
  roundRectPath(ctx, chipX, chipY, chipW, chipH, 4 * s);
  ctx.fillStyle = theme.chip.bg;
  ctx.fill();
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  roundRectPath(ctx, chipX + 4 * s, chipY + 4 * s, chipW - 12 * s, 3 * s, 1.5 * s);
  ctx.fillStyle = theme.chip.ink;
  ctx.fill();
  ctx.globalAlpha = 1;

  if (theme.vignette > 0) {
    const r = Math.sqrt(w * w + h * h) / 2;
    const vg = ctx.createRadialGradient(w / 2, h / 2, r * 0.35, w / 2, h / 2, r);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,' + (theme.vignette * 0.7).toFixed(3) + ')');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  ctx.restore();
}
