#!/usr/bin/env node
// Builds the crawlable half of mynextstop.online.
//
//   node tools/build-seo.mjs            # write pages + sitemaps
//   node tools/build-seo.mjs --check    # fail if the output is stale (CI)
//   node tools/build-seo.mjs --clean    # drop generated dirs first
//
// The app at "/" is one URL with a map in it. Search engines cannot rank a
// map, so every fact the catalogue already knows, the season windows, the
// four season-specific "why now" lines, the vibe, the hub, is also written
// out as a plain HTML page they can read:
//
//   /places/<id>              589 destination guides
//   /india/<state>             36 state guides
//   /best-time-to-visit/<mon>  12 month guides
//   /themes/<category>         16 theme guides
//   /places /india /themes /best-time-to-visit   four browse indexes
//
// Pages are generated as <dir>/index.html so the extensionless URL works on
// any static host, Vercel or `python -m http.server`, with no redirect hop.
// Nothing here is invented: every sentence comes from data/destinations.json.
// Re-run it after editing the catalogue and commit the diff; there is no
// build step at deploy time, which is the point.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MONTHS, seasonOf, seasonStatus, haversineKm, roadEstimate, festivalMonth,
} from '../js/engine.js';
import { CATEGORY_LABEL } from '../js/themes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DATA = path.join(ROOT, 'data', 'destinations.json');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const CLEAN = argv.includes('--clean');

const SITE = 'https://mynextstop.online';
const BRAND = 'my next stop';
const OG_IMAGE = `${SITE}/og-image.png`;

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const SEASON_ORDER = ['winter', 'summer', 'monsoon', 'autumn'];
const SEASON_LABEL = {
  winter: 'Winter', summer: 'Summer', monsoon: 'Monsoon', autumn: 'Autumn',
};
const SEASON_SPAN = {
  winter: 'December to February', summer: 'March to May',
  monsoon: 'June to September', autumn: 'October to November',
};
const BUDGET_LABEL = { 1: 'Shoestring', 2: 'Mid-range', 3: 'Splurge' };
const CROWD_LABEL = { 1: 'Quiet', 2: 'Steady', 3: 'Busy' };
const SOLO_LABEL = {
  2: 'Doable solo with some planning', 3: 'Fine solo',
  4: 'Easy solo', 5: 'Made for solo travellers',
};
const STATUS_WORD = {
  peak: 'peak season', shoulder: 'shoulder season',
  off: 'off-season', avoid: 'best avoided',
};

// ---------- text helpers ----------

// The catalogue is prose written by hand; keep long dashes out of the page
// the same way the app strips them at render time.
const deDash = s => typeof s === 'string' ? s.replace(/\s*[—–]\s*/g, ', ') : s;

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// data prose on its way into HTML
const txt = s => esc(deDash(s));

// data prose on its way into a JSON-LD string
const jtxt = s => deDash(String(s ?? ''));

const slug = s => String(s).toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// Meta descriptions get cut by Google around 160 chars; cut on a word so the
// sentence never ends mid-word.
function clip(s, n = 158) {
  s = deDash(String(s)).replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,.;:]$/, '') + '…';
}

function sentence(s) {
  s = String(s ?? '').trim();
  if (!s) return '';
  return /[.!?…]$/.test(s) ? s : s + '.';
}

// "a", "a and b", "a, b and c"
function joinWords(arr, last = 'and') {
  const a = arr.filter(Boolean);
  if (a.length <= 1) return a[0] || '';
  return `${a.slice(0, -1).join(', ')} ${last} ${a[a.length - 1]}`;
}

// [12,1,2,3] -> "December to March"; [2,10,11] -> "October to November and February"
function monthRanges(months, full = true) {
  const set = [...new Set(months || [])].filter(m => m >= 1 && m <= 12);
  if (!set.length) return '';
  const name = m => full ? MONTH_FULL[m - 1] : MONTHS[m - 1];
  const has = new Set(set);
  if (has.size === 12) return 'every month';
  // each run starts at a month whose predecessor is absent (cyclically)
  const starts = [...has].filter(m => !has.has(m === 1 ? 12 : m - 1)).sort((a, b) => a - b);
  const runs = starts.map(s => {
    let end = s;
    while (has.has(end === 12 ? 1 : end + 1)) end = end === 12 ? 1 : end + 1;
    return s === end ? name(s) : `${name(s)} to ${name(end)}`;
  });
  return joinWords(runs);
}

const monthSlug = m => MONTH_FULL[m - 1].toLowerCase();
const catLabel = c => CATEGORY_LABEL[c] || c;

// Google renders about 60 characters of a title. Build from the part that
// carries the query and bolt on the optional halves only while they fit, so
// no page ships a title that gets cut mid-word in the results.
function fitTitle(core, extras = [], limit = 62) {
  let t = core;
  for (const e of extras) if ((t + e).length <= limit) t += e;
  return t;
}

// ---------- page shell ----------

