#!/usr/bin/env node
// Data honesty check for data/destinations.json.
//
//   node tools/verify-destinations.mjs            # schema + geo + elevation
//   node tools/verify-destinations.mjs --offline  # schema only, no network
//   node tools/verify-destinations.mjs --only=leh,kaza
//
// Offline it checks the schema and the season logic. Online it also asks
// two public APIs whether the data is telling the truth about the map:
//   · BigDataCloud reverse geocoding: does the coordinate sit in the state
//     the record claims?
//   · Photon / OpenStreetMap forward geocoding. How far is the named place
//     from the coordinate we ship?
//   · Open-Meteo elevation (Copernicus DEM). Is `alt` the real ground height
//     at that point?
// Results are cached in tools/.geo-cache.json so re-runs are cheap; delete it
// to re-query. Nothing here runs in the browser. It is a contributor tool.
//
// Exit code is 1 if any HIGH finding survives, so CI can gate on it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CACHE_FILE = path.join(HERE, '.geo-cache.json');
const UA = 'mynextstop.online-data-check (https://mynextstop.online)';

const argv = process.argv.slice(2);
const FILE = argv.find(a => !a.startsWith('--')) || path.join(ROOT, 'data', 'destinations.json');
const OFFLINE = argv.includes('--offline');
const ONLY = (argv.find(a => a.startsWith('--only=')) || '').replace('--only=', '').split(',').filter(Boolean);

const STATES = ['Andaman & Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh', 'Dadra & Nagar Haveli and Daman & Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];
const CATS = ['mountains', 'beach', 'heritage', 'spiritual', 'wildlife', 'trek', 'backpacker', 'desert', 'island', 'lake', 'waterfall', 'city', 'offbeat', 'party', 'culture', 'snow'];
const MODES = ['flight', 'train', 'road'];
const KEYS = ['id', 'name', 'state', 'lat', 'lng', 'alt', 'category', 'tagline', 'peakMonths', 'shoulderMonths', 'avoidMonths', 'festival', 'why', 'days', 'budget', 'solo', 'crowd', 'vibe', 'hub', 'modes'];
const SEASONS = ['winter', 'summer', 'monsoon', 'autumn'];
const SEASON_MONTHS = { winter: [12, 1, 2], summer: [3, 4, 5], monsoon: [6, 7, 8, 9], autumn: [10, 11] };
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_ALIASES = [['jan', 'january'], ['feb', 'february'], ['mar', 'march'], ['apr', 'april'], ['may'],
  ['jun', 'june'], ['jul', 'july'], ['aug', 'august'], ['sep', 'sept', 'september'], ['oct', 'october'],
  ['nov', 'november'], ['dec', 'december']];

// how the reverse geocoder spells things vs how we do
const STATE_ALIAS = {
  'Andaman and Nicobar Islands': 'Andaman & Nicobar Islands',
  'Dadra and Nagar Haveli and Daman and Diu': 'Dadra & Nagar Haveli and Daman & Diu',
  'National Capital Territory of Delhi': 'Delhi',
  Pondicherry: 'Puducherry', Orissa: 'Odisha', Uttaranchal: 'Uttarakhand',
};
// borders where a coordinate legitimately reads as the neighbour
const OK_NEIGHBOUR = new Set([
  'Chandigarh|Punjab', 'Chandigarh|Haryana', 'Punjab|Chandigarh', 'Haryana|Chandigarh',
  'Delhi|Haryana', 'Delhi|Uttar Pradesh', 'Puducherry|Tamil Nadu', 'Tamil Nadu|Puducherry',
  'Ladakh|Jammu and Kashmir', 'Jammu and Kashmir|Ladakh',
  'Dadra & Nagar Haveli and Daman & Diu|Gujarat', 'Gujarat|Dadra & Nagar Haveli and Daman & Diu',
]);

const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
let cacheDirty = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const saveCache = () => { if (cacheDirty) { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); cacheDirty = false; } };

