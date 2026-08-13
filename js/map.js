// The map IS the UI. MapLibre GL manager: a Google-style 3D globe at low zoom,
// labeled CARTO raster tiles, season dots as one WebGL circle layer, the
// selected pick's route arc and dashed onward arcs, plus HTML markers for the
// origin dot, the route distance pill and the selected place name.
//
// India-compliant borders: raster tiles bake in the international depiction of
// J&K / Aksai Chin / Arunachal, not the Survey of India one. We can't repaint
// tile pixels, so India's official national boundary (data/india-border.geojson)
// is drawn as a thin line on top, colored to match the basemap's admin lines.
import { seasonStatus, travelText } from './engine.js';

const ML_JS = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js';
const ML_CSS = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css';
const SRI_JS = 'sha256-RamwepGJzlYFTGIKlHzPQeKR5YyV6bYVM7dAqqZe5cs=';
const SRI_CSS = 'sha256-qx5w1Z7EBGW65+cDDaLzzPKBM/1QLmK9WY7vut/XpzI=';

const STATUS_COLOR = { peak: '#0f9d6e', shoulder: '#e8890c', off: '#98928a', avoid: '#d4482c' };
const TILE_STYLES = { light: 'rastertiles/voyager', dark: 'dark_all' };
// matches CARTO's own admin-boundary line color in each style
const BORDER_COLOR = { light: '#b3a59a', dark: '#5b5f66' };
const ROUTE_COLOR = { light: '#0e7a6c', dark: '#2fae9c' };
const CASING_OPACITY = { light: 0.85, dark: 0.4 };
const DOT_STROKE = { light: '#ffffff', dark: '#23262b' };
// the "space" behind the globe
const SPACE_COLOR = { light: '#dfe6ec', dark: '#07090c' };

const EMPTY = { type: 'FeatureCollection', features: [] };

let map = null, loading = null, onSelect = null;
let theme = 'light';
let byId = new Map();         // dest id -> destination (for click handling)
let dotsSig = '';             // month|selectedId the dots source was built for
let originMarker = null, labelMarker = null, nameMarker = null, hoverPopup = null;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = ML_CSS;
    css.integrity = SRI_CSS; css.crossOrigin = 'anonymous';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = ML_JS; js.integrity = SRI_JS; js.crossOrigin = 'anonymous';
    js.onload = resolve;
    // reset the cache on failure so a later tap can retry instead of
    // replaying the same rejected promise forever
    js.onerror = () => { loading = null; reject(new Error('maplibre failed')); };
    document.head.appendChild(js);
  });
  return loading;
}

function skyFor(t) {
  return t === 'dark' ? {
    'sky-color': '#101418',
    'horizon-color': '#1a2029',
    'fog-color': '#07090c',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.8,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.8, 5, 0.5, 7, 0],
  } : {
    'sky-color': '#bcd8f0',
    'horizon-color': '#ffffff',
    'fog-color': '#ffffff',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.8,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.8, 5, 0.5, 7, 0],
  };
}

function tileUrls(style) {
  const retina = (window.devicePixelRatio || 1) > 1 ? '@2x' : '';
  return ['a', 'b', 'c', 'd'].map(s =>
    `https://${s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}${retina}.png`);
}

const SEL = ['boolean', ['get', 'sel'], false];
const dotRadius = (sel, peak, other) => ['case', SEL, sel,
  ['match', ['get', 'status'], 'peak', peak, other]];

