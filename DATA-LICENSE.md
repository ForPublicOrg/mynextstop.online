# Data licence

**The MIT licence in [LICENSE](LICENSE) covers the software only: the HTML,
CSS and JavaScript. It does not cover the destination catalogue.**

| What | Where | Licence |
| --- | --- | --- |
| Software | `index.html`, `css/`, `js/` | MIT: see [LICENSE](LICENSE) |
| Destination & holiday catalogue | `data/destinations.json`, `data/holidays.json` | CC BY 4.0: see below |
| India boundary line | `data/india-border.geojson` | from [udit-001/india-maps-data](https://github.com/udit-001/india-maps-data). See below |

## The destination catalogue

`data/destinations.json` (curated Indian destinations with coordinates, season
windows, solo-traveller notes) and `data/holidays.json` (Indian holiday dates)
are original curated datasets published under the
[Creative Commons Attribution 4.0 International licence][ccby]:
use it, change it, redistribute it, including commercially, as long as you
credit **mynextstop.online**.

Suggested attribution:

> Destination data from [mynextstop.online](https://mynextstop.online)
> (CC BY 4.0)

**Full CC BY 4.0 text:** https://creativecommons.org/licenses/by/4.0/

## The India boundary overlay

Raster map tiles bake the international depiction of India's disputed borders
into the image. To present the **Survey of India / official depiction**, the
app draws India's national boundary on top of the tiles from
`data/india-border.geojson`: geometry derived from the official-boundary
dataset [udit-001/india-maps-data](https://github.com/udit-001/india-maps-data)
(exterior mesh of the states layer, simplified), the same corrective approach
used by [humanconnect.online](https://github.com/ForPublicOrg/humanconnect.online).
That upstream dataset's own terms apply to the boundary geometry.

## The city list

`js/cities.js` is the "type where I am" fallback: a plain list of Indian city
names with a city-centre coordinate each. The coordinates come from
[Wikidata](https://www.wikidata.org/) (CC0) and from
[OpenStreetMap](https://www.openstreetmap.org/copyright) place nodes via
[Photon](https://photon.komoot.io/), and each was reverse-geocoded to confirm
it lands in the right town. Credit for those coordinates belongs upstream:
© OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).

## What the repository does not contain

The base map is rendered at runtime from [Esri](https://www.esri.com/) ArcGIS
Online tiles built on Esri, HERE, Garmin and
[OpenStreetMap](https://www.openstreetmap.org/copyright) data. No map tiles or
OSM-derived map geometry are distributed in this repository; tile usage is
governed by Esri's and OSM's own terms, and the app shows their attribution on
the map.

## A note on accuracy

Season windows, "avoid" months and travel notes are honest editorial
judgements, not guarantees. Mountain roads close, festivals move, ferries get
cancelled. Corrections are very welcome: the whole catalogue is one readable
JSON file; open a pull request.

The parts that *can* be checked mechanically are:
`node tools/verify-destinations.mjs` validates every record against the schema
and the season logic, then asks OpenStreetMap whether each coordinate really
sits in the state it claims and how far it is from the named place, and asks
the Copernicus DEM (via Open-Meteo) whether `alt` is the actual ground height
there. Run it before opening a data PR.

[ccby]: https://creativecommons.org/licenses/by/4.0/
