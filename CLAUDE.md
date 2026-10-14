# Copenhagen travel-time map: notes for Claude

A static web app (`site/`) that shows door-to-door travel times across greater Copenhagen on foot, by
bike, and by transit, routed in the browser over an OpenStreetMap street graph plus a GTFS transit graph.
Python build scripts (standard library only, Python 3.10+) turn raw data into the files the app loads.
See README.md for the user-facing description and the routing model.

## Setting up a fresh clone

The large inputs and all generated files are git-ignored, so a fresh clone does not run until you
recreate them. Do this:

```bash
python3 setup_data.py
```

It is idempotent: each step skips work whose output already exists, so just re-run it after a failure.
What it does:

1. **GTFS feed → `GTFS/`** (~55 MB download, ~350 MB unzipped). Downloads Rejseplanen's national feed
   from `https://www.rejseplanen.info/labs/GTFS.zip` and unzips the `.txt` files flat into `GTFS/`.
2. **OpenStreetMap → `data/`** via the Overpass API (`fetch_cph_basemap.py`). The small layers
   (municipalities, external land, parks, water, major streets) are committed; only
   `data/cph_street_network.json` (~73 MB) has to be fetched, in 12 tiles, which usually takes 5–15
   minutes.
3. **Build → `site/data/`** (`build_commute_site_data.py`, ~10 s): `commute_map_data.json` (~3 MB) and
   `street_graph.bin` (~23 MB). The first build also extracts and caches the transit network from
   GTFS in `data/cph_transit_network.json` (a few seconds).

Then serve and check it:

```bash
python3 serve.py 8080      # all interfaces; handles /@lat,lon share links
```

### Verifying the setup

- The build ends with lines like `805080 nodes, 1766865 directed edges` and
  `grid 676x576 (50 m), 196639 land cells`. Node and edge counts drift a little as OSM changes.
- `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/data/street_graph.bin` returns `200`.
- If Chrome is installed, a headless screenshot of a pinned view should show a coloured heatmap
  around central Copenhagen and the route itinerary in the top-left panel:
  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
    --window-size=1440,900 --virtual-time-budget=20000 --screenshot=/tmp/check.png \
    "http://localhost:8080/@55.68330,12.57170?distance=55.63040,12.64940&route=1"
  ```
  Expect roughly "Fastest route · 21 min" via M2 from Nørreport to the airport.

### Troubleshooting

- **Overpass errors (HTTP 429/500/504, "server is probably too busy")** are common. `overpass()` in
  `fetch_cph_basemap.py` already cycles through three public endpoints with back-off. If it still
  fails, wait a few minutes and re-run `python3 setup_data.py`; tiles are fetched again from scratch,
  but other finished files are kept. Keep the `[timeout:180]` query header; bigger declared
  timeouts or `maxsize` make busy servers reject the query outright.
- **The GTFS URL moved or 404s:** find the current link on Rejseplanen Labs (rejseplanen.info/labs),
  update `GTFS_URL` in `setup_data.py`, and run `python3 setup_data.py --refresh-gtfs`. Any GTFS feed
  covering Copenhagen with Rejseplanen's route types should work. `cph_transit.py` relies on:
  - `route_type` 1 = Metro, 109 = S-tog, 0 = light rail, 2 = regional rail, 4 = ferry, and 3/700 = bus
    (only agency "Movia", see `BUS_AGENCIES`);
  - the agency names in `REGIONAL_ROUTE_NAMES` for merging regional operators;
  - stop names like "Nørreport St." / "Nørreport St. (Metro)" for merging rail platforms into stations
    (bus stops keep their own names and only merge with a same-named stop across the street).
- **Few or no trips** (empty heatmap, "0 / 0 stations"): the feed's calendar may not overlap. The
  service date is picked automatically as the busiest weekday in the feed; check the
  `service date …` line printed while extracting the transit network.
- **Stale transit data after changing code in `cph_transit.py`:** bump `CACHE_VERSION` there or delete
  `data/cph_transit_network.json`.

## Updating data later

- New timetables: `python3 setup_data.py --refresh-gtfs` (the transit cache rebuilds automatically).
- New OSM data: `python3 setup_data.py --refresh-osm` (re-fetches every layer, about 15 minutes).

## Project map

- `setup_data.py`: fresh-clone setup (download + fetch + build)
- `fetch_cph_basemap.py`: Overpass downloads into `data/`
- `cph_transit.py`: GTFS → stations, lines, ride times, waits, and transfer times (cached)
- `cph_streets.py`: OSM ways → walk/bike street graph resampled to ≤20 m edges
- `build_commute_site_data.py`: assembles `site/data/` (grid, land/water mask, station links, binary graph)
- `generate_cph_transit_weighted_projection.py`: optional static SVG cartogram
- `serve.py`: local server; `src/worker.js` + `wrangler.jsonc`: optional Cloudflare Worker
- `site/app.js`: the whole front end (routing, heatmap, route drawing, UI); no build step

## Conventions

- Python scripts use only the standard library; don't add dependencies.
- Never commit `GTFS/`, `site/data/`, `data/cph_street_network.json`, or
  `data/cph_transit_network.json`; they're in `.gitignore` because they're large or regenerated.
  GitHub rejects files over 100 MB.
- The app targets desktop browsers. Routing runs client-side (~70 ms per origin), so keep
  `site/data/` changes in mind for load size.
