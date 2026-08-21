// The map IS the UI. Stateful Leaflet manager: season dots, the selected
// pick's route arc from the origin, and dashed "onward" arcs to the pick's
// own next hops. Leaflet renders tiles as plain <img> and dots on a 2D
// canvas: no WebGL anywhere, which is the point. The MapLibre globe wedged
// real-world GPU drivers (compositor froze permanently), so the proven
// raster stack is back for good.
//
// India-compliant borders: raster tiles bake in the international depiction
// of J&K / Aksai Chin / Arunachal, not the Survey of India one. We can't
// repaint tile pixels, so India's official national boundary
// (data/india-border.geojson) is drawn as a thin line on top, colored to
// match the basemap's own admin lines.
import { seasonStatus, travelText } from './engine.js';

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const SRI_JS = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
const SRI_CSS = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';

const STATUS_COLOR = { peak: '#0f9d6e', shoulder: '#e8890c', off: '#98928a', avoid: '#d4482c' };
// labeled tiles: place names on the basemap do real wayfinding work
const TILE_STYLES = { light: 'rastertiles/voyager', dark: 'dark_all' };
// matches CARTO's own admin-boundary line color in each style
const BORDER_COLOR = { light: '#b3a59a', dark: '#5b5f66' };
const ROUTE_COLOR = { light: '#0e7a6c', dark: '#2fae9c' };
const CASING_OPACITY = { light: 0.85, dark: 0.4 };

let map = null, dotsLayer = null, routeLayer = null, tiles = null, borderLayer = null;
let loading = null, onSelect = null;
let theme = 'light';
// season dots are cached and patched in place: rebuilding every marker on
// each "Next" tap was DOM/GC churn for a change that touches two dots
let dotMarkers = new Map();   // dest id -> { marker, status }
let dotsSig = '';             // month|theme the cache was built for
let selectedId = null;
// the live route line and its permanent label: kept so a zoom change can
// decide whether the label still has a route under it (updateRouteLabel)
let routeLine = null, routeEnds = null;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = LEAFLET_CSS;
    css.integrity = SRI_CSS; css.crossOrigin = 'anonymous';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = LEAFLET_JS; js.integrity = SRI_JS; js.crossOrigin = 'anonymous';
    js.onload = resolve;
    // reset the cache on failure so a later tap can retry instead of
    // replaying the same rejected promise forever
    js.onerror = () => { loading = null; reject(new Error('leaflet failed')); };
    document.head.appendChild(js);
  });
  return loading;
}