const ICON = {
  compass: '<circle cx="12" cy="12" r="9"/><polygon points="15.5,8.5 13.7,13.7 8.5,15.5 10.3,10.3" fill="currentColor" stroke="none"/>',
  map: '<path d="M9 4 3.5 6.2v13.3L9 17.3l6 2.2 5.5-2.2V4L15 6.2z"/><path d="M9 4v13.3M15 6.2v13.3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
const ic = (n, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

const jsonld = obj => `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n</script>`;

// Breadcrumbs render twice: as the visible trail and as BreadcrumbList.
// crumbs = [[label, href], ...] with the current page last and href null.
function breadcrumbHtml(crumbs) {
  const parts = crumbs.map(([label, href], i) => {
    const last = i === crumbs.length - 1;
    return last || !href
      ? `<li aria-current="page">${txt(label)}</li>`
      : `<li><a href="${href}">${txt(label)}</a></li>`;
  });
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${parts.join('')}</ol></nav>`;
}

const breadcrumbLd = crumbs => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: crumbs.map(([name, href], i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name: jtxt(name),
    ...(href ? { item: SITE + href } : {}),
  })),
});

const FOOT_LINKS = [
  ['All 589 destinations', '/places'],
  ['By state', '/india'],
  ['By month', '/best-time-to-visit'],
  ['By theme', '/themes'],
  ['The live season map', '/'],
];

/** The one HTML shell every generated page uses. */
function page({ url, title, description, crumbs = [], ld = [], main, ogType = 'article' }) {
  const canonical = SITE + url;
  const desc = clip(description);
  const graph = crumbs.length ? [breadcrumbLd(crumbs), ...ld] : ld;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <meta name="theme-color" content="#0e7a6c" />

  <script src="/js/theme-init.js"></script>

  <link rel="canonical" href="${canonical}" />

  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:type" content="${ogType}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:site_name" content="${BRAND}" />
  <meta property="og:locale" content="en_IN" />
  <meta property="og:image" content="${OG_IMAGE}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${OG_IMAGE}" />

  <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />

  <link rel="stylesheet" href="/css/style.css" />
  <link rel="stylesheet" href="/css/pages.css" />

${graph.map(o => jsonld(o)).join('\n')}
</head>
<body class="doc">

  <a class="skip" href="#main">Skip to content</a>

  <header class="doc-top">
    <a class="brand" href="/" aria-label="${BRAND}, home">
      ${ic('compass', 'brand-mark')}
      <span class="brand-name">${BRAND}</span>
    </a>
    <nav class="doc-nav" aria-label="Sections">
      <a href="/places">Destinations</a>
      <a href="/india">States</a>
      <a href="/best-time-to-visit">Months</a>
      <a href="/themes">Themes</a>
    </nav>
    <button id="themeBtn" class="icon-btn" aria-label="Toggle theme"></button>
  </header>

  ${crumbs.length ? breadcrumbHtml(crumbs) : ''}

  <main class="doc-main" id="main">
${main}
  </main>

  <footer class="doc-foot">
    <p class="foot-cta">
      <a class="btn btn-primary" href="/">${ic('map')} Open the live season map</a>
    </p>
    <nav class="foot-nav" aria-label="Footer">
      ${FOOT_LINKS.map(([l, h]) => `<a href="${h}">${esc(l)}</a>`).join('')}
    </nav>
    <p class="foot-fine">
      ${BRAND} is a free, open-source season map for travelling India. No sign-up, no
      account, and your location never leaves the page. Destination data is
      <a href="https://github.com/ForPublicOrg/mynextstop.online" rel="noopener">open</a>
      under CC BY 4.0. Distances are straight-line estimates converted to road
      figures, always check current road and weather conditions before you set out.
    </p>
  </footer>

  <script src="/js/page.js" defer></script>
  <script defer src="/_vercel/insights/script.js"></script>
</body>
</html>
`;
}

// ---------- shared components ----------

// The twelve-month season bar. Colour carries the pattern; the text in each
// cell carries the meaning for anything that cannot see colour.
function monthStrip(d, link = false) {
  const cells = MONTHS.map((mo, i) => {
    const m = i + 1;
    const st = seasonStatus(d, m);
    const label = `${MONTH_FULL[m - 1]}: ${STATUS_WORD[st]}`;
    const inner = `<span class="ms-mo">${mo}</span><span class="sr-only">, ${STATUS_WORD[st]}</span>`;
    return link
      ? `<li class="ms ms-${st}"><a href="/best-time-to-visit/${monthSlug(m)}" title="${esc(label)}">${inner}</a></li>`
      : `<li class="ms ms-${st}" title="${esc(label)}">${inner}</li>`;
  }).join('');
  return `<ul class="mstrip" aria-label="Season by month">${cells}</ul>`;
}

const STRIP_KEY = `<p class="mstrip-key">
        <span><i class="dot dot-peak"></i>peak</span>
        <span><i class="dot dot-shoulder"></i>shoulder</span>
        <span><i class="dot dot-off"></i>off-season</span>
        <span><i class="dot dot-avoid"></i>avoid</span>
      </p>`;

function catLinks(cats) {
  return (cats || []).filter(c => CATEGORY_LABEL[c])
    .map(c => `<a class="tag" href="/themes/${c}">${esc(catLabel(c))}</a>`).join('');
}

// One destination as a card in any list. `note` is an optional extra line
// (distance on a nearby list, the season line on a month list).
function destCard(d, note = '') {
  return `<li class="dcard">
        <a class="dcard-link" href="/places/${d.id}">
          <span class="dcard-name">${txt(d.name)}</span>
          <span class="dcard-state">${txt(d.state)}</span>
        </a>
        <p class="dcard-tag">${txt(d.tagline)}</p>
        ${note ? `<p class="dcard-note">${note}</p>` : ''}
        <p class="dcard-tags">${catLinks(d.category)}</p>
      </li>`;
}

const destGrid = (ds, note = () => '') =>
  `<ul class="dgrid">${ds.map(d => destCard(d, note(d))).join('')}</ul>`;

// The compact tail of a long list: names only, still a real crawlable link.
const destLinkList = ds =>
  `<ul class="dlinks">${ds.map(d =>
    `<li><a href="/places/${d.id}">${txt(d.name)}</a> <span>${txt(d.state)}</span></li>`).join('')}</ul>`;

const itemListLd = (ds, name) => ({
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: jtxt(name),
  numberOfItems: ds.length,
  itemListOrder: 'https://schema.org/ItemListUnordered',
  itemListElement: ds.map((d, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    url: `${SITE}/places/${d.id}`,
    name: jtxt(d.name),
  })),
});

const faqLd = qas => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: qas.map(([q, a]) => ({
    '@type': 'Question',
    name: jtxt(q),
    acceptedAnswer: { '@type': 'Answer', text: jtxt(a) },
  })),
});

// Visible FAQ. Google only trusts FAQPage markup whose answers are on the
// page, so the same strings feed both.
const faqHtml = qas => `<section class="sec">
      <h2>Common questions</h2>
      <div class="faq">
        ${qas.map(([q, a]) => `<details><summary>${txt(q)}</summary><p>${txt(a)}</p></details>`).join('')}
      </div>
    </section>`;

// Spread picks across states so a "best of" list is not forty entries from
// one state; deterministic, no randomness, so rebuilds produce no diff.
function pickDiverse(ds, n) {
  const byState = new Map();
  for (const d of ds) {
    if (!byState.has(d.state)) byState.set(d.state, []);
    byState.get(d.state).push(d);
  }
  // strongest solo score first inside each state, states by depth then name
  for (const list of byState.values()) {
    list.sort((a, b) => (b.solo || 3) - (a.solo || 3) || a.name.localeCompare(b.name));
  }
  const states = [...byState.keys()].sort((a, b) =>
    byState.get(b).length - byState.get(a).length || a.localeCompare(b));
  const out = [];
  for (let round = 0; out.length < n; round++) {
    let added = 0;
    for (const s of states) {
      const list = byState.get(s);
      if (round < list.length) { out.push(list[round]); added++; }
      if (out.length >= n) break;
    }
    if (!added) break;
  }
  return out;
}

