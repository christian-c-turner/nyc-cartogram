#!/usr/bin/env python3
"""Download the Copenhagen basemap layers from OpenStreetMap (Overpass API).

Writes, under data/:
  cph_municipalities.geojson  the 17 municipalities that make up the mapped area
  cph_external_land.geojson   neighbouring municipalities (context land outside the map area)
  cph_parks.geojson           parks, forests, and other large green space
  osm_major_streets.json      motorway / trunk / primary roads (raw Overpass JSON)
  cph_street_network.json     every walkable/bikeable way in the area (raw Overpass JSON)
  cph_water.geojson           lakes, ponds, and canals inside the land area (e.g. Søerne)

Existing files are kept; pass --force to re-download.
"""

from __future__ import annotations

import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"

MUNICIPALITIES_PATH = DATA_DIR / "cph_municipalities.geojson"
EXTERNAL_LAND_PATH = DATA_DIR / "cph_external_land.geojson"
PARKS_PATH = DATA_DIR / "cph_parks.geojson"
STREETS_PATH = DATA_DIR / "osm_major_streets.json"
STREET_NETWORK_PATH = DATA_DIR / "cph_street_network.json"
WATER_PATH = DATA_DIR / "cph_water.geojson"

OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)
USER_AGENT = "cph-cartogram-build/1.0"

# Byen København + Københavns omegn (Statistics Denmark's "landsdele").
MAP_MUNICIPALITIES = (
    "Københavns Kommune",
    "Frederiksberg Kommune",
    "Tårnby Kommune",
    "Dragør Kommune",
    "Gentofte Kommune",
    "Gladsaxe Kommune",
    "Lyngby-Taarbæk Kommune",
    "Herlev Kommune",
    "Ballerup Kommune",
    "Rødovre Kommune",
    "Hvidovre Kommune",
    "Glostrup Kommune",
    "Brøndby Kommune",
    "Albertslund Kommune",
    "Vallensbæk Kommune",
    "Ishøj Kommune",
    "Høje-Taastrup Kommune",
)

# south, west, north, east
BOUNDARY_BBOX = (55.45, 11.95, 55.95, 12.75)
DETAIL_BBOX = (55.54, 12.12, 55.84, 12.72)
# All 17 mapped municipalities plus a margin, so routes that briefly leave the area still exist.
# Fetched as a grid of tiles; one request for the whole area tends to time out.
STREET_NETWORK_BBOX = (55.550, 12.160, 55.830, 12.720)
STREET_NETWORK_TILES = (3, 4)  # rows, cols
# Drop Saltholm/Peberholm and the harbour forts: islands east of this longitude
# are uninhabited and only stretch the map bounds.
MAX_POLYGON_LON = 12.70
MIN_MUNICIPALITY_POLYGON_M2 = 40_000.0

Point = Tuple[float, float]
Ring = List[Point]