function setTiles() {
  const L = window.L;
  if (tiles) map.removeLayer(tiles);
  tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${TILE_STYLES[theme]}/{z}/{x}/{y}{r}.png`, {
    attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 19,
  }).addTo(map);
  tiles.bringToBack();
}

// India's official boundary on its own pane: above tiles (200), below
// overlays (400). Failure is non-fatal: the map still works, just with
// tile borders.
async function addIndiaBorder() {
  try {
    const res = await fetch('data/india-border.geojson');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const geo = await res.json();
    const pane = map.createPane('india-border');
    pane.style.zIndex = 250;
    pane.style.pointerEvents = 'none';
    borderLayer = window.L.geoJSON(geo, {
      pane: 'india-border',
      interactive: false,
      style: {
        color: BORDER_COLOR[theme], weight: 1, opacity: 0.95,
        fill: false, lineJoin: 'round', lineCap: 'round',
      },
    }).addTo(map);
  } catch (err) {
    console.warn('India boundary overlay failed to load:', err);
  }
}

// Switch basemap + border color live (theme toggle / OS change). The caller
// re-renders routes so arcs pick up the themed color too.
export function setMapTheme(t) {
  theme = t === 'dark' ? 'dark' : 'light';
  if (!map) return;
  setTiles();
  if (borderLayer) borderLayer.setStyle({ color: BORDER_COLOR[theme] });
  dotsSig = '';  // dot ring color is theme-dependent: next update rebuilds
}

export async function initMap(el, selectCallback, initialTheme = 'light') {
  await loadLeaflet();
  onSelect = selectCallback;
  theme = initialTheme === 'dark' ? 'dark' : 'light';
  if (map) return;
  const L = window.L;
  // canvas renderer: several hundred season dots are strokes on one canvas
  // instead of as many SVG nodes; pans and zooms stay smooth and updates
  // don't touch the DOM
  map = L.map(el, { zoomControl: false, attributionControl: false, minZoom: 4, maxZoom: 13, preferCanvas: true });
  L.control.zoom({ position: 'topright' }).addTo(map);
  // bottom-left: the desktop sheet docks over the bottom-right corner
  L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);
  map.setView([22.5, 80], 5);
  setTiles();
  addIndiaBorder();
  dotsLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  // bound once: this is the only place a map is ever created
  map.on('zoomend', updateRouteLabel);
  if (location.hostname === 'localhost') window.__map = map;  // dev-only probe
}

// Quadratic-bezier arc between two latlngs: an honest "this way" indication,
// not turn-by-turn (the Directions button hands off to Google Maps for
// that). Bows northward for a consistent look.
function arcPoints(a, b, curvature = 0.15) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let ox = -dy * curvature, oy = dx * curvature;
  if (ox < 0) { ox = -ox; oy = -oy; }
  const cx = (a[0] + b[0]) / 2 + ox, cy = (a[1] + b[1]) / 2 + oy;
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48, u = 1 - t;
    pts.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0],
              u * u * a[1] + 2 * u * t * cy + t * t * b[1]]);
  }
  return pts;
}

function dotStyle(status) {
  return {
    radius: status === 'peak' ? 7.5 : 6,
    color: theme === 'dark' ? '#23262b' : '#fff', weight: 1.5,
    fillColor: STATUS_COLOR[status],
    fillOpacity: status === 'avoid' ? 0.5 : 0.95,
  };
}

// season dots: every destination, always visible: the map is the catalogue.
// Built once per (month, theme); selection changes just restyle two markers.
function drawDots(dests, month) {
  const L = window.L;
  const sig = month + '|' + theme;
  if (sig === dotsSig && dotMarkers.size) return;
  dotMarkers.clear();
  dotsLayer.clearLayers();
  for (const d of dests) {
    const status = seasonStatus(d, month);
    const m = L.circleMarker([d.lat, d.lng], dotStyle(status));
    m.bindTooltip(d.name, { direction: 'top', offset: [0, -8], opacity: 0.94 });
    m.on('click', () => onSelect && onSelect(d));
    m.addTo(dotsLayer);
    dotMarkers.set(d.id, { marker: m, status });
  }
  dotsSig = sig;
  selectedId = null;
}

function setSelectedDot(id) {
  if (id === selectedId) return;
  const prev = dotMarkers.get(selectedId);
  if (prev) {
    prev.marker.setStyle({ weight: 1.5 });
    prev.marker.setRadius(dotStyle(prev.status).radius);
  }
  const next = dotMarkers.get(id);
  if (next) {
    next.marker.setStyle({ weight: 3 });
    next.marker.setRadius(11);
    next.marker.bringToFront();
  }
  selectedId = id;
}

// The route label is ~150 px wide. At the national view the whole route can
// be 40 px, leaving the label orphaned over an invisible line, and the sheet
// already states the same km/time. So the label only shows when the route is
// comfortably wider than its own label. Safe to call at any time: it no-ops
// once the route layer has been cleared.
function updateRouteLabel() {
  if (!map || !routeLine || !routeEnds || !map.hasLayer(routeLine)) return;
  const tip = routeLine.getTooltip && routeLine.getTooltip();
  const el = tip && tip.getElement();
  if (!el) return;
  const routePx = map.latLngToContainerPoint(routeEnds[0])
    .distanceTo(map.latLngToContainerPoint(routeEnds[1]));
  const labelWidth = el.offsetWidth || 160;
  el.classList.toggle('route-label-hidden', routePx < labelWidth * 1.15);
}

// Frame the trip: origin, pick and its onward hops, under the top bar and
// the sheet. Used by the render's own fit and by a tap on the route.
function fitRoute(a, b, onward) {
  const bounds = window.L.latLngBounds([a, b]);
  for (const o of onward) bounds.extend([o.d.lat, o.d.lng]);
  const pads = {
    paddingTopLeft: [36, 130],
    paddingBottomRight: [36, Math.min(window.innerHeight * 0.32, 260)],
    maxZoom: 9,
  };
  safeFit(() => {
    if (reducedMotion()) map.fitBounds(bounds, { ...pads, animate: false });
    else map.flyToBounds(bounds, { ...pads, duration: 0.7 });
  });
}

/**
 * Redraw everything. state:
 *  { dests, month, origin, selected: {d, roadKm, hours, status} | null,
 *    onward: [{d, roadKm}], fit: bool }
 */
export function updateMap(state) {
  if (!map) return;
  const L = window.L;
  const { dests, month, origin, selected, onward = [], fit = false } = state;

  // cancel any in-flight fly animation and explicitly unbind tooltips:
  // permanent tooltips can survive clearLayers() mid-animation
  map.stop();
  routeLayer.eachLayer(l => { if (l.getTooltip && l.getTooltip()) l.unbindTooltip(); });
  routeLayer.clearLayers();
  routeLine = null; routeEnds = null;

  drawDots(dests, month);
  setSelectedDot(selected ? selected.d.id : null);

  // origin: the pulsing blue "you are here" dot
  if (origin) {
    const originIcon = L.divIcon({
      className: 'origin-dot-anchor',
      html: '<div class="origin-dot"><i></i></div>',
      iconSize: [16, 16], iconAnchor: [8, 8],
    });
    L.marker([origin.lat, origin.lng], { icon: originIcon, keyboard: false })
      .bindTooltip('You are here', { direction: 'top', offset: [0, -10] })
      .addTo(routeLayer);
  }

  // the route: origin to pick
  if (origin && selected) {
    const a = [origin.lat, origin.lng], b = [selected.d.lat, selected.d.lng];
    const pts = arcPoints(a, b);
    L.polyline(pts, { color: '#ffffff', weight: 7, opacity: CASING_OPACITY[theme], interactive: false }).addTo(routeLayer);
    const line = L.polyline(pts, { color: ROUTE_COLOR[theme], weight: 3.5, opacity: 0.95, interactive: false }).addTo(routeLayer);
    line.bindTooltip(`≈ ${travelText(selected.roadKm, selected.hours)}`, {
      permanent: true, direction: 'center', className: 'route-label', opacity: 1, interactive: true,
    });
    routeLine = line; routeEnds = [a, b];

    // a fat invisible line over the arc: when the route is a hairline at the
    // national view, tapping it (or its label) frames the trip instead.
    // Sent to the back so the canvas renderer still hands clicks and hovers
    // to any season dot sitting inside the corridor (topmost layer wins).
    const frame = () => fitRoute(a, b, onward);
    L.polyline(pts, { weight: 24, opacity: 0.001, interactive: true, className: 'route-hit' })
      .addTo(routeLayer).on('click', frame).bringToBack();
    const tipEl = line.getTooltip() && line.getTooltip().getElement();
    if (tipEl) tipEl.addEventListener('click', frame);
    updateRouteLabel();

    // onward hints: where you'd go NEXT from there: the "next stop" chain.
    // Unlabelled dashed arcs; their names live in the card, so the map
    // carries exactly one floating label (the route distance).
    for (const o of onward) {
      const pts2 = arcPoints(b, [o.d.lat, o.d.lng], 0.12);
      L.polyline(pts2, {
        color: ROUTE_COLOR[theme], weight: 2, opacity: 0.55, dashArray: '4 7', interactive: false,
      }).addTo(routeLayer);
    }

    if (fit) fitRoute(a, b, onward);
  } else if (fit && origin) {
    safeFit(() => {
      if (reducedMotion()) map.setView([origin.lat, origin.lng], 6, { animate: false });
      else map.flyTo([origin.lat, origin.lng], 6, { duration: 0.7 });
    });
  }
}

// A camera move is cosmetic: it must never break a render. Leaflet's fly
// math can NaN when the container size is degenerate (first paint racing
// layout, mid-rotation resizes); state is already correct, so skip the move
// and let the next interaction re-fit.
function safeFit(run) {
  const size = map.getSize();
  if (!size.x || !size.y) return;
  try { run(); } catch { /* skip the animation, keep the state */ }
}

export function nudgeMap() {
  if (map) setTimeout(() => map.invalidateSize(), 80);
}