function km(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180, R = 6371;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function getJSON(url, throttleMs = 350) {
  if (cache[url] !== undefined) return cache[url];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      cache[url] = j; cacheDirty = true;
      await sleep(throttleMs);
      return j;
    } catch { await sleep(1500 * (attempt + 1)); }
  }
  console.error('fetch failed:', url);
  return null;
}

const flags = [];
const add = (id, sev, code, msg) => flags.push({ id, sev, code, msg });

function offlineChecks(data) {
  const seen = new Set();
  for (const d of data) {
    const id = d.id || '(no id)';
    for (const k of KEYS) if (!(k in d)) add(id, 'HIGH', 'missing-key', `missing "${k}"`);
    for (const k of Object.keys(d)) if (!KEYS.includes(k)) add(id, 'HIGH', 'extra-key', `unexpected key "${k}"`);

    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(d.id))) add(id, 'HIGH', 'bad-id', 'id is not kebab-case ascii');
    if (seen.has(d.id)) add(id, 'HIGH', 'dup-id', 'duplicate id'); else seen.add(d.id);
    if (!STATES.includes(d.state)) add(id, 'HIGH', 'bad-state', `state "${d.state}" is not one of the 36`);

    if (typeof d.lat !== 'number' || typeof d.lng !== 'number') add(id, 'HIGH', 'bad-coord', 'lat/lng not numbers');
    else if (d.lat < 6 || d.lat > 37.2 || d.lng < 68 || d.lng > 97.5) add(id, 'HIGH', 'coord-out-of-india', `${d.lat},${d.lng}`);
    if (!Number.isInteger(d.alt) || d.alt < 0 || d.alt > 5500) add(id, 'MED', 'bad-alt', `alt ${d.alt}`);

    if (!Array.isArray(d.category) || !d.category.length || d.category.length > 4) add(id, 'HIGH', 'bad-category', `category length ${d.category?.length}`);
    else for (const c of d.category) if (!CATS.includes(c)) add(id, 'HIGH', 'bad-category', `unknown category "${c}"`);

    const arr = k => (Array.isArray(d[k]) ? d[k] : []);
    for (const k of ['peakMonths', 'shoulderMonths', 'avoidMonths']) {
      for (const m of arr(k)) if (!Number.isInteger(m) || m < 1 || m > 12) add(id, 'HIGH', 'bad-month', `${k} has ${m}`);
      if (new Set(arr(k)).size !== arr(k).length) add(id, 'MED', 'bad-month', `${k} has duplicates`);
    }
    const peak = new Set(arr('peakMonths')), sh = new Set(arr('shoulderMonths')), av = new Set(arr('avoidMonths'));
    for (const m of peak) if (sh.has(m) || av.has(m)) add(id, 'HIGH', 'month-overlap', `month ${m} listed twice`);
    for (const m of sh) if (av.has(m)) add(id, 'HIGH', 'month-overlap', `month ${m} in shoulder and avoid`);
    if (!peak.size) add(id, 'HIGH', 'no-peak', 'no peak months');

    if (!d.why || typeof d.why !== 'object') add(id, 'HIGH', 'bad-why', 'why missing');
    else {
      for (const k of Object.keys(d.why)) if (!SEASONS.includes(k)) add(id, 'HIGH', 'bad-why', `why has extra key "${k}"`);
      for (const s of SEASONS) {
        const t = d.why[s];
        if (typeof t !== 'string' || !t.trim()) { add(id, 'HIGH', 'bad-why', `why.${s} missing`); continue; }
        if (t.length < 70 || t.length > 175) add(id, 'LOW', 'why-length', `why.${s} is ${t.length} chars`);
        // a line that only names months from a different season is describing
        // the wrong window: the app shows why.monsoon to a June visitor
        const named = [];
        MONTH_ALIASES.forEach((alts, i) => { if (alts.some(a => new RegExp(`\\b${a}\\b`, 'i').test(t))) named.push(i + 1); });
        // (a neighbouring month named for context is fine, so this is a nudge,
        // not an error: but a whole line about the wrong window is a real bug:
        // the app shows why.monsoon, not why.summer, to a June visitor)
        if (named.length && !named.some(m => SEASON_MONTHS[s].includes(m))) {
          add(id, 'LOW', 'season-mapping', `why.${s} only names ${named.map(m => MONTH_NAMES[m - 1]).join('/')}. ${s} is ${SEASON_MONTHS[s].map(m => MONTH_NAMES[m - 1]).join(', ')}`);
        }
        // a season the engine will never offer must read as a clear "not now"
        if (SEASON_MONTHS[s].every(m => av.has(m))) {
          const warns = /avoid|skip|don't|do not|shut|clos|cancel|unreliab|dangerous|risk|brutal|not the time|stay away|washed|landslide|unbearable|punishing|miserable|rough|suspend|off-limits|flood|waterlog|steam|worst|swelter|bake|slick|mud|leech|humid|drench|downpour|deluge|snowbound|cut off|inaccessible|furnace|no shade|stifling|nothing to|nothing here|dead season|lethal|guesswork|slips|spate|buried|unreachable|impassable|dry rock|bare|stranded|no point|off the table|thin out|sees nothing|grimy|sticky|useless|barefoot-only|blistering/i.test(t);
          if (!warns) add(id, 'MED', 'season-logic', `${s} is entirely in avoidMonths but why.${s} does not read as a warning`);
        }
      }
    }

    for (const [k, lo, hi] of [['days', 1, 9], ['budget', 1, 3], ['solo', 1, 5], ['crowd', 1, 3]]) {
      if (!Number.isInteger(d[k]) || d[k] < lo || d[k] > hi) add(id, 'HIGH', 'bad-range', `${k}=${d[k]} (want ${lo}-${hi})`);
    }

    if (!Array.isArray(d.modes) || !d.modes.length) add(id, 'HIGH', 'bad-modes', 'modes empty');
    else {
      for (const m of d.modes) if (!MODES.includes(m)) add(id, 'HIGH', 'bad-modes', `unknown mode "${m}"`);
      const ord = d.modes.map(m => MODES.indexOf(m));
      if (ord.some((v, i) => i && v < ord[i - 1])) add(id, 'LOW', 'bad-modes', 'modes not in flight/train/road order');
    }

    for (const [k, lo, hi] of [['tagline', 30, 85], ['vibe', 45, 135], ['hub', 28, 125]]) {
      const v = d[k];
      if (typeof v !== 'string') add(id, 'HIGH', 'bad-text', `${k} is not a string`);
      else if (v.length < lo || v.length > hi) add(id, 'LOW', 'text-length', `${k} is ${v.length} chars (want ${lo}-${hi})`);
    }
    if (d.festival && !MONTH_NAMES.some(m => d.festival.toLowerCase().includes(m.toLowerCase()))) {
      add(id, 'HIGH', 'festival-month', `festival "${d.festival}" has no month the app can parse`);
    }
  }

  for (let i = 0; i < data.length; i++) {
    for (let j = i + 1; j < data.length; j++) {
      const a = data[i], b = data[j];
      if (typeof a.lat !== 'number' || typeof b.lat !== 'number') continue;
      const dkm = km(a.lat, a.lng, b.lat, b.lng);
      if (dkm < 5) add(a.id, 'HIGH', 'too-close', `${Math.round(dkm)} km from ${b.id}: same place?`);
      else if (dkm < 12) add(a.id, 'LOW', 'too-close', `${Math.round(dkm)} km from ${b.id}`);
    }
  }
}

