# Data licence

**The MIT licence in [LICENSE](LICENSE) covers the software only — the HTML,
CSS and JavaScript. It does not cover the destination catalogue.**

| What | Where | Licence |
| --- | --- | --- |
| Software | `index.html`, `css/`, `js/` | MIT — see [LICENSE](LICENSE) |
| Destination & holiday catalogue | `data/` | CC BY 4.0 — see below |

## The destination catalogue

`data/destinations.json` (curated Indian destinations with coordinates, season
windows, solo-traveller notes) and `data/holidays.json` (Indian holiday dates)
are original curated datasets published under the
[Creative Commons Attribution 4.0 International licence][ccby]:
use it, change it, redistribute it — including commercially — as long as you
credit **mynextstop.online**.

Suggested attribution:

> Destination data from [mynextstop.online](https://mynextstop.online)
> (CC BY 4.0)

**Full CC BY 4.0 text:** https://creativecommons.org/licenses/by/4.0/

## What the repository does not contain

The base map is rendered at runtime from [CARTO](https://carto.com/) tiles
built on [OpenStreetMap](https://www.openstreetmap.org/copyright) data. No map
tiles or OSM-derived geometry are distributed in this repository; tile usage is
governed by CARTO's and OSM's own terms, and the app shows their attribution
on the map.

## A note on accuracy

Season windows, "avoid" months and travel notes are honest editorial
judgements, not guarantees. Mountain roads close, festivals move, ferries get
cancelled. Corrections are very welcome — the whole catalogue is one readable
JSON file; open a pull request.

[ccby]: https://creativecommons.org/licenses/by/4.0/
