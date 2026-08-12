// Visual identity per category: gradient stops + a glyph from the icon set
// (icon name === category key). The first category decides a card's look.
import { icon } from './icons.js';

// Gradient stops are kept dark enough that solid white text passes WCAG AA
// (~4.5:1) on the lighter stop — don't brighten these without re-checking.
export const CATEGORY_THEME = {
  mountains:  { g: ['#16324f', '#2f5f80'], label: 'Mountains' },
  beach:      { g: ['#0c4a6e', '#0369a1'], label: 'Beach' },
  heritage:   { g: ['#7c2d12', '#c2410c'], label: 'Heritage' },
  spiritual:  { g: ['#4c1d95', '#6d28d9'], label: 'Spiritual' },
  wildlife:   { g: ['#14532d', '#15803d'], label: 'Wildlife' },
  trek:       { g: ['#1e3a8a', '#1d4ed8'], label: 'Trek' },
  backpacker: { g: ['#831843', '#be185d'], label: 'Backpacker' },
  desert:     { g: ['#78350f', '#b45309'], label: 'Desert' },
  island:     { g: ['#134e4a', '#0f766e'], label: 'Island' },
  lake:       { g: ['#155e75', '#0e7490'], label: 'Lakes' },
  waterfall:  { g: ['#164e63', '#12809c'], label: 'Waterfalls' },
  city:       { g: ['#1f2937', '#4b5563'], label: 'City' },
  offbeat:    { g: ['#312e81', '#4338ca'], label: 'Offbeat' },
  party:      { g: ['#701a75', '#a21caf'], label: 'Party' },
  culture:    { g: ['#7c2d12', '#b45309'], label: 'Culture' },
  snow:       { g: ['#1c3d8f', '#2b5cc4'], label: 'Snow' },
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