function geocodeQuery(d) {
  return `${String(d.name).split('(')[0].split(/ [&+] | and /)[0].trim()}, ${d.state}, India`;
}

async function onlineChecks(data) {
  const geo = {};
  for (let i = 0; i < data.length; i += 100) {
    const chunk = data.slice(i, i + 100).filter(d => typeof d.lat === 'number');
    if (!chunk.length) continue;
    const j = await getJSON(`https://api.open-meteo.com/v1/elevation?latitude=${chunk.map(d => d.lat).join(',')}&longitude=${chunk.map(d => d.lng).join(',')}`, 400);
    if (!j?.elevation) continue;
    chunk.forEach((d, k) => {
      const dem = j.elevation[k];
      if (typeof dem !== 'number') return;
      geo[d.id] = { ...geo[d.id], dem };
      const gap = Math.abs((d.alt || 0) - dem);
      if (gap > Math.max(80, dem * 0.2)) {
        add(d.id, gap > Math.max(300, dem * 0.5) ? 'HIGH' : 'MED', 'alt-mismatch',
          `alt ${d.alt} vs ${Math.round(dem)} m of terrain at ${d.lat},${d.lng}`);
      }
    });
    process.stderr.write(`elevation ${Math.min(i + 100, data.length)}/${data.length}\r`);
  }
  saveCache();

  let n = 0;
  for (const d of data) {
    if (typeof d.lat !== 'number') continue;
    const j = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${d.lat}&longitude=${d.lng}&localityLanguage=en`, 150);
    process.stderr.write(`state check ${++n}/${data.length}\r`);
    if (n % 25 === 0) saveCache();
    if (!j) continue;
    const where = STATE_ALIAS[j.principalSubdivision] || j.principalSubdivision || '';
    geo[d.id] = { ...geo[d.id], state: where, locality: j.locality || j.city || '' };
    if (j.countryName && j.countryName !== 'India') add(d.id, 'HIGH', 'wrong-country', `the coordinate is in ${j.countryName}`);
    else if (where && where !== d.state && !OK_NEIGHBOUR.has(`${d.state}|${where}`)) {
      add(d.id, 'HIGH', 'state-mismatch', `claims ${d.state}, coordinate sits in ${where} (${geo[d.id].locality})`);
    }
  }
  saveCache();

  n = 0;
  for (const d of data) {
    if (typeof d.lat !== 'number') continue;
    const q = geocodeQuery(d);
    const j = await getJSON(`https://photon.komoot.io/api/?limit=8&q=${encodeURIComponent(q)}`, 350);
    process.stderr.write(`place check ${++n}/${data.length}\r`);
    if (n % 25 === 0) saveCache();
    const feats = (j?.features || []).filter(f => f.properties?.countrycode === 'IN');
    if (!feats.length) { add(d.id, 'LOW', 'no-geocode', `OpenStreetMap has no match for "${q}"`); continue; }
    let best = null, inState = null;
    for (const f of feats) {
      const [lng, lat] = f.geometry.coordinates, p = f.properties;
      const c = { dkm: km(d.lat, d.lng, lat, lng), name: p.name, state: p.state || '' };
      if (!best || c.dkm < best.dkm) best = c;
      if ((STATE_ALIAS[c.state] || c.state) === d.state && (!inState || c.dkm < inState.dkm)) inState = c;
    }
    const use = inState || best;
    // the coordinate already passed the state check, so a distant name match is
    // often just OSM naming: the reverse-geocoded locality is the tie-breaker
    const hint = geo[d.id]?.locality ? ` [coordinate is in ${geo[d.id].locality}]` : '';
    if (use.dkm > 40) add(d.id, 'MED', 'coord-far', `${Math.round(use.dkm)} km from OSM's "${use.name}"${hint}`);
    else if (use.dkm > 18) add(d.id, 'LOW', 'coord-off', `${Math.round(use.dkm)} km from OSM's "${use.name}"${hint}`);
  }
  saveCache();
}

let data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
if (ONLY.length) data = data.filter(d => ONLY.includes(d.id));
console.error(`checking ${data.length} destinations in ${path.relative(ROOT, FILE) || FILE}`);

offlineChecks(data);
if (!OFFLINE) await onlineChecks(data);

const rank = { HIGH: 0, MED: 1, LOW: 2 };
flags.sort((a, b) => rank[a.sev] - rank[b.sev] || a.id.localeCompare(b.id));
const counts = flags.reduce((m, f) => ({ ...m, [f.sev]: (m[f.sev] || 0) + 1 }), {});
console.error('');
for (const f of flags) console.log(`${f.sev.padEnd(4)} ${f.id.padEnd(28)} ${f.code}: ${f.msg}`);
console.log(`\n${data.length} destinations · HIGH ${counts.HIGH || 0} · MED ${counts.MED || 0} · LOW ${counts.LOW || 0}`);
process.exit(counts.HIGH ? 1 : 0);