function baseStyle() {
  return {
    version: 8,
    projection: { type: 'globe' },
    sky: skyFor(theme),
    sources: {
      'carto-light': { type: 'raster', tiles: tileUrls(TILE_STYLES.light), tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap © CARTO' },
      'carto-dark': { type: 'raster', tiles: tileUrls(TILE_STYLES.dark), tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap © CARTO' },
      route: { type: 'geojson', data: EMPTY },
      dests: { type: 'geojson', data: EMPTY },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': SPACE_COLOR[theme] } },
      { id: 'tiles-light', type: 'raster', source: 'carto-light', layout: { visibility: theme === 'light' ? 'visible' : 'none' } },
      { id: 'tiles-dark', type: 'raster', source: 'carto-dark', layout: { visibility: theme === 'dark' ? 'visible' : 'none' } },
      {
        id: 'route-casing', type: 'line', source: 'route',
        filter: ['==', ['get', 'kind'], 'route'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': CASING_OPACITY[theme] },
      },
      {
        id: 'route-line', type: 'line', source: 'route',
        filter: ['==', ['get', 'kind'], 'route'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ROUTE_COLOR[theme], 'line-width': 3.5, 'line-opacity': 0.95 },
      },
      {
        id: 'route-onward', type: 'line', source: 'route',
        filter: ['==', ['get', 'kind'], 'onward'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ROUTE_COLOR[theme], 'line-width': 2, 'line-opacity': 0.55, 'line-dasharray': [0.8, 2.4] },
      },
      {
        id: 'dots', type: 'circle', source: 'dests',
        layout: {
          'circle-sort-key': ['case', SEL, 3,
            ['match', ['get', 'status'], 'peak', 2, 'shoulder', 1, 0]],
        },
        paint: {
          // dots grow with zoom so the zoomed-out globe stays readable
          'circle-radius': ['interpolate', ['linear'], ['zoom'],
            3, dotRadius(7, 3.6, 3),
            6, dotRadius(11, 6.5, 5.5),
            10, dotRadius(13, 8, 7)],
          'circle-color': ['match', ['get', 'status'],
            'peak', STATUS_COLOR.peak, 'shoulder', STATUS_COLOR.shoulder,
            'avoid', STATUS_COLOR.avoid, STATUS_COLOR.off],
          'circle-opacity': ['match', ['get', 'status'], 'avoid', 0.55, 0.95],
          'circle-stroke-width': ['case', SEL, 2.5, 1.5],
          'circle-stroke-color': DOT_STROKE[theme],
        },
      },
    ],
  };
}

// India's official boundary, under the route arcs. Failure is non-fatal:
// the map still works, just with tile borders.
async function addIndiaBorder() {
  try {
    const res = await fetch('data/india-border.geojson');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const geo = await res.json();
    if (!map || map.getSource('india-border')) return;
    map.addSource('india-border', { type: 'geojson', data: geo });
    map.addLayer({
      id: 'india-border', type: 'line', source: 'india-border',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': BORDER_COLOR[theme], 'line-width': 1, 'line-opacity': 0.95 },
    }, 'route-casing');
  } catch (err) {
    console.warn('India boundary overlay failed to load:', err);
  }
}

// Switch basemap, sky and layer colors live (theme toggle / OS change).
// Both raster sources sit in the style; switching is a visibility flip,
// no style rebuild and no lost sources.
export function setMapTheme(t) {
  theme = t === 'dark' ? 'dark' : 'light';
  if (!map) return;
  // style still parsing: the toggle re-runs via the next flush
  if (!styleReady()) { map.once('styledata', () => setMapTheme(theme)); return; }
  map.setLayoutProperty('tiles-light', 'visibility', theme === 'light' ? 'visible' : 'none');
  map.setLayoutProperty('tiles-dark', 'visibility', theme === 'dark' ? 'visible' : 'none');
  map.setPaintProperty('bg', 'background-color', SPACE_COLOR[theme]);
  map.setPaintProperty('route-casing', 'line-opacity', CASING_OPACITY[theme]);
  map.setPaintProperty('route-line', 'line-color', ROUTE_COLOR[theme]);
  map.setPaintProperty('route-onward', 'line-color', ROUTE_COLOR[theme]);
  map.setPaintProperty('dots', 'circle-stroke-color', DOT_STROKE[theme]);
  if (map.getLayer('india-border')) map.setPaintProperty('india-border', 'line-color', BORDER_COLOR[theme]);
  map.setSky(skyFor(theme));
}

export async function initMap(el, selectCallback, initialTheme = 'light') {
  await loadMapLibre();
  onSelect = selectCallback;
  theme = initialTheme === 'dark' ? 'dark' : 'light';
  if (map) return;
  const ml = window.maplibregl;

  map = new ml.Map({
    container: el,
    style: baseStyle(),
    center: [80.5, 22.5],
    zoom: 3.2,
    minZoom: 1.5,
    maxZoom: 13,
    attributionControl: false,
  });
  map.addControl(new ml.AttributionControl({ compact: true }), 'bottom-left');
  // keep gestures simple: pan + zoom only, no rotate or pitch
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  if (map.touchPitch) map.touchPitch.disable();
  map.keyboard.disableRotation();
  map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');

  map.on('click', 'dots', e => {
    const f = e.features && e.features[0];
    if (!f) return;
    const d = byId.get(f.properties.id);
    if (d && onSelect) onSelect(d);
  });
  // desktop hover: pointer cursor + a small name popup
  hoverPopup = new ml.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'dot-popup' });
  map.on('mouseenter', 'dots', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mousemove', 'dots', e => {
    const f = e.features && e.features[0];
    if (!f) return;
    hoverPopup.setLngLat(f.geometry.coordinates).setText(f.properties.name).addTo(map);
  });
  map.on('mouseleave', 'dots', () => { map.getCanvas().style.cursor = ''; hoverPopup.remove(); });

  // don't block on the first rendered frame ('load' needs a visible,
  // compositing tab): state pushed before the style is ready is parked in
  // pendingState and flushed the moment the sources exist
  map.on('styledata', flushPending);
  map.on('load', flushPending);
  map.once('load', addIndiaBorder);
  if (location.hostname === 'localhost') window.__map = map;  // dev-only probe
}

