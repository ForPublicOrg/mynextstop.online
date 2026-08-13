// Visual identity per category: one hue + a glyph from the icon set
// (icon name === category key). Used as soft tinted chips, never as
// full-bleed gradients; the first category decides a destination's look.
import { icon } from './icons.js';

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

function catKey(d) {
  const k = (d.category || [])[0];
  return CATEGORY_COLOR[k] ? k : 'offbeat';
}

// the category glyph for a destination, as an inline svg
export function catIcon(d, cls = '') {
  return icon(catKey(d), cls);
}

// small tinted badge holding the category glyph (used on cards and lists)
export function catBadge(d) {
  const k = catKey(d);
  const c = CATEGORY_COLOR[k];
  return `<span class="cat-badge" style="background:${c}1f;color:${c}" title="${CATEGORY_LABEL[k]}">${icon(k)}</span>`;
}