const byName = (a, b) => a.name.localeCompare(b.name);

// ---------- destination page ----------

function destTitle(d) {
  return fitTitle(`Best time to visit ${deDash(d.name)}`,
    [`, ${d.state}`, ` | ${BRAND}`]);
}

// The three answers below are used verbatim by the visible FAQ and by the
// FAQPage markup, so the two can never drift apart.
function destFaq(d) {
  const peak = monthRanges(d.peakMonths);
  const shoulder = monthRanges(d.shoulderMonths);
  const avoid = monthRanges(d.avoidMonths);
  const name = deDash(d.name);

  const when = [
    peak ? `${peak} is peak season in ${name}.` : `${name} has no single stand-out month.`,
    shoulder ? `${shoulder} is shoulder season: thinner crowds, a bit more risk in the weather.` : '',
    avoid ? `Avoid ${avoid}.` : 'No month is a write-off here.',
    sentence(d.why && d.why[peak ? seasonOf(d.peakMonths[0]) : 'winter']),
  ].filter(Boolean).join(' ');

  const stay = `${d.days} ${d.days === 1 ? 'day' : 'days'} is the usual stay. ${sentence(d.vibe)}`;

  const reach = `${sentence(d.hub)} Practical ways in: ${joinWords((d.modes || []).map(m => m))}.`;

  const cost = `${BUDGET_LABEL[d.budget] || 'Mid-range'} by Indian travel standards, and it runs ${(CROWD_LABEL[d.crowd] || 'steady').toLowerCase()} at the busiest time of year. ${SOLO_LABEL[d.solo] || 'Fine solo'}.`;

  const qas = [
    [`When is the best time to visit ${name}?`, when],
    [`How many days do you need in ${name}?`, stay],
    [`How do you get to ${name}?`, reach],
    [`Is ${name} expensive, and does it get crowded?`, cost],
  ];
  if (d.festival) {
    qas.push([`Is there a festival in ${name}?`,
      `${sentence(d.festival)} Time a trip around it and you see the place at its loudest, but book beds early.`]);
  }
  return qas;
}

function destPage(d, all) {
  const name = deDash(d.name);
  const peak = monthRanges(d.peakMonths);
  const shoulder = monthRanges(d.shoulderMonths);
  const avoid = monthRanges(d.avoidMonths);
  const url = `/places/${d.id}`;

  const crumbs = [
    ['Home', '/'],
    ['Destinations', '/places'],
    [d.state, `/india/${slug(d.state)}`],
    [name, null],
  ];

  // nearest eight, so every page is a doorway into the rest of the catalogue
  const near = all
    .filter(o => o.id !== d.id)
    .map(o => ({ o, km: haversineKm(d.lat, d.lng, o.lat, o.lng) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 8)
    .map(({ o, km }) => {
      const { roadKm, hours } = roadEstimate(km, o.alt);
      const time = hours < 1 ? 'under an hour'
        : hours < 10 ? `about ${Math.round(hours)} h`
        : 'an overnight ride';
      return { o, note: `${roadKm} km from ${esc(name)}, roughly ${time} by road` };
    });

  const sameState = all.filter(o => o.state === d.state && o.id !== d.id).sort(byName);
  const cats = (d.category || []).filter(c => CATEGORY_LABEL[c]);

  const seasons = SEASON_ORDER.map(s => {
    const why = d.why && d.why[s];
    if (!why) return '';
    const months = { winter: [12, 1, 2], summer: [3, 4, 5], monsoon: [6, 7, 8, 9], autumn: [10, 11] }[s];
    const statuses = new Set(months.map(m => seasonStatus(d, m)));
    const verdict = statuses.has('peak') ? 'peak' : statuses.has('avoid') && statuses.size === 1 ? 'avoid'
      : statuses.has('shoulder') ? 'shoulder' : statuses.has('avoid') ? 'mixed' : 'off';
    const badge = {
      peak: '<span class="vd vd-peak">Prime time</span>',
      shoulder: '<span class="vd vd-shoulder">Shoulder</span>',
      off: '<span class="vd vd-off">Quiet, but open</span>',
      avoid: '<span class="vd vd-avoid">Do not go</span>',
      mixed: '<span class="vd vd-mixed">Mixed, read the detail</span>',
    }[verdict];
    return `<div class="season">
          <h3>${SEASON_LABEL[s]} <small>${SEASON_SPAN[s]}</small> ${badge}</h3>
          <p>${txt(why)}</p>
        </div>`;
  }).join('');

  const facts = [
    ['How long to stay', `${d.days} ${d.days === 1 ? 'day' : 'days'}`],
    ['Budget', BUDGET_LABEL[d.budget] || '—'],
    ['How busy', `${CROWD_LABEL[d.crowd] || '—'} at its peak`],
    ['Solo travel', SOLO_LABEL[d.solo] || '—'],
    ['Altitude', `${d.alt} m`],
    ['State', `<a href="/india/${slug(d.state)}">${txt(d.state)}</a>`],
    ['Coordinates', `${d.lat.toFixed(4)}, ${d.lng.toFixed(4)}`],
  ];

  const peakMonthLinks = (d.peakMonths || []).slice().sort((a, b) => a - b)
    .map(m => `<a class="tag" href="/best-time-to-visit/${monthSlug(m)}">${MONTH_FULL[m - 1]}</a>`).join('');

  const qas = destFaq(d);

  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'TouristAttraction',
      name: jtxt(d.name),
      description: jtxt(d.tagline),
      url: SITE + url,
      image: OG_IMAGE,
      geo: { '@type': 'GeoCoordinates', latitude: d.lat, longitude: d.lng, elevation: `${d.alt} m` },
      address: {
        '@type': 'PostalAddress',
        addressRegion: jtxt(d.state),
        addressCountry: 'IN',
      },
      containedInPlace: { '@type': 'AdministrativeArea', name: jtxt(d.state) },
      touristType: cats.map(catLabel),
      isAccessibleForFree: true,
      publicAccess: true,
    },
    faqLd(qas),
  ];

  const main = `
    <article class="doc-article">

      <header class="lede">
        <p class="eyebrow"><a href="/india/${slug(d.state)}">${txt(d.state)}</a></p>
        <h1>${txt(d.name)}</h1>
        <p class="lede-sub">${txt(d.tagline)}</p>
        <p class="lede-tags">${catLinks(cats)}</p>
      </header>

      <section class="sec sec-when">
        <h2>Best time to visit ${txt(name)}</h2>
        ${monthStrip(d, true)}
        ${STRIP_KEY}
        <ul class="whenlist">
          ${peak ? `<li><b>Go:</b> ${esc(peak)}</li>` : ''}
          ${shoulder ? `<li><b>Shoulder:</b> ${esc(shoulder)}, quieter, and the weather is less of a sure thing</li>` : ''}
          ${avoid ? `<li><b>Skip:</b> ${esc(avoid)}</li>` : '<li><b>Skip:</b> no month is a write-off here</li>'}
        </ul>
        ${peakMonthLinks ? `<p class="alsosee">Planning a specific month? ${peakMonthLinks}</p>` : ''}
      </section>

      <section class="sec">
        <h2>${txt(name)} season by season</h2>
        <div class="seasons">${seasons}</div>
      </section>

      ${d.festival ? `<aside class="callout">
        <h2>Signature festival</h2>
        <p>${txt(d.festival)}</p>
      </aside>` : ''}

      <section class="sec">
        <h2>What ${txt(name)} is actually like</h2>
        <p class="prose">${txt(d.vibe)}</p>
      </section>

      <section class="sec">
        <h2>Getting to ${txt(name)}</h2>
        <p class="prose">${txt(d.hub)}</p>
        <p class="modes">Practical ways in: ${(d.modes || []).map(m => `<span class="tag tag-plain">${esc(m)}</span>`).join('')}</p>
      </section>

      <section class="sec">
        <h2>Trip facts</h2>
        <dl class="facts">
          ${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}
        </dl>
      </section>

      <aside class="cta">
        <h2>See ${txt(name)} on the live map</h2>
        <p>The map knows today's date and where you are, and draws the route from
           where you stand, with the honest verdict for the month you pick.</p>
        <p><a class="btn btn-primary btn-big" href="/?to=${encodeURIComponent(d.id)}">${ic('map')} Open ${txt(name)} on the map</a></p>
      </aside>

      ${faqHtml(qas)}

      <section class="sec">
        <h2>Nearby, and where to go next</h2>
        ${destGrid(near.map(n => n.o), o => {
          const hit = near.find(n => n.o.id === o.id);
          return hit ? hit.note : '';
        })}
      </section>

      ${sameState.length ? `<section class="sec">
        <h2>More places to visit in ${txt(d.state)}</h2>
        ${destLinkList(sameState.slice(0, 40))}
        <p class="alsosee"><a class="more" href="/india/${slug(d.state)}">All ${sameState.length + 1} destinations in ${txt(d.state)} ${ic('arrow')}</a></p>
      </section>` : ''}

    </article>`;

  return {
    url,
    html: page({
      url,
      title: destTitle(d),
      description: `${sentence(deDash(d.tagline))} Best time to visit ${name}: ${peak || 'shoulder months'}. Season by season, how to get there, and how many days to give it.`,
      crumbs, ld, main,
    }),
  };
}

