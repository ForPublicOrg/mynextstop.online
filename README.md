# 🧭 my next stop: [mynextstop.online](https://mynextstop.online)

**Where should you travel next in India, from right here, right now.**

Every travel site makes you *search*. This one gives you an **answer**. Open it anywhere in
India and it takes your location and today's date, and tells you the best next place to go,
with an honest reason why now (or why not now). Built for solo travellers. No login, no
backend, no planning spiral.

## How it works

1. **📍 One tap**: browser GPS (or type your city; your location never leaves the page).
2. **The engine ranks 589 curated Indian destinations**, every state and union
   territory covered, by:
   - **Season honesty**: every place has peak / shoulder / avoid months. Places in
     `avoidMonths` (landslide season, 45 °C plains, closed parks, rough seas) are *never*
     suggested. No "Top 10 places to visit in July" listicle lies.
   - **Distance**: pick your range: quick hop ≤150 km, weekend ≤450 km, long weekend
     ≤900 km, or anywhere. Road distance & time are estimated from crow-flies with
     hill-terrain correction.
   - **Solo-friendliness**: hostels, safety, transport, how easy it is to meet people.
   - **Festivals**: a signature festival this month boosts the pick.
3. **The map is the UI**: you land on a full-screen season map: every destination is a
   live dot (green = in season, amber = shoulder, grey = off, red = avoid now), you're a
   blue dot, and the top pick is highlighted with a **route arc drawn from where you
   stand**: distance and travel time on the line. Dashed arcs show the pick's own top
   next hops, so you can see the chain before you commit. The answer rides in a bottom
   sheet: drag up for details and alternates, "Show me another →" re-draws the route.
4. **Works mid-trip**: open it *from* Manali and it finds your next hop; tap any dot
   to inspect it or make it your new starting point.

### Other features

- ✈️ **Transport modes**: every destination is tagged with how you practically reach
  it (flight / train / road), so road-only valleys like Spiti stand out before you commit.
- 🗓️ **Long-weekend radar**: knows upcoming Indian holidays, spots ≥3-day windows, and
  tags picks that fit them.
- 🗺️ **Season map**: every destination as a dot: green = in season now, amber = shoulder,
  grey = off, red = avoid. Slide the month to time-travel.
- 📅 **Month time-travel**: planning for October? Re-rank everything for any month.
- ✓ **Been there**: marked places are never suggested again. ♡ Save keeps a shortlist.
- 📤 Share your pick, 🧭 one-tap Google Maps directions, dark/light theme.

## Stack

