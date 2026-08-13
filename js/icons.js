// mynextstop icon set: single-weight line icons, 24px grid, currentColor.
// Hand-kept so every glyph shares stroke weight, caps and corner language.
// Usage: icon('pin') → inline <svg class="ic">…</svg>; icon('pin','ic-lg') to size.

const P = {
  // ----- UI -----
  compass: '<circle cx="12" cy="12" r="9"/><polygon points="15.5,8.5 13.7,13.7 8.5,15.5 10.3,10.3" fill="currentColor" stroke="none"/>',
  pin: '<path d="M12 21s-7-5.4-7-11a7 7 0 1 1 14 0c0 5.6-7 11-7 11z"/><circle cx="12" cy="10" r="2.4"/>',
  crosshair: '<circle cx="12" cy="12" r="6.5"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/>',
  navigation: '<path d="M21 3 3.6 10.6l7 2.8 2.8 7z"/>',
  share: '<circle cx="6" cy="12" r="2.6"/><circle cx="17.5" cy="5.5" r="2.6"/><circle cx="17.5" cy="18.5" r="2.6"/><path d="M8.3 10.8 15.2 6.7M8.3 13.2l6.9 4.1"/>',
  heart: '<path d="M12 20.4 4.8 13a4.9 4.9 0 0 1 7-6.9l.2.2.2-.2a4.9 4.9 0 0 1 7 6.9z"/>',
  heartFill: '<path d="M12 20.4 4.8 13a4.9 4.9 0 0 1 7-6.9l.2.2.2-.2a4.9 4.9 0 0 1 7 6.9z" fill="currentColor"/>',
  check: '<path d="m4.5 12.5 5 5L19.5 6.5"/>',
  sliders: '<path d="M5 21v-6M5 9V3M12 21v-9M12 6V3M19 21v-3M19 12V3"/><path d="M2.5 15h5M9.5 8.5h5M16.5 18h5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10.5h17"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  backpack: '<path d="M7 8a5 5 0 0 1 10 0v13H7z"/><path d="M9.5 8V6a2.5 2.5 0 0 1 5 0v2M7 13h10M10 17h4"/>',
  users: '<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0M16 5a3.4 3.4 0 0 1 0 6.6M17.6 14.4A6.2 6.2 0 0 1 21.2 20"/>',
  peak: '<path d="m2.5 19.5 6.5-12 4.5 8 2.5-4 5.5 8z"/>',
  bus: '<rect x="4" y="4" width="16" height="13" rx="2.5"/><path d="M4 11h16M8 21v-4M16 21v-4"/><circle cx="8.5" cy="14.5" r=".2"/><circle cx="15.5" cy="14.5" r=".2"/>',
  moon: '<path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a7 7 0 0 0 10 10z"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.6-4.6"/>',
  arrowRight: '<path d="M4 12h15M13 6l6 6-6 6"/>',
  chevronLeft: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  city: '<path d="M3 21h18M5 21V9h5v12M10 21V4h6v17M16 21v-9h3v9"/><path d="M7 12h1M7 15h1M12.5 8h1M12.5 12h1"/>',
  route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5" stroke-dasharray="3.2 2.6"/>',
  refresh: '<path d="M20 8A8.5 8.5 0 1 0 21 12"/><path d="M21 3v5h-5"/>',
  plane: '<path d="M21 15.5 13.5 11V5a1.5 1.5 0 0 0-3 0v6L3 15.5v2.2l7.5-2.3v4l-2 1.6v1.5l3.5-1 3.5 1V21l-2-1.6v-4l7.5 2.3z"/>',
  train: '<rect x="5" y="3.5" width="14" height="14" rx="3"/><path d="M5 11h14M9.5 17.5 7 21M14.5 17.5 17 21M7.5 21h9"/><path d="M9.5 14.2h.01M14.5 14.2h.01"/>',
  car: '<path d="M4.5 15.5 6.2 10a2 2 0 0 1 1.9-1.4h7.8a2 2 0 0 1 1.9 1.4l1.7 5.5"/><path d="M3.5 15.5h17V19h-17z"/><path d="M6.5 19v1.8M17.5 19v1.8M7 12.7h10" stroke-opacity=".55"/>',

  // ----- categories (field-guide glyphs) -----
  mountains: '<path d="m2.5 19 6-11.5 4.3 7.6 2.4-3.6 6.3 7.5z"/><path d="m7 12.5 1.5-1.5 1.5 1.5"/>',
  beach: '<path d="M12 3.5a8.5 8.5 0 0 1 8.5 8H3.5a8.5 8.5 0 0 1 8.5-8z"/><path d="M12 11.5V20M7.5 21c2.5-1.6 6.5-1.6 9 0"/>',
  heritage: '<path d="M4 20.5h16M6.5 20.5V13M17.5 20.5V13M4.5 13h15M7 13a5 5 0 0 1 10 0"/><path d="M12 4.5c1.3 1 1.8 2 1.8 3.5h-3.6c0-1.5.5-2.5 1.8-3.5z"/>',
  spiritual: '<path d="M12 3.5c1.7 1.9 2.6 3.2 2.6 4.8a2.6 2.6 0 1 1-5.2 0c0-1.6.9-2.9 2.6-4.8z"/><path d="M5.5 14.5h13l-1.8 4.5H7.3z"/><path d="M9 14.5c.8-1.2 1.8-1.8 3-1.8s2.2.6 3 1.8"/>',
  wildlife: '<circle cx="7" cy="8" r="1.7"/><circle cx="12" cy="6" r="1.7"/><circle cx="17" cy="8" r="1.7"/><path d="M12 11.5c2.8 0 5.2 2 5.2 4.4 0 1.6-1.2 2.6-2.7 2.6-1 0-1.8-.4-2.5-.4s-1.5.4-2.5.4c-1.5 0-2.7-1-2.7-2.6 0-2.4 2.4-4.4 5.2-4.4z"/>',
  trek: '<path d="M7 21V3.5"/><path d="M7 4h9.5L14 7.5l2.5 3.5H7"/>',
  backpacker: '<path d="M7 8a5 5 0 0 1 10 0v13H7z"/><path d="M9.5 8V6a2.5 2.5 0 0 1 5 0v2M7 13h10M10 17h4"/>',
  desert: '<circle cx="16.5" cy="6.5" r="2.3"/><path d="M2 18.5c2.8-4.5 5.6-4.5 8.4 0M12 18.5c2.8-4.5 5.6-4.5 8.4 0"/><path d="M2 21.5h20" stroke-opacity=".55"/>',
  island: '<path d="M11.5 21c0-6 .5-9.5 2-13"/><path d="M13.5 8C11 6 8.5 6 6 7.5c2.6.4 4.6 1.3 6.4 3M13.5 8c.8-3 2.6-4.4 5.5-4.5-1.8 1.7-2.8 3.3-3.2 5.3M13.5 8c2.8-.8 5.2-.2 7 1.8-2.4-.3-4.5 0-6.4 1.2"/><path d="M4 21c3-1.8 13-1.8 16 0"/>',
  lake: '<path d="M3 9c2.5-2.2 5-2.2 7.5 0s5 2.2 7.5 0M3 14c2.5-2.2 5-2.2 7.5 0s5 2.2 7.5 0M3 19c2.5-2.2 5-2.2 7.5 0s5 2.2 7.5 0" transform="translate(1.5 -2) scale(.87)"/>',
  waterfall: '<path d="M5 4h14M8 4c0 6-.5 10-2.5 14M12 4c0 6.5 0 11-1 15M16 4c.5 6 1.5 10.5 3.5 14.5"/><path d="M4 20.5c2-1.4 4.5-1.4 6.5 0s4.5 1.4 6.5 0"/>',
  offbeat: '<path d="M4 19.5c5.5 0 4.5-11 9.5-11h6"/><path d="m16.5 5.5 3 3-3 3"/><path d="M4 8.5h4" stroke-opacity=".55"/>',
  party: '<path d="M9.5 18.5V6l10-2.5V15"/><circle cx="7" cy="18.5" r="2.6"/><circle cx="17" cy="15" r="2.6"/>',
  culture: '<path d="M3 5.5h18"/><path d="m5 5.5 2 5 2.7-5M10.7 5.5l2 5 2.6-5M16.3 5.5l2 5 2.7-5"/><path d="M6 20.5h12M12 13v7.5"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="m9.5 4.5 2.5 2 2.5-2M9.5 19.5l2.5-2 2.5 2"/>',
};

export function icon(name, cls = '') {
  const body = P[name] || P.compass;
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