// ---------- state page ----------

function statePage(state, ds, all) {
  const url = `/india/${slug(state)}`;
  const list = ds.slice().sort(byName);
  const crumbs = [['Home', '/'], ['States', '/india'], [state, null]];

  // which months the state is actually good in, straight out of the data
  const peakByMonth = Array.from({ length: 12 }, (_, i) =>
    ds.filter(d => (d.peakMonths || []).includes(i + 1)).length);
  const bestMonths = peakByMonth
    .map((n, i) => [n, i + 1])
    .sort((a, b) => b[0] - a[0]).slice(0, 4).map(([, m]) => m).sort((a, b) => a - b);
  const worstMonth = peakByMonth.map((n, i) => [n, i + 1]).sort((a, b) => a[0] - b[0])[0][1];

  const catCount = {};
  for (const d of ds) for (const c of d.category || []) if (CATEGORY_LABEL[c]) catCount[c] = (catCount[c] || 0) + 1;
  const topCats = Object.entries(catCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const monthTable = `<ol class="mcount">
        ${peakByMonth.map((n, i) => `<li${n === Math.max(...peakByMonth) ? ' class="is-best"' : ''}>
          <a href="/best-time-to-visit/${monthSlug(i + 1)}"><span class="mc-mo">${MONTHS[i]}</span><span class="mc-n">${n}</span></a></li>`).join('')}
      </ol>
      <p class="mstrip-key"><span>Curated places in ${esc(state)} that are in peak season, by month. Tap a month for the whole country.</span></p>`;

  const others = [...new Set(all.map(d => d.state))].filter(s => s !== state).sort();

  const qas = [
    [`When is the best time to visit ${state}?`,
      `Across the ${ds.length} curated ${ds.length === 1 ? 'destination' : 'destinations'} in ${state}, ${joinWords(bestMonths.map(m => MONTH_FULL[m - 1]))} are the months with the most places in peak season. ${MONTH_FULL[worstMonth - 1]} has the fewest, at ${peakByMonth[worstMonth - 1]}.`],
    [`How many places are worth visiting in ${state}?`,
      `This catalogue lists ${ds.length} in ${state}, chosen for the landscape or the heritage rather than for size. Plain cities are deliberately left out unless the trip is the heritage itself. The strongest themes here are ${joinWords(topCats.map(([c, n]) => `${catLabel(c).toLowerCase()} (${n})`))}.`],
    [`What kind of places are in ${state}?`,
      `${joinWords(topCats.map(([c, n]) => `${n} ${catLabel(c).toLowerCase()}`))}. Every entry carries its own peak, shoulder and avoid months, so nothing is recommended in a month it should not be.`],
  ];

  const main = `
    <article class="doc-article">
      <header class="lede">
        <p class="eyebrow"><a href="/india">India</a></p>
        <h1>Best places to visit in ${txt(state)}</h1>
        <p class="lede-sub">${ds.length} curated ${ds.length === 1 ? 'destination' : 'destinations'} in ${txt(state)}, each with its honest season window: when to go, when it is merely fine, and when to stay away.</p>
      </header>

      <section class="sec">
        <h2>When to visit ${txt(state)}</h2>
        ${monthTable}
        <p class="prose">${joinWords(bestMonths.map(m => `<a href="/best-time-to-visit/${monthSlug(m)}">${MONTH_FULL[m - 1]}</a>`))} put the most of ${txt(state)} in peak season. ${MONTH_FULL[worstMonth - 1]} the fewest, with ${peakByMonth[worstMonth - 1]}.</p>
      </section>

      <section class="sec">
        <h2>All ${ds.length} ${ds.length === 1 ? 'destination' : 'destinations'} in ${txt(state)}</h2>
        ${destGrid(list, d => `Peak: ${esc(monthRanges(d.peakMonths, false)) || 'no stand-out month'}`)}
      </section>

      <section class="sec">
        <h2>By theme in ${txt(state)}</h2>
        <p class="alsosee">${topCats.map(([c, n]) => `<a class="tag" href="/themes/${c}">${esc(catLabel(c))} (${n})</a>`).join('')}</p>
      </section>

      ${faqHtml(qas)}

      <section class="sec">
        <h2>Other states and union territories</h2>
        <p class="statelinks">${others.map(s => `<a href="/india/${slug(s)}">${esc(s)}</a>`).join('')}</p>
      </section>
    </article>`;

  return {
    url,
    html: page({
      url,
      title: fitTitle(`Best places to visit in ${state}`,
        [` (${ds.length} picks)`, ` | ${BRAND}`]),
      description: `${ds.length} curated places to visit in ${state}, each with peak, shoulder and avoid months. Best around ${joinWords(bestMonths.slice(0, 3).map(m => MONTH_FULL[m - 1]))}.`,
      crumbs,
      ld: [itemListLd(list, `Places to visit in ${state}`), faqLd(qas)],
      main,
    }),
  };
}

// ---------- month page ----------

function monthPage(m, all) {
  const mf = MONTH_FULL[m - 1];
  const url = `/best-time-to-visit/${monthSlug(m)}`;
  const season = seasonOf(m);
  const crumbs = [['Home', '/'], ['Best time to visit', '/best-time-to-visit'], [mf, null]];

  const peak = all.filter(d => seasonStatus(d, m) === 'peak').sort(byName);
  const shoulder = all.filter(d => seasonStatus(d, m) === 'shoulder').sort(byName);
  const avoid = all.filter(d => seasonStatus(d, m) === 'avoid').sort(byName);

  const featured = pickDiverse(peak, 36);
  const featuredIds = new Set(featured.map(d => d.id));
  const rest = peak.filter(d => !featuredIds.has(d.id));

  const prev = m === 1 ? 12 : m - 1;
  const next = m === 12 ? 1 : m + 1;

  // festivals whose month string names this month
  const fests = all.filter(d => d.festival && festivalMonth(d) === m).sort(byName).slice(0, 24);

  const stateCount = {};
  for (const d of peak) stateCount[d.state] = (stateCount[d.state] || 0) + 1;
  const topStates = Object.entries(stateCount).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const qas = [
    [`Where should you travel in India in ${mf}?`,
      `${peak.length} of the ${all.length} destinations in this catalogue are in peak season in ${mf}, with another ${shoulder.length} in shoulder season. ${topStates.length ? `The states with the most places at their best are ${joinWords(topStates.slice(0, 4).map(([s, n]) => `${s} (${n})`))}.` : ''}`],
    [`Where should you avoid in India in ${mf}?`,
      avoid.length
        ? `${avoid.length} places in this catalogue are marked avoid in ${mf}: closed park gates, snowed-in passes, cancelled ferries, landslide roads or plain 45 degree heat. ${joinWords(avoid.slice(0, 6).map(d => deDash(d.name)))} are among them.`
        : `Nothing in this catalogue is marked avoid in ${mf}, it is one of the safest months to travel almost anywhere in India.`],
    [`Is ${mf} a good time to visit India?`,
      `${mf} falls in the ${season} season. ${peak.length >= all.length / 3 ? `It is one of the strong months: roughly ${Math.round(peak.length / all.length * 100)} per cent of the catalogue is at its best.` : `It is a narrower month, roughly ${Math.round(peak.length / all.length * 100)} per cent of the catalogue is at its best, so it pays to pick the region carefully rather than the country.`}`],
  ];

  const main = `
    <article class="doc-article">
      <header class="lede">
        <p class="eyebrow"><a href="/best-time-to-visit">Month by month</a></p>
        <h1>Best places to visit in India in ${mf}</h1>
        <p class="lede-sub">${peak.length} of ${all.length} curated destinations are in peak season in ${mf}, and ${avoid.length} are ones to stay away from. No listicle lies: every verdict here comes from the place's own season window.</p>
      </header>

      <nav class="monthnav" aria-label="Other months">
        <a href="/best-time-to-visit/${monthSlug(prev)}">← ${MONTH_FULL[prev - 1]}</a>
        <a href="/best-time-to-visit">All months</a>
        <a href="/best-time-to-visit/${monthSlug(next)}">${MONTH_FULL[next - 1]} →</a>
      </nav>

      <section class="sec">
        <h2>Where India is at its best in ${mf}</h2>
        <p class="prose">Each line below is the reason this place works in the ${season}, written for that place, not a generic blurb.</p>
        ${destGrid(featured, d => txt((d.why && d.why[season]) || d.tagline))}
      </section>

      ${rest.length ? `<section class="sec">
        <h2>Also in peak season in ${mf}</h2>
        <p class="prose">${rest.length} more, all of them in their best window this month.</p>
        ${destLinkList(rest)}
      </section>` : ''}

      ${avoid.length ? `<section class="sec sec-avoid">
        <h2>Where not to go in India in ${mf}</h2>
        <p class="prose">These ${avoid.length} are hard no's this month: a closed gate, a snowed-in pass, cancelled boats, landslide season or heat that makes the trip pointless. The app will never suggest them in ${mf}.</p>
        ${destLinkList(avoid)}
      </section>` : ''}

      ${shoulder.length ? `<section class="sec">
        <h2>Shoulder season in ${mf}</h2>
        <p class="prose">Fewer people, cheaper beds, and a real chance the weather does not cooperate. ${shoulder.length} places sit in shoulder season this month.</p>
        ${destLinkList(shoulder.slice(0, 80))}
      </section>` : ''}

      ${fests.length ? `<section class="sec">
        <h2>Festivals in ${mf}</h2>
        <ul class="festlist">${fests.map(d =>
          `<li><a href="/places/${d.id}">${txt(d.name)}</a>, ${txt(d.state)}: ${txt(d.festival)}</li>`).join('')}</ul>
      </section>` : ''}

      ${topStates.length ? `<section class="sec">
        <h2>Best states to visit in ${mf}</h2>
        <p class="statelinks">${topStates.map(([s, n]) =>
          `<a href="/india/${slug(s)}">${esc(s)} (${n})</a>`).join('')}</p>
      </section>` : ''}

      ${faqHtml(qas)}

      <aside class="cta">
        <h2>Planning ${mf}?</h2>
        <p>Set the map to ${mf} and it re-ranks everything for that month from wherever you are standing.</p>
        <p><a class="btn btn-primary btn-big" href="/">${ic('map')} Open the season map</a></p>
      </aside>
    </article>`;

  return {
    url,
    html: page({
      url,
      title: fitTitle(`Best places to visit in India in ${mf}`,
        [` (${peak.length} in season)`, ` | ${BRAND}`]),
      description: `${peak.length} Indian destinations are in peak season in ${mf}, and ${avoid.length} to avoid. Honest season windows, festivals and the states at their best.`,
      crumbs,
      ld: [itemListLd(featured, `Best places to visit in India in ${mf}`), faqLd(qas)],
      main,
    }),
  };
}

// ---------- theme page ----------

function themePage(cat, ds, all) {
  const label = catLabel(cat);
  const url = `/themes/${cat}`;
  const list = ds.slice().sort(byName);
  const crumbs = [['Home', '/'], ['Themes', '/themes'], [label, null]];

  const featured = pickDiverse(list, Math.min(36, list.length));
  const featuredIds = new Set(featured.map(d => d.id));
  const rest = list.filter(d => !featuredIds.has(d.id));

  const peakByMonth = Array.from({ length: 12 }, (_, i) =>
    ds.filter(d => (d.peakMonths || []).includes(i + 1)).length);
  const bestMonths = peakByMonth.map((n, i) => [n, i + 1])
    .sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, m]) => m).sort((a, b) => a - b);

  const stateCount = {};
  for (const d of ds) stateCount[d.state] = (stateCount[d.state] || 0) + 1;
  const topStates = Object.entries(stateCount).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const title = `Best ${label.toLowerCase()} destinations in India`;

  const qas = [
    [`How many ${label.toLowerCase()} destinations are there in India?`,
      `This catalogue lists ${ds.length} tagged ${label.toLowerCase()}, across ${Object.keys(stateCount).length} states and union territories. It is a curated list, not an exhaustive one: places earn a spot on the strength of the landscape or the heritage.`],
    [`When is the best time for a ${label.toLowerCase()} trip in India?`,
      `${joinWords(bestMonths.map(m => MONTH_FULL[m - 1]))} put the most of them in peak season. Each place carries its own window, though, so check the one you are aiming at.`],
    [`Which states have the most ${label.toLowerCase()} destinations?`,
      `${joinWords(topStates.slice(0, 5).map(([s, n]) => `${s} (${n})`))}.`],
  ];

  const main = `
    <article class="doc-article">
      <header class="lede">
        <p class="eyebrow"><a href="/themes">Themes</a></p>
        <h1>${esc(title)}</h1>
        <p class="lede-sub">${ds.length} curated ${label.toLowerCase()} ${ds.length === 1 ? 'destination' : 'destinations'} across ${Object.keys(stateCount).length} states, each with the months it is worth going and the months it is not.</p>
      </header>

      <section class="sec">
        <h2>Best of ${label.toLowerCase()} India</h2>
        ${destGrid(featured, d => `Peak: ${esc(monthRanges(d.peakMonths, false)) || 'no stand-out month'}`)}
      </section>

      ${rest.length ? `<section class="sec">
        <h2>Every ${label.toLowerCase()} destination in the catalogue</h2>
        ${destLinkList(rest)}
      </section>` : ''}

      <section class="sec">
        <h2>When to go</h2>
        <p class="prose">${joinWords(bestMonths.map(m => `<a href="/best-time-to-visit/${monthSlug(m)}">${MONTH_FULL[m - 1]}</a>`))} are the months with the most ${label.toLowerCase()} places in peak season.</p>
      </section>

      <section class="sec">
        <h2>By state</h2>
        <p class="statelinks">${topStates.map(([s, n]) => `<a href="/india/${slug(s)}">${esc(s)} (${n})</a>`).join('')}</p>
      </section>

      ${faqHtml(qas)}

      <section class="sec">
        <h2>Other themes</h2>
        <p class="alsosee">${Object.keys(CATEGORY_LABEL).filter(c => c !== cat && all.some(d => (d.category || []).includes(c)))
          .map(c => `<a class="tag" href="/themes/${c}">${esc(catLabel(c))}</a>`).join('')}</p>
      </section>
    </article>`;

  return {
    url,
    html: page({
      url,
      title: fitTitle(title, [` (${ds.length} picks)`, ` | ${BRAND}`]),
      description: `${ds.length} curated ${label.toLowerCase()} destinations in India with honest season windows. Best around ${joinWords(bestMonths.map(m => MONTH_FULL[m - 1]))}.`,
      crumbs,
      ld: [itemListLd(featured, title), faqLd(qas)],
      main,
    }),
  };
}