Zero-framework static frontend: the same pattern as
[humanconnect.online](https://humanconnect.online) / roadtrackerindia:

- `index.html` + `css/style.css` + vanilla ES modules in `js/`
- `js/engine.js`: pure ranking logic (season scoring, haversine, road estimates,
  long-weekend detection). No DOM, unit-testable.
- `data/destinations.json`: 589 curated destinations across all 36 states and union
  territories: coordinates, peak/shoulder/avoid months, four season-specific "why now"
  lines, solo score, budget, transport hub, altitude, signature festival. Beauty first:
  hill stations, valleys, waterfalls, beaches, gorges and one-bus-a-day villages. A
  city earns an entry only when the trip IS its heritage (Jaipur, Varanasi, Amritsar);
  plain metros are deliberately absent.
- `js/cities.js`: 238 cities for the "type where I am" search: every state capital,
  every city over ~200k, and the regional hubs people set out from. Renamed cities keep
  the old name in brackets so "Bangalore" and "Vizag" still find them.
- `data/holidays.json`: verified Indian holidays through 2027 for the long-weekend radar.
- `js/icons.js`: the mynextstop icon set: one hand-kept line-icon system (UI glyphs +
  16 category glyphs + transport modes), all `currentColor` SVG. No emoji, no icon fonts.
- Leaflet + CARTO basemap tiles (theme-aware light/dark), with India's official boundary
  drawn as a corrective overlay (see DATA-LICENSE.md).
- `tools/build-seo.mjs`: generates the readable half of the site, 657 static pages
  (589 destination guides, 36 state guides, 12 month guides, 16 theme guides, four
  browse indexes) plus the sitemaps, straight out of `data/destinations.json`. Output
  is committed, so deploy is still "upload the folder". See **Search & indexing**.
- `css/pages.css` + `js/page.js`: the guide pages' thin layer on top of the app's
  design tokens. The app's CSS is untouched by them.
- No cookies, no accounts. Geolocation is used in-page only.

## Deploy

Static: deploys as-is on Vercel (`vercel.json` carries CSP/security headers,
`cleanUrls`). Point the `mynextstop.online` domain at the Vercel project.

```bash
npx vercel --prod
```

## Search & indexing

The app is one URL with a map in it, and a map is not something Google can rank. So
every fact the catalogue already holds is also written out as a plain page a crawler
can read:

| URL | What it is | Count |
| --- | --- | --- |
| `/places/<id>` | One destination: season strip, the four season-specific "why now" lines, vibe, how to get there, trip facts, nearby places | 589 |
| `/india/<state>` | Best places in a state, with the months it is actually strong | 36 |
| `/best-time-to-visit/<month>` | Best places in India that month, **and where not to go** | 12 |
| `/themes/<category>` | Best beaches / treks / heritage / offbeat, and so on | 16 |
| `/places` `/india` `/best-time-to-visit` `/themes` | Browse indexes | 4 |

Nothing on those pages is invented: every sentence is a field from
`data/destinations.json`, and every number is computed from it. The month pages show
each place's own season line for that month, so December and July are genuinely
different pages, not one template with the month swapped.

Each page carries a unique title and description, a canonical, `BreadcrumbList` and
either `TouristAttraction` (with real coordinates) or `ItemList`, plus a `FAQPage`
whose answers are visible on the page. Every destination links to its state, its
themes, its peak months and its eight nearest neighbours, so the catalogue is one
connected graph rather than 589 orphans, and `/` links into it so the front door is
not a dead end. A guide page's call to action opens `/?to=<id>`, which drops you on
the live map with that place selected.

Rebuild after any edit to the catalogue, and commit the diff:

```bash
node tools/build-seo.mjs
```

`--check` exits 1 if the committed pages no longer match the data (CI can gate on
it); `--clean` starts from scratch. Stale pages from a renamed or dropped
destination are swept automatically, because a stale page is a 200 that Google
will happily keep in its index.

## Data

Season windows follow: winter = Dec–Feb, summer = Mar–May, monsoon = Jun–Sep,
autumn = Oct–Nov. The `festival` field must contain a month name (e.g.
`"Nov: Pushkar camel fair"`, `"Feb/Mar: Losar"`), the app parses the first
month it finds to time festival badges and score boosts. `category` values
must come from the 16 keys in [js/themes.js](js/themes.js). Corrections
welcome: the whole dataset is one readable JSON file.

`avoidMonths` is a hard switch: the engine will **never** suggest a place in
those months. It is for real blockers, a closed park gate, a snowed-in pass,
cancelled ferries, 45 °C. Not for "it's a bit less nice then".

Everything that can be checked by machine, is:

```bash
node tools/verify-destinations.mjs   # is the data telling the truth?
node tools/build-seo.mjs --check     # are the generated pages in sync with it?
```

It validates the schema and the season logic, then asks OpenStreetMap whether
each coordinate really sits in the state it claims and how far it is from the
named place, and asks the Copernicus DEM (via Open-Meteo) whether `alt` is the
real ground height there. `--offline` skips the network checks. Run it before
opening a data PR: it is how the catalogue caught its own coordinates that had
drifted into Bangladesh and Nepal.

## Contributing

This is an open-source project by [ForPublicOrg](https://github.com/ForPublicOrg),
the same family as [humanconnect.online](https://github.com/ForPublicOrg/humanconnect.online)
and [roadtrackerindia](https://github.com/ForPublicOrg/roadtrackerindia). The most
valuable contribution is **data honesty**: if you know a place's real season
window, its actual solo scene, or a coordinate that's off, open a PR against
`data/destinations.json`: every entry is plain JSON with a comment-friendly diff.
Code PRs welcome too; there is no build step, so if you can open `index.html`,
you can hack on it.

## Licence

- **Code** (HTML/CSS/JS): [MIT](LICENSE) © 2026 Vikas
- **Destination & holiday data** (`data/`): [CC BY 4.0](DATA-LICENSE.md), 
  use it anywhere, credit mynextstop.online
- Base map tiles at runtime: © [CARTO](https://carto.com/) ·
  © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
