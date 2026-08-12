// Visual identity per category: gradient stops + a glyph from the icon set
// (icon name === category key). The first category decides a card's look.
import { icon } from './icons.js';

export const CATEGORY_THEME = {
  mountains:  { g: ['#16324f', '#3a7ca5'], label: 'Mountains' },
  beach:      { g: ['#075985', '#0ea5e9'], label: 'Beach' },
  heritage:   { g: ['#7c2d12', '#c2410c'], label: 'Heritage' },
  spiritual:  { g: ['#5b21b6', '#8b5cf6'], label: 'Spiritual' },
  wildlife:   { g: ['#14532d', '#15803d'], label: 'Wildlife' },
  trek:       { g: ['#1e3a8a', '#3b82f6'], label: 'Trek' },
  backpacker: { g: ['#9d174d', '#ec4899'], label: 'Backpacker' },
  desert:     { g: ['#92400e', '#d97706'], label: 'Desert' },
  island:     { g: ['#115e59', '#14b8a6'], label: 'Island' },
  lake:       { g: ['#155e75', '#0891b2'], label: 'Lakes' },
  waterfall:  { g: ['#164e63', '#06b6d4'], label: 'Waterfalls' },
  city:       { g: ['#1f2937', '#4b5563'], label: 'City' },
  offbeat:    { g: ['#312e81', '#6366f1'], label: 'Offbeat' },
  party:      { g: ['#86198f', '#d946ef'], label: 'Party' },
  culture:    { g: ['#9a3412', '#ea8a0c'], label: 'Culture' },
  snow:       { g: ['#1e40af', '#60a5fa'], label: 'Snow' },
};

export function themeOf(d) {
  return CATEGORY_THEME[(d.category || [])[0]] || CATEGORY_THEME.offbeat;
}

// the category glyph for a destination, as an inline svg
export function catIcon(d, cls = '') {
  const k = (d.category || [])[0];
  return icon(CATEGORY_THEME[k] ? k : 'offbeat', cls);
}

// small tinted badge holding the category glyph (used on peeks, lists)
export function catBadge(d) {
  const t = themeOf(d);
  return `<span class="cat-badge" style="background:${t.g[1]}22;color:${t.g[1]}">${catIcon(d)}</span>`;
}

export function cardBackground(d) {
  const t = themeOf(d);
  // seeded angle so the wall of cards doesn't look copy-pasted
  let h = 0; for (const c of d.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const angle = 120 + (h % 80);
  return `linear-gradient(${angle}deg, ${t.g[0]}, ${t.g[1]}), radial-gradient(120% 90% at 85% 10%, rgba(255,255,255,.18), transparent 60%)`;
}
