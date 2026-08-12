// The map IS the UI. Stateful Leaflet manager: season dots, the selected pick's
// route arc from the origin, and dashed "onward" arcs to the pick's own next hops.
//
// Two things ported from humanconnect.online's map engine:
// 1. Theme-aware CARTO basemap (voyager light / dark-matter dark), switched live.
// 2. India-compliant borders: raster tiles bake in the international depiction of
//    J&K / Aksai Chin / Arunachal, not the Survey of India one. We can't repaint
//    tile pixels, so we draw India's official national boundary
//    (data/india-border.geojson) as a thin line ON TOP, coloured to match the
//    basemap's own admin lines — the presented border is India's official claim.
import { seasonStatus, travelText } from './engine.js';
import { themeOf } from './themes.js';

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const SRI_JS = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
const SRI_CSS = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';

const STATUS_COLOR = { peak: '#0f9d6e', shoulder: '#e8890c', off: '#98928a', avoid: '#d4482c' };
const TILE_STYLES = { light: 'rastertiles/voyager_nolabels', dark: 'dark_nolabels' };
// matches CARTO's own admin-boundary line colour in each style
const BORDER_COLOR = { light: '#b3a59a', dark: '#5b5f66' };
const ROUTE_COLOR = { light: '#0e7a6c', dark: '#2fae9c' };
const CASING_OPACITY = { light: 0.85, dark: 0.5 };

let map = null, dotsLayer = null, routeLayer = null, tiles = null, borderLayer = null;
let loading = null, onSelect = null;
let theme = 'light';

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
    js.onload = resolve; js.onerror = () => reject(new Error('leaflet failed'));
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

// India's official boundary on its own pane: above tiles (200), below overlays
// (400). Failure is non-fatal — the map still works, just with tile borders.
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

// Switch basemap + border colour live (called on theme toggle / OS change).
// The caller re-renders routes so arcs pick up the themed colour too.
export function setMapTheme(t) {
  theme = t === 'dark' ? 'dark' : 'light';
  if (!map) return;
  setTiles();
  if (borderLayer) borderLayer.setStyle({ color: BORDER_COLOR[theme] });
}

export async function initMap(el, selectCallback, initialTheme = 'light') {
  await loadLeaflet();
  onSelect = selectCallback;
  theme = initialTheme === 'dark' ? 'dark' : 'light';
  if (map) return;
  const L = window.L;
  map = L.map(el, { zoomControl: false, attributionControl: true, minZoom: 4, maxZoom: 13 });
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.attributionControl.setPrefix(false);
  map.setView([22.5, 80], 5);
  setTiles();
  addIndiaBorder();
  dotsLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
}

// Quadratic-bezier arc between two latlngs — an honest "this way" indication,
// not turn-by-turn (the Directions button hands off to Google Maps for that).
function arcPoints(a, b, curvature = 0.15) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  // perpendicular offset, bowing towards the north for a consistent look
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

/**
 * Redraw everything. state:
 *  { dests, month, origin, selected: {d, roadKm, hours, status} | null,
 *    onward: [{d, roadKm}], fit: bool }
 */
export function updateMap(state) {
  if (!map) return;
  const L = window.L;
  const { dests, month, origin, selected, onward = [], fit = false } = state;
  const selId = selected ? selected.d.id : null;

  // cancel any in-flight fly animation and explicitly unbind tooltips —
  // permanent tooltips can survive clearLayers() mid-animation
  map.stop();
  for (const layer of [dotsLayer, routeLayer]) {
    layer.eachLayer(l => { if (l.getTooltip && l.getTooltip()) l.unbindTooltip(); });
    layer.clearLayers();
  }

  // season dots — every destination, always visible: the map is the catalogue
  for (const d of dests) {
    const status = seasonStatus(d, month);
    const isSel = d.id === selId;
    const m = L.circleMarker([d.lat, d.lng], {
      radius: isSel ? 11 : (status === 'peak' ? 7.5 : 6),
      color: theme === 'dark' ? '#2a2a2a' : '#fff', weight: isSel ? 3 : 1.5,
      fillColor: STATUS_COLOR[status],
      fillOpacity: status === 'avoid' ? 0.5 : 0.95,
    });
    const t = themeOf(d);
    m.bindTooltip(`${t.e} ${d.name}`, { direction: 'top', offset: [0, -8], opacity: 0.94 });
    m.on('click', () => onSelect && onSelect(d));
    m.addTo(dotsLayer);
  }

  // origin: you are here
  if (origin) {
    L.circleMarker([origin.lat, origin.lng], {
      radius: 8, color: '#fff', weight: 2.5, fillColor: '#2563eb', fillOpacity: 1,
    }).bindTooltip('You are here', { direction: 'top', offset: [0, -8] }).addTo(routeLayer);
  }

  // the route: origin → pick
  if (origin && selected) {
    const a = [origin.lat, origin.lng], b = [selected.d.lat, selected.d.lng];
    const pts = arcPoints(a, b);
    L.polyline(pts, { color: '#ffffff', weight: 7, opacity: CASING_OPACITY[theme], interactive: false }).addTo(routeLayer);
    const line = L.polyline(pts, { color: ROUTE_COLOR[theme], weight: 3.5, opacity: 0.95, interactive: false }).addTo(routeLayer);
    line.bindTooltip(`≈ ${travelText(selected.roadKm, selected.hours)}`, {
      permanent: true, direction: 'center', className: 'route-label', opacity: 1,
    });

    // onward hints: where you'd go NEXT from there — the "next stop" chain
    for (const o of onward) {
      const opts2 = arcPoints(b, [o.d.lat, o.d.lng], 0.12);
      L.polyline(opts2, {
        color: ROUTE_COLOR[theme], weight: 2, opacity: 0.55, dashArray: '4 7', interactive: false,
      }).bindTooltip(`then ${o.d.name} · ${o.roadKm} km`, {
        permanent: true, direction: 'center', className: 'route-label route-label-onward',
      }).addTo(routeLayer);
    }

    if (fit) {
      const bounds = L.latLngBounds([a, b]);
      for (const o of onward) bounds.extend([o.d.lat, o.d.lng]);
      map.flyToBounds(bounds, {
        paddingTopLeft: [36, 130],
        paddingBottomRight: [36, Math.min(window.innerHeight * 0.42, 360)],
        duration: 0.8, maxZoom: 9,
      });
    }
  } else if (fit && origin) {
    map.flyTo([origin.lat, origin.lng], 6, { duration: 0.8 });
  }

  setTimeout(() => map.invalidateSize(), 80);
}

export function nudgeMap() {
  if (map) setTimeout(() => map.invalidateSize(), 80);
}
