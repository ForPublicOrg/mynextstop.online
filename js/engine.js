// Pure ranking logic, no DOM. Everything the "answer" is made of lives here.

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

// Crow-flies to realistic road estimate.
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

// How much of a place's appeal survives the trip there, 0..1, by estimated
// road km. A smooth hill curve, half-way at 1100 km with a long tail: a day
// trip keeps nearly all of it, a weekend drive about three quarters, an
// overnight train about half, a flight-length trip a third. It is the same
// curve whichever reach chip is on. The chips are hard limits, not a taste
// for distance, so "Anywhere" prefers near exactly as "Weekend" does and
// only lets more places in.
export function ease(roadKm) {
  return 1 / (1 + Math.pow(roadKm / 1100, 1.2));
}

// Reach tiers on the chips' own cuts: quick hop, weekend, long weekend,
// beyond. Variety in the deck is spread across these, scoring ignores them.
export function tierOf(roadKm) {
  return roadKm <= 150 ? 0 : roadKm <= 450 ? 1 : roadKm <= 900 ? 2 : 3;
}

const SEASON_WEIGHT = { peak: 1, shoulder: 0.55, off: 0.28 };
const kindOf = d => (d.category || [])[0] || '';

/**
 * The answer. Returns the deck: [{d, km, roadKm, hours, status, score, tier}],
 * best first. opts: { maxKm, moods:[], excludeIds:Set, seed, hereKm, variety }
 *
 * A place's score is multiplicative: season fit × ease of getting there ×
 * what the place itself brings (solo-friendliness, a festival this month).
 * Multiplying is the point. Adding the parts let a far place in peak
 * season with a festival outscore every in-season place a few hours away,
 * which is how "Anywhere" from Nagpur used to open with Mysuru, Kolkata and
 * Nepal. Now a peak place 1300 km out scores about what a shoulder place
 * 300 km out does, and the near in-season places sit on top.
 */
export function rank(dests, origin, month, opts = {}) {
  const { maxKm = Infinity, moods = [], excludeIds = new Set(), seed = 0, hereKm = 25, variety = true } = opts;
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

    let quality = 1 + 0.08 * ((d.solo || 3) - 3);   // solo-traveller friendliness, ±16%
    if (festivalMonth(d) === month) quality += 0.3; // signature festival this month
    const score = 100 * SEASON_WEIGHT[status] * ease(roadKm) * quality + jitter(d.id, seed);

    out.push({ d, km: Math.round(km), roadKm, hours, status, score, tier: tierOf(roadKm) });
  }
  out.sort((a, b) => b.score - a.score);
  return variety ? vary(out) : out;
}

// The deck people actually flip through. Pure score order reads like a
// list sorted by one column: six Madhya Pradesh temples in a row, or every
// pick the same four hours out. An editor would mix it, so each slot takes
// the best remaining place after a discount for repeating what the last
// three picks already were: the same reach tier (strongest, it is what
// lets one big-trip standout follow a run of weekend drives), the same
// state, the same kind of place. Discounts are fractions of a three-pick
// window, so the top pick is never touched and a weaker place can only
// jump a stronger one when the stronger one is the third of a kind.
// Only the top 200 are worth the work; whatever is past that stays in
// score order.
const VARY = { tier: 0.35, state: 0.2, kind: 0.15, window: 3, pool: 200 };
function vary(items) {
  const pool = items.slice(0, VARY.pool), rest = items.slice(VARY.pool), deck = [];
  while (pool.length) {
    const last = deck.slice(-VARY.window);
    const frac = f => last.filter(f).length / VARY.window;
    let best = 0, bestAdj = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const adj = c.score
        * (1 - VARY.tier * frac(p => p.tier === c.tier))
        * (1 - VARY.state * frac(p => p.d.state === c.d.state))
        * (1 - VARY.kind * frac(p => kindOf(p.d) === kindOf(c.d)));
      if (adj > bestAdj) { bestAdj = adj; best = i; }
    }
    deck.push(pool.splice(best, 1)[0]);
  }
  return deck.concat(rest);
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
    // local-date ISO: toISOString() is UTC and shifts IST back a day
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
  return `${s} to ${end.getDate()} ${MONTHS[end.getMonth()]}`;
}