def overpass(query: str) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(5):
        for endpoint in OVERPASS_ENDPOINTS:
            request = urllib.request.Request(endpoint, data=body, headers={"User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(request, timeout=300) as response:
                    payload = response.read()
                if not payload.lstrip().startswith(b"{"):
                    raise RuntimeError(f"non-JSON response from {endpoint}")
                return json.loads(payload)
            except Exception as error:  # noqa: BLE001 - retry on any network/server failure
                last_error = error
                print(f"  {endpoint} failed: {error}", file=sys.stderr)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Overpass query failed: {last_error}")


def bbox_clause(bbox: Tuple[float, float, float, float]) -> str:
    return "({},{},{},{})".format(*bbox)


def ring_area_m2(ring: Sequence[Point]) -> float:
    lat0 = sum(lat for _, lat in ring) / max(len(ring), 1)
    kx = 111_320.0 * math.cos(math.radians(lat0))
    ky = 111_320.0
    area = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        area += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
    return abs(area) / 2.0


def point_in_ring(point: Point, ring: Sequence[Point]) -> bool:
    x, y = point
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y):
            x_hit = (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
            if x < x_hit:
                inside = not inside
        j = i
    return inside


def assemble_rings(ways: List[List[Point]]) -> List[Ring]:
    """Join way geometries end-to-end into closed rings."""
    pending = [list(way) for way in ways if len(way) >= 2]
    rings: List[Ring] = []
    while pending:
        ring = pending.pop(0)
        while ring[0] != ring[-1]:
            for index, way in enumerate(pending):
                if way[0] == ring[-1]:
                    ring.extend(way[1:])
                elif way[-1] == ring[-1]:
                    ring.extend(reversed(way[:-1]))
                elif way[-1] == ring[0]:
                    ring[:0] = way[:-1]
                elif way[0] == ring[0]:
                    ring[:0] = list(reversed(way[1:]))
                else:
                    continue
                pending.pop(index)
                break
            else:
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def way_points(member: dict) -> List[Point]:
    return [(node["lon"], node["lat"]) for node in member.get("geometry") or [] if node]


def relation_to_polygons(element: dict) -> List[List[Ring]]:
    outers = assemble_rings(
        [way_points(m) for m in element.get("members", []) if m.get("type") == "way" and m.get("role") in ("outer", "")]
    )
    inners = assemble_rings(
        [way_points(m) for m in element.get("members", []) if m.get("type") == "way" and m.get("role") == "inner"]
    )
    polygons: List[List[Ring]] = [[outer] for outer in outers]
    for inner in inners:
        for polygon in polygons:
            if point_in_ring(inner[0], polygon[0]):
                polygon.append(inner)
                break
    return polygons


def element_to_polygons(element: dict) -> List[List[Ring]]:
    if element["type"] == "way":
        ring = [(node["lon"], node["lat"]) for node in element.get("geometry") or []]
        if len(ring) >= 4 and ring[0] == ring[-1]:
            return [[ring]]
        return []
    if element["type"] == "relation":
        return relation_to_polygons(element)
    return []


def feature(properties: dict, polygons: List[List[Ring]]) -> dict:
    return {
        "type": "Feature",
        "properties": properties,
        "geometry": {
            "type": "MultiPolygon",
            "coordinates": [[[[round(lon, 6), round(lat, 6)] for lon, lat in ring] for ring in polygon] for polygon in polygons],
        },
    }


def write_geojson(path: Path, features: List[dict]) -> None:
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
    print(f"Wrote {path} ({len(features)} features)")


def fetch_municipalities(force: bool) -> None:
    if MUNICIPALITIES_PATH.exists() and EXTERNAL_LAND_PATH.exists() and not force:
        return
    print("Fetching municipality boundaries…")
    payload = overpass(
        f'[out:json][timeout:240];relation["boundary"="administrative"]["admin_level"="7"]{bbox_clause(BOUNDARY_BBOX)};out geom;'
    )
    inside, outside = [], []
    for element in payload["elements"]:
        name = element.get("tags", {}).get("name", "")
        polygons = element_to_polygons(element)
        if name in MAP_MUNICIPALITIES:
            polygons = [
                polygon
                for polygon in polygons
                if ring_area_m2(polygon[0]) >= MIN_MUNICIPALITY_POLYGON_M2
                and min(lon for lon, _ in polygon[0]) < MAX_POLYGON_LON
            ]
            label = name.replace(" Kommune", "").replace("Københavns", "København")
            inside.append(feature({"name": label, "osm_name": name}, polygons))
        elif polygons:
            outside.append(feature({"name": name}, polygons))
    missing = set(MAP_MUNICIPALITIES) - {f["properties"]["osm_name"] for f in inside}
    if missing:
        raise RuntimeError(f"Missing municipalities in Overpass response: {sorted(missing)}")
    write_geojson(MUNICIPALITIES_PATH, inside)
    write_geojson(EXTERNAL_LAND_PATH, outside)


def fetch_parks(force: bool) -> None:
    if PARKS_PATH.exists() and not force:
        return
    print("Fetching parks and green space…")
    bbox = bbox_clause(DETAIL_BBOX)
    selectors = [
        '["leisure"="park"]',
        '["leisure"="nature_reserve"]',
        '["leisure"="golf_course"]',
        '["landuse"="forest"]',
        '["landuse"="recreation_ground"]',
        '["landuse"="cemetery"]',
        '["natural"="wood"]',
    ]
    parts = "".join(f"way{s}{bbox};relation{s}{bbox};" for s in selectors)
    payload = overpass(f"[out:json][timeout:240];({parts});out geom;")
    features = []
    for element in payload["elements"]:
        polygons = element_to_polygons(element)
        if not polygons:
            continue
        area = sum(ring_area_m2(polygon[0]) for polygon in polygons)
        tags = element.get("tags", {})
        features.append(feature({"name": tags.get("name", ""), "shape_area": round(area, 1)}, polygons))
    write_geojson(PARKS_PATH, features)


def fetch_streets(force: bool) -> None:
    if STREETS_PATH.exists() and not force:
        return
    print("Fetching major streets…")
    payload = overpass(
        f'[out:json][timeout:240];way["highway"~"^(motorway|trunk|primary)$"]{bbox_clause(DETAIL_BBOX)};out geom;'
    )
    STREETS_PATH.write_text(json.dumps(payload), encoding="utf-8")
    print(f"Wrote {STREETS_PATH} ({len(payload.get('elements', []))} ways)")


def fetch_water(force: bool) -> None:
    if WATER_PATH.exists() and not force:
        return
    print("Fetching lakes and inland water…")
    bbox = bbox_clause(DETAIL_BBOX)
    parts = "".join(
        f"way{s}{bbox};relation{s}{bbox};"
        for s in ('["natural"="water"]', '["landuse"="reservoir"]', '["landuse"="basin"]', '["waterway"="riverbank"]')
    )
    payload = overpass(f"[out:json][timeout:180];({parts});out geom;")
    features = []
    for element in payload["elements"]:
        polygons = element_to_polygons(element)
        if not polygons:
            continue
        tags = element.get("tags", {})
        area = sum(ring_area_m2(polygon[0]) for polygon in polygons)
        features.append(feature({"name": tags.get("name", ""), "water": tags.get("water", ""), "shape_area": round(area, 1)}, polygons))
    write_geojson(WATER_PATH, features)


def fetch_street_network(force: bool) -> None:
    if STREET_NETWORK_PATH.exists() and not force:
        return
    print("Fetching full street and path network (large; can take several minutes)…")
    excluded = "proposed|construction|abandoned|disused|platform|raceway|bus_guideway|elevator|rest_area|services"
    south, west, north, east = STREET_NETWORK_BBOX
    rows, cols = STREET_NETWORK_TILES
    elements: Dict[Tuple[str, int], dict] = {}
    for row in range(rows):
        for col in range(cols):
            tile = (
                south + (north - south) * row / rows,
                west + (east - west) * col / cols,
                south + (north - south) * (row + 1) / rows,
                west + (east - west) * (col + 1) / cols,
            )
            print(f"  tile {row * cols + col + 1}/{rows * cols}")
            payload = overpass(
                "[out:json][timeout:180];"
                f'way["highway"]["highway"!~"^({excluded})$"]["area"!="yes"]{bbox_clause(tile)};'
                "(._;>;);out body qt;"
            )
            for element in payload["elements"]:
                elements[(element["type"], element["id"])] = element
    merged = {"elements": list(elements.values())}
    STREET_NETWORK_PATH.write_text(json.dumps(merged, separators=(",", ":")), encoding="utf-8")
    ways = sum(1 for element in merged["elements"] if element["type"] == "way")
    print(f"Wrote {STREET_NETWORK_PATH} ({ways} ways)")


def main() -> None:
    force = "--force" in sys.argv
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fetch_municipalities(force)
    fetch_parks(force)
    fetch_streets(force)
    fetch_water(force)
    fetch_street_network(force)


if __name__ == "__main__":
    main()