// ---------- index pages ----------

function placesIndex(all) {
  const url = '/places';
  const crumbs = [['Home', '/'], ['Destinations', null]];
  const sorted = all.slice().sort(byName);
  const letters = new Map();
  for (const d of sorted) {
    const L = deDash(d.name)[0].toUpperCase();
    if (!letters.has(L)) letters.set(L, []);
    letters.get(L).push(d);
  }
  const main = `
    <article class="doc-article">
      <header class="lede">
        <h1>All ${all.length} destinations</h1>
        <p class="lede-sub">Every place in the catalogue, A to Z. Beauty first: hill stations, valleys, gorges, waterfalls, beaches and one-bus-a-day villages. A city earns an entry only when the trip is its heritage.</p>
      </header>
      <nav class="azjump" aria-label="Jump to letter">
        ${[...letters.keys()].map(L => `<a href="#l-${L}">${L}</a>`).join('')}
      </nav>
      ${[...letters.entries()].map(([L, ds]) => `<section class="sec" id="l-${L}">
        <h2>${L}</h2>
        ${destLinkList(ds)}
      </section>`).join('')}
    </article>`;
  return {
    url,
    html: page({
      url, ogType: 'website',
      title: fitTitle(`All ${all.length} places to visit in India, A to Z`, [` | ${BRAND}`]),
      description: `The full catalogue: ${all.length} curated Indian destinations across all 36 states and union territories, each with its own honest season window.`,
      crumbs, ld: [itemListLd(sorted, 'All destinations')], main,
    }),
  };
}