let pendingState = null;
function styleReady() {
  try { return !!(map.getSource('dests') && map.getSource('route')); }
  catch { return false; }
}
function flushPending() {
  if (!pendingState || !styleReady()) return;
  const s = pendingState;
  pendingState = null;
  updateMap(s);
}

// Quadratic-bezier arc between two [lng,lat] points: an honest "this way"
// indication, not turn-by-turn (the Directions button hands off to Google
// Maps for that). Bows northward for a consistent look.
function arcPoints(a, b, curvature = 0.15) {
  const dLat = b[1] - a[1], dLng = b[0] - a[0];
  let oLat = -dLng * curvature, oLng = dLat * curvature;
  if (oLat < 0) { oLat = -oLat; oLng = -oLng; }
  const cLat = (a[1] + b[1]) / 2 + oLat, cLng = (a[0] + b[0]) / 2 + oLng;
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48, u = 1 - t;
    pts.push([u * u * a[0] + 2 * u * t * cLng + t * t * b[0],
              u * u * a[1] + 2 * u * t * cLat + t * t * b[1]]);
  }
  return pts;
}

function htmlMarker(className, html) {
  const el = document.createElement('div');
  el.className = className;
  if (html !== undefined) el.innerHTML = html;
  return el;
}

/**
 * Redraw everything. state:
 *  { dests, month, origin, selected: {d, roadKm, hours, status} | null,
 *    onward: [{d, roadKm}], fit: bool }
 */
export function updateMap(state) {
  if (!map) return;
  if (!styleReady()) { pendingState = state; return; }
  const ml = window.maplibregl;
  const { dests, month, origin, selected, onward = [], fit = false } = state;
  const selId = selected ? selected.d.id : null;

  // season dots: one geojson source, rebuilt only when month or selection changes
  const sig = month + '|' + (selId || '');
  if (sig !== dotsSig) {
    byId = new Map(dests.map(d => [d.id, d]));
    map.getSource('dests').setData({
      type: 'FeatureCollection',
      features: dests.map(d => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [d.lng, d.lat] },
        properties: { id: d.id, name: d.name, status: seasonStatus(d, month), sel: d.id === selId },
      })),
    });
    dotsSig = sig;
  }

  // origin: the blue "you are here" dot
  if (origin) {
    if (!originMarker) {
      originMarker = new ml.Marker({ element: htmlMarker('origin-dot', '<i></i>') });
    }
    originMarker.setLngLat([origin.lng, origin.lat]).addTo(map);
  } else if (originMarker) {
    originMarker.remove();
  }

  // route arc + onward hints + the two floating labels
  const routeFeatures = [];
  if (labelMarker) { labelMarker.remove(); labelMarker = null; }
  if (nameMarker) { nameMarker.remove(); nameMarker = null; }

  if (origin && selected) {
    const a = [origin.lng, origin.lat], b = [selected.d.lng, selected.d.lat];
    const pts = arcPoints(a, b);
    routeFeatures.push({
      type: 'Feature', properties: { kind: 'route' },
      geometry: { type: 'LineString', coordinates: pts },
    });
    for (const o of onward) {
      routeFeatures.push({
        type: 'Feature', properties: { kind: 'onward' },
        geometry: { type: 'LineString', coordinates: arcPoints(b, [o.d.lng, o.d.lat], 0.12) },
      });
    }

    labelMarker = new ml.Marker({ element: htmlMarker('route-label', travelText(selected.roadKm, selected.hours)) })
      .setLngLat(pts[24]).addTo(map);
    nameMarker = new ml.Marker({ element: htmlMarker('map-name-label', selected.d.name), anchor: 'bottom', offset: [0, -14] })
      .setLngLat(b).addTo(map);
  }
  map.getSource('route').setData({ type: 'FeatureCollection', features: routeFeatures });

  // camera
  if (!fit || !origin) return;
  map.stop();
  safeFit(() => {
    if (selected) {
      const bounds = new ml.LngLatBounds();
      bounds.extend([origin.lng, origin.lat]);
      bounds.extend([selected.d.lng, selected.d.lat]);
      for (const o of onward) bounds.extend([o.d.lng, o.d.lat]);
      map.fitBounds(bounds, {
        padding: {
          top: 130, left: 44, right: 44,
          bottom: Math.min(window.innerHeight * 0.32, 260),
        },
        maxZoom: 9,
        duration: reducedMotion() ? 0 : 800,
      });
    } else {
      map.flyTo({ center: [origin.lng, origin.lat], zoom: 6, duration: reducedMotion() ? 0 : 800 });
    }
  });
}

// A camera move is cosmetic: it must never break a render. Fit math can
// throw when the container size is degenerate (first paint racing layout,
// mid-rotation resizes); state is already correct, so skip the move.
function safeFit(run) {
  const el = map.getContainer();
  if (!el.clientWidth || !el.clientHeight) return;
  try { run(); } catch { /* skip the animation, keep the state */ }
}

export function nudgeMap() {
  if (map) setTimeout(() => map.resize(), 80);
}
