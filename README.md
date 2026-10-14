# Copenhagen Travel Time Map

A door-to-door travel-time map of central Copenhagen, adapted from Anthony Castrio's
[NYC Commute POV](https://github.com/AntCas/nyc-cartogram). It produces:

- a full-screen interactive web app (desktop): drop a start pin and see a heatmap of how long it takes
  to get everywhere else on foot, by bike, and by transit, measure the time to any spot, switch modes
  on and off, and share links to a view
- a static SVG cartogram (the original warp idea) that expands places with good rail access

## Coverage

Travel times are computed on a 50 m grid over the 17 municipalities of Byen København and Københavns
omegn (København, Frederiksberg, Tårnby, Dragør, Gentofte, Gladsaxe, Lyngby-Taarbæk, Herlev, Ballerup,
Rødovre, Hvidovre, Glostrup, Brøndby, Albertslund, Vallensbæk, Ishøj, Høje-Taastrup). The app opens framed
on central Copenhagen out to Rødovre (`INITIAL_VIEW_BBOX` in `build_commute_site_data.py`); pan and zoom
to see the rest.

Modes (each can be switched on/off in the options box):

| Mode | Lines | Default |
| --- | --- | --- |
| Bike | the OSM cycling network; the bike comes along on trains, Metro, Letbane, and harbour buses (not on Movia buses) | off |
| Metro | M1, M2, M3, M4 | on |
| S-tog | A, B, Bx, C, E, F, H | on |
| Letbane | Ring 3 light rail (L) | on |
| Regional trains | DSB (IC, ICL, RE, …), Øresundståg, Lokaltog (Nærumbanen), Snälltåget | on |
| Harbour bus | Movia 991/992/993 | on |
| Bus | Movia buses and S-buses with daytime service (~96 routes, ~2,000 stops); night buses and rail-replacement buses are left out | on |

Walking is always available. Bus times are scheduled times, so rush-hour traffic isn't reflected.

## Quick Start (fresh clone)

```bash
python3 setup_data.py      # downloads GTFS + OSM street network, builds site/data (~10–20 min)
python3 serve.py 8080      # then open http://localhost:8080/
```

The large inputs (the GTFS feed and the OSM street network) and the generated site data are not in git;
`setup_data.py` recreates them and can simply be re-run if a download fails. `CLAUDE.md` has detailed
setup, verification, and troubleshooting notes (written so a Claude agent can do the setup).

## Requirements

- Python 3.10+ (standard library only)
- Internet access for the first setup (Rejseplanen GTFS feed and the OpenStreetMap Overpass API)
- `pnpm` and Node.js only if you want to run or deploy the Cloudflare Worker

## Build (step by step)

`setup_data.py` runs these for you:

```bash
# 1. OpenStreetMap layers via Overpass: municipalities, parks, water, major streets, and the full
#    walk/bike street network (~73 MB, fetched in tiles). Cached in data/; add --force to refresh.
python3 fetch_cph_basemap.py

# 2. Site data -> site/data/commute_map_data.json + site/data/street_graph.bin
python3 build_commute_site_data.py

# 3. (optional) Static SVG -> output/cph_transit_weighted_projection.svg
python3 generate_cph_transit_weighted_projection.py
```

`cph_transit.py` filters the national GTFS feed down to the Copenhagen rail, bus, and harbour-bus network and
caches it in `data/cph_transit_network.json`; the cache is rebuilt automatically when `GTFS/` changes.
`cph_streets.py` turns the raw OSM extract into the routable street graph.

## Run Locally

```bash
python3 serve.py 8080     # or: pnpm run serve (port 8000)
```

This serves `site/` on all interfaces (reachable over Tailscale at `http://<machine-name>:8080/`) and
handles pretty share links like `/@55.67594,12.56553`. Address search uses OpenStreetMap Nominatim at
runtime, so that feature needs internet access.

Using the map (shown in the hint bar at the bottom of the app):

- the first click sets the **start pin**; after that it only moves when you drag it (or search an address)
- any other click drops the **measure pin** there (or jumps it), showing the travel time to that spot;
  drag it to explore, click it or press Esc to remove it
- drag the map to pan; scroll to zoom
- modes, the colour scale's maximum time (10–120 min), and the heatmap/outline layers are in the
  top-right box
- the route (on by default; **Hide route** next to Reset options turns it off) draws the fastest path
  from the start pin to the measure pin: walking dashed, cycling in green, and each transit ride along
  that line's GTFS shape in its colour, with a step-by-step itinerary in the top-left panel;
  **Trip details** there expands it to time per activity and every stop with its elapsed time

## Cloudflare Worker (optional)

`wrangler.jsonc` and `src/worker.js` serve `site/` from the root of a Worker, with `/@lat,lon` routes
falling back to the app shell. Add a route to `wrangler.jsonc` to deploy on your own domain.

```bash
pnpm install
pnpm run dev
pnpm run deploy
```

## How Travel Times Are Computed

All routing happens in the browser (about 70 ms per origin) as a single Dijkstra search over two kinds of
node:

1. **Street nodes**: every walkable/bikeable OSM way in the area, split at junctions and resampled so no
   edge is longer than 20 m (about 800k nodes). Each edge records whether you may walk it and whether
   you may cycle it in each direction (one-way streets apply to bikes unless `oneway:bicycle=no`).
   Footways, pedestrian streets, and steps are walk-only; `bicycle=use_sidepath` roads defer to the
   separately mapped cycle tracks.
2. **Transit states**: one per (station, service), connected by median scheduled arrival-to-arrival times
   between consecutive stations on a representative weekday, so time standing at stations a train passes
   through is included. A service is one direction and stopping pattern of a line (short workings fold
   into the longer pattern they are part of), so you can only stay on board where a real train
   continues: DSB's airport trains via Glostrup and København Syd are a different service from its
   trains via Valby. Each state also records the service's median dwell there, so a ride you board is
   timed from its departure; rides match the timetable's departure-to-arrival times.

Moves between them:

- **Street legs** are walked at 4.8 km/h or, with Bike on, ridden at 16 km/h (the usual journey-planner
  assumptions, as used by Google Maps). On walk-only edges you push the bike at walking speed.
- **Boarding** from a station's street node costs the walk/ride to the platform, a per-mode platform access
  time (Metro/regional 2 min, S-tog 1.5, Letbane/harbour bus 0.5, bus 0.3; +0.5–1 min with a bike), and the
  expected wait for a departure: half the 07:00–19:00 headway of the line's trains to the next station,
  1.5–30 min. Staying on past a station where fewer of those trains continue adds the difference there
  (e.g. ~26 min at Glostrup for the hourly airport train). **Alighting** costs the same minus the wait.
- **Transfers** inside a station use the minimum platform-to-platform times from GTFS `transfers.txt`
  (line-specific where given, e.g. 60 s cross-platform S-tog changes at København H), plus the wait
  for the next service. You can't get round these by stepping out to the street and straight back in:
  after leaving a train, the search won't board anything at that same station again. Transfers between
  nearby stations (e.g. to a bus stop outside) simply happen on the street network.
- The **itinerary** splits a route into walk/bike legs (including getting to and from platforms), waits,
  changes, and rides; ride rows are in-vehicle time only.
- **Grid cells** (50 m) take the time of their nearest street node plus the walk from it. Only nodes in
  the main walkable network are used for snapping, so every point is reachable on foot.
- **Water** (OSM lakes, ponds, canals, and harbour basins, e.g. Søerne) is cut out of the grid and the
  heatmap, so you can only cross it where the street network has a bridge.

With Bike on, the bike comes along on every transit leg. In reality bikes are not allowed on the Metro on
weekdays 07–09 and 15:30–17:30, and need a ticket on regional trains.

Some UI/share icons are from [Iconmonstr](https://iconmonstr.com/).

## Project Layout

- [fetch_cph_basemap.py](fetch_cph_basemap.py): downloads the OSM layers
- [cph_transit.py](cph_transit.py): stations, line shapes, ride times, waits, and transfer times from GTFS
- [cph_streets.py](cph_streets.py): walk/bike classification and the 20 m street graph
- [build_commute_site_data.py](build_commute_site_data.py): builds the site data bundle
- [generate_cph_transit_weighted_projection.py](generate_cph_transit_weighted_projection.py): builds the static SVG
- [serve.py](serve.py): local static server with share-link support
- [site/index.html](site/index.html), [site/app.js](site/app.js), [site/styles.css](site/styles.css): the app
- [src/worker.js](src/worker.js): Cloudflare Worker entrypoint