function statesIndex(all) {
  const url = '/india';
  const crumbs = [['Home', '/'], ['States', null]];
  const states = {};
  for (const d of all) (states[d.state] = states[d.state] || []).push(d);
  const names = Object.keys(states).sort();
  const main = `
    <article class="doc-article">
      <header class="lede">
        <h1>Places to visit in India, state by state</h1>
        <p class="lede-sub">All 36 states and union territories, ${all.length} curated destinations between them. Pick a state and every entry comes with the months it is worth going.</p>
      </header>
      <section class="sec">
        <ul class="dgrid dgrid-tight">
          ${names.map(s => {
            const ds = states[s];
            const peakByMonth = Array.from({ length: 12 }, (_, i) => ds.filter(d => (d.peakMonths || []).includes(i + 1)).length);
            const best = peakByMonth.map((n, i) => [n, i + 1]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, m]) => MONTHS[m - 1]);
            return `<li class="dcard">
              <a class="dcard-link" href="/india/${slug(s)}">
                <span class="dcard-name">${esc(s)}</span>
                <span class="dcard-state">${ds.length} ${ds.length === 1 ? 'place' : 'places'}</span>
              </a>
              <p class="dcard-note">Strongest in ${esc(joinWords(best))}</p>
            </li>`;
          }).join('')}
        </ul>
      </section>
    </article>`;
  return {
    url,
    html: page({
      url, ogType: 'website',
      title: fitTitle('Places to visit in India, state by state', [` | ${BRAND}`]),
      description: `Best places to visit in every Indian state and union territory, ${all.length} curated destinations with honest peak, shoulder and avoid months.`,
      crumbs,
      ld: [{
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: 'Indian states and union territories',
        numberOfItems: names.length,
        itemListElement: names.map((s, i) => ({
          '@type': 'ListItem', position: i + 1,
          url: `${SITE}/india/${slug(s)}`, name: s,
        })),
      }],
      main,
    }),
  };
}

