// Visual identity per category: a gradient pair for the big cards, one hue
// for small tinted chips, and a glyph from the icon set (icon name ===
// category key). The first category decides a destination's look.
import { icon } from './icons.js?v=e2';

// Gradient stops are kept dark enough that solid white text passes WCAG AA
// (~4.5:1) on the lighter stop; don't brighten these without re-checking.
export const CATEGORY_GRADIENT = {
  mountains:  ['#16324f', '#2f5f80'],
  beach:      ['#0c4a6e', '#0369a1'],
  heritage:   ['#7c2d12', '#c2410c'],
  spiritual:  ['#4c1d95', '#6d28d9'],
  wildlife:   ['#14532d', '#15803d'],
  trek:       ['#1e3a8a', '#1d4ed8'],
  backpacker: ['#831843', '#be185d'],
  desert:     ['#78350f', '#b45309'],
  island:     ['#134e4a', '#0f766e'],
  lake:       ['#155e75', '#0e7490'],
  waterfall:  ['#164e63', '#12809c'],
  city:       ['#1f2937', '#4b5563'],
  offbeat:    ['#312e81', '#4338ca'],
  party:      ['#701a75', '#a21caf'],
  culture:    ['#7c2d12', '#b45309'],
  snow:       ['#1c3d8f', '#2b5cc4'],
};

export const CATEGORY_COLOR = {
  mountains:  '#38678f',
  beach:      '#0284c7',
  heritage:   '#c2410c',
  spiritual:  '#7c3aed',
  wildlife:   '#16a34a',
  trek:       '#2563eb',
  backpacker: '#db2777',
  desert:     '#d97706',
  island:     '#0d9488',
  lake:       '#0891b2',
  waterfall:  '#0e7490',
  city:       '#64748b',
  offbeat:    '#6366f1',
  party:      '#c026d3',
  culture:    '#b45309',
  snow:       '#3b82f6',
};

export const CATEGORY_LABEL = {
  mountains:  'Mountains',
  beach:      'Beach',
  heritage:   'Heritage',
  spiritual:  'Spiritual',
  wildlife:   'Wildlife',
  trek:       'Trek',
  backpacker: 'Backpacker',
  desert:     'Desert',
  island:     'Island',
  lake:       'Lakes',
  waterfall:  'Waterfalls',
  city:       'City',
  offbeat:    'Offbeat',
  party:      'Party',
  culture:    'Culture',
  snow:       'Snow',
};

// Local places ("spots") inside a destination carry a `kind`. Each kind
// borrows a category's colour so the badges read as one system, and names
// the glyph to draw (a category glyph, or one of the spot-only glyphs in
// icons.js). tools/verify-destinations.mjs enforces this list on the data.
export const SPOT_KIND = {
  temple:     ['Temple', 'spiritual'],
  gurudwara:  ['Gurudwara', 'spiritual'],
  monastery:  ['Monastery', 'spiritual'],
  church:     ['Church', 'spiritual'],
  mosque:     ['Mosque', 'spiritual'],
  shrine:     ['Shrine', 'spiritual'],
  ghat:       ['Ghat', 'spiritual'],
  fort:       ['Fort', 'heritage'],
  palace:     ['Palace', 'heritage'],
  museum:     ['Museum', 'heritage'],
  heritage:   ['Heritage', 'heritage'],
  market:     ['Market', 'city', 'shop'],
  food:       ['Food', 'city', 'food'],
  nightlife:  ['Nightlife', 'party'],
  viewpoint:  ['Viewpoint', 'mountains', 'eye'],
  waterfall:  ['Waterfall', 'waterfall'],
  lake:       ['Lake', 'lake'],
  river:      ['River', 'lake'],
  dam:        ['Reservoir', 'lake'],
  beach:      ['Beach', 'beach'],
  island:     ['Island', 'island'],
  dune:       ['Dunes', 'desert'],
  trek:       ['Trek', 'trek'],
  walk:       ['Walk', 'trek'],
  village:    ['Village', 'culture'],
  garden:     ['Garden', 'wildlife', 'leaf'],
  park:       ['Park', 'wildlife', 'leaf'],
  tea:        ['Tea estate', 'wildlife', 'leaf'],
  wildlife:   ['Wildlife', 'wildlife'],
  cave:       ['Cave', 'offbeat'],
  hotspring:  ['Hot spring', 'offbeat'],
  activity:   ['Activity', 'backpacker'],
};

// {label, color, icon} for a spot kind; unknown kinds fall back to offbeat
export function spotKind(kind) {
  const k = SPOT_KIND[kind] || ['Place', 'offbeat'];
  return { label: k[0], color: CATEGORY_COLOR[k[1]], icon: k[2] || k[1] };
}

// small tinted badge holding the spot's glyph, same shape as catBadge
export function spotBadge(spot) {
  const k = spotKind(spot && spot.kind);
  return `<span class="cat-badge" style="background:${k.color}1f;color:${k.color}" title="${k.label}">${icon(k.icon)}</span>`;
}

function catKey(d) {
  const k = (d.category || [])[0];
  return CATEGORY_COLOR[k] ? k : 'offbeat';
}

// the category glyph for a destination, as an inline svg
export function catIcon(d, cls = '') {
  return icon(catKey(d), cls);
}

// small tinted badge holding the category glyph (used on peeks and lists)
export function catBadge(d) {
  const k = catKey(d);
  const c = CATEGORY_COLOR[k];
  return `<span class="cat-badge" style="background:${c}1f;color:${c}" title="${CATEGORY_LABEL[k]}">${icon(k)}</span>`;
}

// the big colorful card face; seeded angle so a wall of cards doesn't
// look copy-pasted. The translucent radial sheen must be listed FIRST:
// the first background layer paints on top, and the linear gradient
// below it is opaque.
export function cardBackground(d) {
  const g = CATEGORY_GRADIENT[catKey(d)];
  let h = 0; for (const c of d.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const angle = 120 + (h % 80);
  return `radial-gradient(120% 90% at 85% 10%, rgba(255,255,255,.18), transparent 60%), linear-gradient(${angle}deg, ${g[0]}, ${g[1]})`;
}
