// Pure ranking logic — no DOM. Everything the "answer" is made of lives here.

export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// winter Dec–Feb · summer Mar–May · monsoon Jun–Sep · autumn Oct–Nov
export function seasonOf(month) {
  if (month === 12 || month <= 2) return 'winter';
  if (month <= 5) return 'summer';
  if (month <= 9) return 'monsoon';
  return 'autumn';
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180, R = 6371;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 'peak' | 'shoulder' | 'off' | 'avoid'
export function seasonStatus(d, month) {
  if ((d.avoidMonths || []).includes(month)) return 'avoid';
  if ((d.peakMonths || []).includes(month)) return 'peak';
  if ((d.shoulderMonths || []).includes(month)) return 'shoulder';
  return 'off';
}

// Find the first month name anywhere in the festival string:
// "Nov: Pushkar camel fair", "Feb/Mar: Losar", "early December: Hornbill" all parse.
export function festivalMonth(d) {
  if (!d.festival) return 0;
  const s = d.festival.toLowerCase();
  let best = 0, bestPos = Infinity;
  MONTHS.forEach((mo, i) => {
    const p = s.indexOf(mo.toLowerCase());
    if (p !== -1 && p < bestPos) { bestPos = p; best = i + 1; }
  });
  return best;
}

// Stable small jitter so near-ties don't always order identically,
// but the order doesn't jump around within a session.
function jitter(id, seed) {
  let h = seed;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 7) - 3;
}

// Crow-flies → realistic road estimate.
export function roadEstimate(km, alt) {
  const hilly = (alt || 0) > 900;
  const roadKm = Math.round((km * (hilly ? 1.5 : 1.32)) / 10) * 10;
  const speed = hilly ? 40 : 52;
  const hours = roadKm / speed;
  return { roadKm, hours };
}

export function travelText(roadKm, hours) {
  let time;
  if (hours < 1) time = 'under an hour';
  else if (hours < 10) time = `~${(Math.round(hours * 2) / 2).toString().replace('.5', '½')} h by road`;
  else time = 'an overnight ride';
  const hint = roadKm > 800 ? ' · train / flight territory' : '';
  return `${roadKm} km · ${time}${hint}`;
}

/**
 * The answer. Returns ranked [{d, km, roadKm, hours, status, score}].
 * opts: { maxKm, moods:[], excludeIds:Set, seed, hereKm }
 */
export function rank(dests, origin, month, opts = {}) {
  const { maxKm = Infinity, moods = [], excludeIds = new Set(), seed = 0, hereKm = 25 } = opts;
  const out = [];
  for (const d of dests) {
    const km = haversineKm(origin.lat, origin.lng, d.lat, d.lng);
    if (km < hereKm) continue;                    // that's where you already are
    if (excludeIds.has(d.id)) continue;           // marked "been there"
    const { roadKm, hours } = roadEstimate(km, d.alt);
    if (roadKm > maxKm) continue;
    if (moods.length && !(d.category || []).some(c => moods.includes(c))) continue;
    const status = seasonStatus(d, month);
    if (status === 'avoid') continue;             // honest engine: never suggest a bad-time place

    let score = 0;
    if (status === 'peak') score += 44;
    else if (status === 'shoulder') score += 18;
    else score -= 8;
    // closer is better, scaled to the chosen range so "Anywhere" still prefers near
    const scale = Number.isFinite(maxKm) ? maxKm : 2400;
    score += 26 * Math.max(0, 1 - roadKm / scale);
    score += ((d.solo || 3) - 3) * 5;             // solo-traveller friendliness
    if (festivalMonth(d) === month) score += 14;  // signature festival this month
    score += jitter(d.id, seed);

    out.push({ d, km: Math.round(km), roadKm, hours, status, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// Nearest destination the user is basically standing in (for "You're in X")
export function whereAmI(dests, origin, withinKm = 25) {
  let best = null, bestKm = withinKm;
  for (const d of dests) {
    const km = haversineKm(origin.lat, origin.lng, d.lat, d.lng);
    if (km < bestKm) { best = d; bestKm = km; }
  }
  return best;
}

/**
 * Long-weekend radar. holidays: [{date:'YYYY-MM-DD', name}], today: Date.
 * Finds runs of ≥3 consecutive off-days (weekends + holidays) in the next
 * `horizon` days that include at least one holiday. Returns [{start,end,days,name}].
 */
export function longWeekends(holidays, today, horizon = 150) {
  const hol = new Map();
  for (const h of holidays || []) hol.set(h.date, h.name);
  const dayMs = 86400000;
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const off = [];
  for (let i = 0; i <= horizon; i++) {
    const dt = new Date(t0.getTime() + i * dayMs);
    // local-date ISO — toISOString() is UTC and shifts IST back a day
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const wd = dt.getDay();
    off.push({ dt, isOff: wd === 0 || wd === 6 || hol.has(iso), holName: hol.get(iso) });
  }
  const runs = [];
  let s = -1, name = '';
  for (let i = 0; i <= off.length; i++) {
    const o = off[i];
    if (o && o.isOff) {
      if (s === -1) s = i;
      if (o.holName && !name) name = o.holName;
    } else {
      if (s !== -1) {
        const len = i - s;
        if (len >= 3 && name) runs.push({ start: off[s].dt, end: off[i - 1].dt, days: len, name });
        s = -1; name = '';
      }
    }
  }
  return runs;
}

export function fmtRange(start, end) {
  const sameMonth = start.getMonth() === end.getMonth();
  const s = `${start.getDate()}${sameMonth ? '' : ' ' + MONTHS[start.getMonth()]}`;
  return `${s}–${end.getDate()} ${MONTHS[end.getMonth()]}`;
}