function monthsIndex(all) {
  const url = '/best-time-to-visit';
  const crumbs = [['Home', '/'], ['Best time to visit', null]];
  const rows = MONTH_FULL.map((mf, i) => {
    const m = i + 1;
    const peak = all.filter(d => seasonStatus(d, m) === 'peak').length;
    const avoid = all.filter(d => seasonStatus(d, m) === 'avoid').length;
    return { m, mf, peak, avoid };
  });
  const main = `
    <article class="doc-article">
      <header class="lede">
        <h1>Best time to visit India, month by month</h1>
        <p class="lede-sub">India does not have one season, it has twelve. Here is how many of the ${all.length} curated destinations are at their best in each month, and how many you should skip.</p>
      </header>
      <section class="sec">
        <ul class="dgrid dgrid-tight">
          ${rows.map(r => `<li class="dcard">
            <a class="dcard-link" href="/best-time-to-visit/${monthSlug(r.m)}">
              <span class="dcard-name">${r.mf}</span>
              <span class="dcard-state">${seasonOf(r.m)}</span>
            </a>
            <p class="dcard-note"><b>${r.peak}</b> in peak season · <b>${r.avoid}</b> to avoid</p>
          </li>`).join('')}
        </ul>
      </section>
      <section class="sec">
        <h2>How the seasons work here</h2>
        <p class="prose">Winter runs December to February, summer March to May, the monsoon June to September, and autumn October to November. Every destination carries its own peak, shoulder and avoid months on top of that, because a monsoon month in the Western Ghats and a monsoon month in Ladakh are not the same trip.</p>
      </section>
    </article>`;
  return {
    url,
    html: page({
      url, ogType: 'website',
      title: fitTitle('Best time to visit India, month by month', [` | ${BRAND}`]),
      description: `Which month to travel India, and where. ${all.length} curated destinations scored peak, shoulder or avoid for all twelve months.`,
      crumbs,
      ld: [{
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: 'Best time to visit India, month by month',
        numberOfItems: 12,
        itemListElement: rows.map((r, i) => ({
          '@type': 'ListItem', position: i + 1,
          url: `${SITE}/best-time-to-visit/${monthSlug(r.m)}`,
          name: `Best places to visit in India in ${r.mf}`,
        })),
      }],
      main,
    }),
  };
}

function themesIndex(all) {
  const url = '/themes';
  const crumbs = [['Home', '/'], ['Themes', null]];
  const cats = Object.keys(CATEGORY_LABEL)
    .map(c => [c, all.filter(d => (d.category || []).includes(c))])
    .filter(([, ds]) => ds.length)
    .sort((a, b) => b[1].length - a[1].length);
  const main = `
    <article class="doc-article">
      <header class="lede">
        <h1>Places to visit in India by theme</h1>
        <p class="lede-sub">Mountains, beaches, heritage, wildlife, treks, and the offbeat corners with one bus a day. ${cats.length} themes across ${all.length} destinations.</p>
      </header>
      <section class="sec">
        <ul class="dgrid dgrid-tight">
          ${cats.map(([c, ds]) => `<li class="dcard">
            <a class="dcard-link" href="/themes/${c}">
              <span class="dcard-name">${esc(catLabel(c))}</span>
              <span class="dcard-state">${ds.length} ${ds.length === 1 ? 'place' : 'places'}</span>
            </a>
          </li>`).join('')}
        </ul>
      </section>
    </article>`;
  return {
    url,
    html: page({
      url, ogType: 'website',
      title: fitTitle('Places to visit in India by theme', [` | ${BRAND}`]),
      description: `Beaches, mountains, heritage, wildlife, treks and offbeat corners: ${all.length} curated Indian destinations sorted by what kind of trip they are.`,
      crumbs,
      ld: [{
        '@context': 'https://schema.org', '@type': 'ItemList',
        name: 'Travel themes in India', numberOfItems: cats.length,
        itemListElement: cats.map(([c], i) => ({
          '@type': 'ListItem', position: i + 1,
          url: `${SITE}/themes/${c}`, name: catLabel(c),
        })),
      }],
      main,
    }),
  };
}

