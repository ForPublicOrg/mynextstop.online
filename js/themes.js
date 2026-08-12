// Visual identity per category: gradient stops + emoji.
// The first category on a destination decides its card's look.
export const CATEGORY_THEME = {
  mountains:  { g: ['#16324f', '#3a7ca5'], e: '🏔️', label: 'Mountains' },
  beach:      { g: ['#075985', '#0ea5e9'], e: '🏖️', label: 'Beach' },
  heritage:   { g: ['#7c2d12', '#c2410c'], e: '🏛️', label: 'Heritage' },
  spiritual:  { g: ['#5b21b6', '#8b5cf6'], e: '🛕', label: 'Spiritual' },
  wildlife:   { g: ['#14532d', '#15803d'], e: '🐅', label: 'Wildlife' },
  trek:       { g: ['#1e3a8a', '#3b82f6'], e: '🥾', label: 'Trek' },
  backpacker: { g: ['#9d174d', '#ec4899'], e: '🎒', label: 'Backpacker' },
  desert:     { g: ['#92400e', '#d97706'], e: '🐪', label: 'Desert' },
  island:     { g: ['#115e59', '#14b8a6'], e: '🏝️', label: 'Island' },
  lake:       { g: ['#155e75', '#0891b2'], e: '🌊', label: 'Lakes' },
  waterfall:  { g: ['#164e63', '#06b6d4'], e: '💧', label: 'Waterfalls' },
  city:       { g: ['#1f2937', '#4b5563'], e: '🌆', label: 'City' },
  offbeat:    { g: ['#312e81', '#6366f1'], e: '🤫', label: 'Offbeat' },
  party:      { g: ['#86198f', '#d946ef'], e: '🎉', label: 'Party' },
  culture:    { g: ['#9a3412', '#ea8a0c'], e: '🎭', label: 'Culture' },
  snow:       { g: ['#1e40af', '#60a5fa'], e: '❄️', label: 'Snow' },
};

export function themeOf(d) {
  return CATEGORY_THEME[(d.category || [])[0]] || CATEGORY_THEME.offbeat;
}

export function cardBackground(d) {
  const t = themeOf(d);
  // seeded angle so the wall of cards doesn't look copy-pasted
  let h = 0; for (const c of d.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const angle = 120 + (h % 80);
  return `linear-gradient(${angle}deg, ${t.g[0]}, ${t.g[1]}), radial-gradient(120% 90% at 85% 10%, rgba(255,255,255,.18), transparent 60%)`;
}