// ---------- sitemaps ----------

function urlset(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(e => `  <url>
    <loc>${SITE}${e.url === '/' ? '/' : e.url}</loc>
    <lastmod>${e.lastmod}</lastmod>
    <changefreq>${e.changefreq || 'monthly'}</changefreq>
    <priority>${e.priority ?? '0.6'}</priority>
  </url>`).join('\n')}
</urlset>
`;
}

function sitemapIndex(names, lastmod) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${names.map(n => `  <sitemap>
    <loc>${SITE}/sitemaps/${n}.xml</loc>
    <lastmod>${lastmod}</lastmod>
  </sitemap>`).join('\n')}
</sitemapindex>
`;
}

// ---------- write ----------

const written = new Map();   // repo-relative path -> contents
function emit(rel, contents) { written.set(rel.split(path.sep).join('/'), contents); }

function pageFile(url) {
  // "/places/hampi" -> "places/hampi/index.html"; "/" -> "index.html"
  return (url === '/' ? '' : url.replace(/^\//, '') + '/') + 'index.html';
}

function build() {
  const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const all = raw.slice().sort(byName);
  // lastmod tracks the catalogue, not the run: a rebuild that changes nothing
  // must not tell Google the whole site moved.
  const lastmod = fs.statSync(DATA).mtime.toISOString().slice(0, 10);

  const built = [];
  for (const d of all) built.push({ ...destPage(d, all), priority: '0.7', changefreq: 'monthly' });

  const states = {};
  for (const d of all) (states[d.state] = states[d.state] || []).push(d);
  const hubs = [];
  for (const s of Object.keys(states).sort()) {
    hubs.push({ ...statePage(s, states[s], all), priority: '0.8', changefreq: 'monthly' });
  }
  for (let m = 1; m <= 12; m++) {
    hubs.push({ ...monthPage(m, all), priority: '0.9', changefreq: 'weekly' });
  }
  for (const c of Object.keys(CATEGORY_LABEL)) {
    const ds = all.filter(d => (d.category || []).includes(c));
    if (ds.length) hubs.push({ ...themePage(c, ds, all), priority: '0.8', changefreq: 'monthly' });
  }

  const core = [
    { url: '/', lastmod, changefreq: 'weekly', priority: '1.0' },
    { ...placesIndex(all), priority: '0.9', changefreq: 'weekly' },
    { ...statesIndex(all), priority: '0.9', changefreq: 'weekly' },
    { ...monthsIndex(all), priority: '0.9', changefreq: 'weekly' },
    { ...themesIndex(all), priority: '0.9', changefreq: 'weekly' },
    // /reel is a hand-built page (reel/index.html), listed here so sitemap
    // regeneration keeps it; no html property, so nothing is emitted for it
    { url: '/reel', lastmod, changefreq: 'weekly', priority: '0.9' },
  ];

  for (const p of [...built, ...hubs, ...core]) {
    if (p.html) emit(pageFile(p.url), p.html);
  }

  emit('sitemaps/places.xml', urlset(built.map(p => ({ ...p, lastmod }))));
  emit('sitemaps/hubs.xml', urlset(hubs.map(p => ({ ...p, lastmod }))));
  emit('sitemaps/core.xml', urlset(core.map(p => ({ ...p, lastmod }))));
  emit('sitemap.xml', sitemapIndex(['core', 'hubs', 'places'], lastmod));

  return { all, built, hubs, core };
}

function flush() {
  let changed = 0;
  for (const [rel, contents] of written) {
    const abs = path.join(ROOT, rel);
    let old = null;
    try { old = fs.readFileSync(abs, 'utf8'); } catch {}
    if (old === contents) continue;
    changed++;
    if (!CHECK) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contents);
    }
  }
  return changed;
}

// Generated directories are owned by this script: anything left there from a
// destination that has since been renamed or dropped is stale, and a stale
// page is a 200 that Google will happily keep in the index.
function sweep() {
  const owned = ['places', 'india', 'themes', 'best-time-to-visit', 'sitemaps'];
  const stale = [];
  for (const dir of owned) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) walk(full);
        else {
          const rel = path.relative(ROOT, full).split(path.sep).join('/');
          if (!written.has(rel)) stale.push(rel);
        }
      }
    };
    walk(abs);
  }
  if (!CHECK) {
    for (const rel of stale) fs.rmSync(path.join(ROOT, rel), { force: true });
    // drop directories the removal emptied
    for (const dir of owned) {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      const prune = (p) => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          if (e.isDirectory()) prune(path.join(p, e.name));
        }
        if (!fs.readdirSync(p).length) fs.rmdirSync(p);
      };
      prune(abs);
    }
  }
  return stale;
}

// ---------- run ----------

if (CLEAN && !CHECK) {
  for (const dir of ['places', 'india', 'themes', 'best-time-to-visit', 'sitemaps']) {
    fs.rmSync(path.join(ROOT, dir), { recursive: true, force: true });
  }
}

const { all, built, hubs } = build();
const stale = sweep();
const changed = flush();

const bytes = [...written.values()].reduce((n, s) => n + Buffer.byteLength(s), 0);
console.log(`${BRAND} SEO build`);
console.log(`  ${built.length} destination pages`);
console.log(`  ${hubs.length} hub pages (states, months, themes)`);
console.log(`  4 browse indexes, plus "/" listed in the sitemap`);
console.log(`  3 sitemaps + 1 sitemap index`);
console.log(`  ${written.size} files, ${(bytes / 1048576).toFixed(1)} MB total`);

if (CHECK) {
  if (changed || stale.length) {
    console.error(`\n  STALE: ${changed} file(s) differ, ${stale.length} orphan(s).`);
    console.error('  Run: node tools/build-seo.mjs');
    process.exit(1);
  }
  console.log('\n  up to date');
} else {
  console.log(`  ${changed} written, ${stale.length} stale removed`);
}
