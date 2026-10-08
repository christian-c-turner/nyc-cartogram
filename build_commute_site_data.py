#!/usr/bin/env python3
"""Build the data bundle for the interactive Copenhagen commute-time website.

Outputs, under site/data/:
  commute_map_data.json  basemap layers, stations, transit graph, and metadata
  street_graph.bin       the walk/bike street graph (≤20 m edges) and the heatmap grid, as
                         typed arrays; byte offsets are listed in meta.binary
"""

from __future__ import annotations

import json
import math
import struct
from array import array
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import cph_streets
import cph_transit

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
SITE_DATA_DIR = ROOT / "site" / "data"
SITE_DATA_PATH = SITE_DATA_DIR / "commute_map_data.json"
SITE_GRAPH_PATH = SITE_DATA_DIR / "street_graph.bin"

MUNICIPALITIES_PATH = DATA_DIR / "cph_municipalities.geojson"
EXTERNAL_LAND_PATH = DATA_DIR / "cph_external_land.geojson"
PARKS_PATH = DATA_DIR / "cph_parks.geojson"
STREETS_PATH = DATA_DIR / "osm_major_streets.json"
WATER_PATH = DATA_DIR / "cph_water.geojson"

# The app opens framed on central Copenhagen out to Rødovre (west), Hellerup (north), Ørestad
# (south), and Kastrup (east). The modelled area is all 17 municipalities.
# west, south, east, north
INITIAL_VIEW_BBOX = (12.430, 55.625, 12.680, 55.735)
CELL_METERS = 50.0
MIN_PARK_AREA = 8_000.0
MIN_DRAWN_WATER_AREA = 2_000.0
WALK_METERS_PER_MINUTE = 80.0
BIKE_METERS_PER_MINUTE = 16_000.0 / 60.0
MAX_STATION_LINK_METERS = 400.0
MAX_CELL_SNAP_METERS = 6_000.0

# Minutes from the street to the platform (and back), per mode. Deep metro and mainline stations
# take longer than street-level light rail and harbour-bus stops. Bikes add lift/ramp time.
STATION_ACCESS_MINUTES = {"metro": 2.0, "stog": 1.5, "regional": 2.0, "letbane": 0.5, "harbour": 0.5}
BIKE_STATION_EXTRA_MINUTES = {"metro": 1.0, "stog": 1.0, "regional": 1.0, "letbane": 0.5, "harbour": 0.5}

BIKE_MODE = {"id": "bike", "label": "Bike", "color": "#2E8B57"}

Point = Tuple[float, float]
Ring = List[Point]
Polygon = List[Ring]
MultiPolygon = List[Polygon]
BBox = Tuple[float, float, float, float]


def round_point(point: Point) -> List[float]:
    return [round(point[0], 1), round(point[1], 1)]


def round_path(points: Sequence[Point]) -> List[List[float]]:
    return [round_point(point) for point in points]


def load_json(path: Path) -> dict | list:
    return json.loads(path.read_text(encoding="utf-8"))


def lonlat_to_xy(lon: float, lat: float, lat0: float) -> Point:
    meters_per_deg_lat = 111_320.0
    meters_per_deg_lon = meters_per_deg_lat * math.cos(math.radians(lat0))
    return lon * meters_per_deg_lon, lat * meters_per_deg_lat


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def ring_area(ring: Sequence[Point]) -> float:
    area = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        area += x1 * y2 - x2 * y1
    return area / 2.0


def polygon_centroid(ring: Sequence[Point]) -> Point:
    area = ring_area(ring) or 1.0
    factor = 1.0 / (6.0 * area)
    cx = 0.0
    cy = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        cross = x1 * y2 - x2 * y1
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    return cx * factor, cy * factor


def distance_to_rings(point: Point, rings: Sequence[Ring]) -> float:
    px, py = point
    best = math.inf
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            dx, dy = x2 - x1, y2 - y1
            length_sq = dx * dx + dy * dy
            t = 0.0 if length_sq == 0 else clamp(((px - x1) * dx + (py - y1) * dy) / length_sq, 0.0, 1.0)
            best = min(best, math.hypot(px - (x1 + dx * t), py - (y1 + dy * t)))
    return best


def label_point(polygon: Polygon, clip: BBox, samples: int = 36) -> Point | None:
    """Interior point (inside the map bounds) far from the polygon's edges and the map edge."""
    min_x, min_y, max_x, max_y = bounds_of_ring(polygon[0])
    min_x, min_y = max(min_x, clip[0]), max(min_y, clip[1])
    max_x, max_y = min(max_x, clip[2]), min(max_y, clip[3])
    if min_x >= max_x or min_y >= max_y:
        return None
    best, best_distance = None, -1.0
    for i in range(samples):
        for j in range(samples):
            point = (min_x + (i + 0.5) * (max_x - min_x) / samples, min_y + (j + 0.5) * (max_y - min_y) / samples)
            if not point_in_polygon(point, polygon):
                continue
            edge = min(point[0] - clip[0], clip[2] - point[0], point[1] - clip[1], clip[3] - point[1])
            distance = min(distance_to_rings(point, polygon), edge)
            if distance > best_distance:
                best, best_distance = point, distance
    return best if best_distance > 300.0 else None


def simplify_polyline(points: Sequence[Point], min_distance: float) -> List[Point]:
    if len(points) <= 2:
        return list(points)
    simplified = [points[0]]
    for point in points[1:-1]:
        if math.hypot(point[0] - simplified[-1][0], point[1] - simplified[-1][1]) >= min_distance:
            simplified.append(point)
    if points[-1] != simplified[-1]:
        simplified.append(points[-1])
    return simplified


def simplify_ring(ring: Sequence[Point], min_distance: float) -> Ring:
    if len(ring) <= 4:
        return list(ring)
    core = list(ring[:-1]) if ring[0] == ring[-1] else list(ring)
    simplified = [core[0]]
    for point in core[1:]:
        if math.hypot(point[0] - simplified[-1][0], point[1] - simplified[-1][1]) >= min_distance:
            simplified.append(point)
    if len(simplified) < 3:
        simplified = core[:3]
    simplified.append(simplified[0])
    return simplified


def bounds_of_ring(ring: Sequence[Point]) -> BBox:
    xs = [x for x, _ in ring]
    ys = [y for _, y in ring]
    return min(xs), min(ys), max(xs), max(ys)


def bounds_of_points(points: Sequence[Point]) -> BBox:
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    return min(xs), min(ys), max(xs), max(ys)


def expand_bbox(bbox: BBox, margin: float) -> BBox:
    return bbox[0] - margin, bbox[1] - margin, bbox[2] + margin, bbox[3] + margin


def bbox_intersects(a: BBox, b: BBox) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


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


def point_in_polygon(point: Point, polygon: Polygon) -> bool:
    if not polygon or not point_in_ring(point, polygon[0]):
        return False
    return not any(point_in_ring(point, hole) for hole in polygon[1:])


def point_in_multipolygon(point: Point, multipolygon: MultiPolygon) -> bool:
    return any(point_in_polygon(point, polygon) for polygon in multipolygon)


def geojson_polygons(geometry: dict) -> list:
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"]
    return []


def project_polygon(polygon_coords: list, lat0: float, min_distance: float) -> Polygon:
    return [simplify_ring([lonlat_to_xy(lon, lat, lat0) for lon, lat in ring], min_distance) for ring in polygon_coords]


def extract_municipalities(payload: dict, lat0: float, bounds: BBox) -> Tuple[list, MultiPolygon]:
    """Returns the drawable municipalities and the unsimplified land polygons (for rasterizing,
    where independently simplified shared borders would leave slivers)."""
    municipalities = []
    all_polygons: MultiPolygon = []
    for feature in payload["features"]:
        coords_list = geojson_polygons(feature["geometry"])
        all_polygons.extend(project_polygon(coords, lat0, 0.0) for coords in coords_list)
        multipolygon = [project_polygon(coords, lat0, 8.0) for coords in coords_list]
        visible = [polygon for polygon in multipolygon if bbox_intersects(bounds_of_ring(polygon[0]), bounds)]
        if not visible:
            continue
        largest = max(visible, key=lambda polygon: abs(ring_area(polygon[0])))
        label = label_point(largest, bounds)
        municipalities.append(
            {
                "name": feature["properties"]["name"],
                "label": round_point(label) if label else None,
                "polygons": [[round_path(ring) for ring in polygon] for polygon in visible],
            }
        )
    return municipalities, all_polygons


def extract_parks(lat0: float, bounds: BBox) -> list:
    if not PARKS_PATH.exists():
        return []
    parks = []
    for feature in load_json(PARKS_PATH)["features"]:
        try:
            area = float(feature["properties"].get("shape_area") or 0.0)
        except (TypeError, ValueError):
            area = 0.0
        if area < MIN_PARK_AREA:
            continue
        for polygon_coords in geojson_polygons(feature["geometry"]):
            polygon = project_polygon(polygon_coords, lat0, 25.0)
            if polygon and bbox_intersects(bounds_of_ring(polygon[0]), bounds):
                parks.append([round_path(ring) for ring in polygon])
    return parks


def extract_water(lat0: float, bounds: BBox) -> Tuple[list, MultiPolygon]:
    """Lakes, canals, and harbour basins: drawn on the map and cut out of the land grid, so the
    heatmap and pin snapping never treat open water (e.g. Søerne) as walkable."""
    if not WATER_PATH.exists():
        return [], []
    drawn, raster = [], []
    for feature in load_json(WATER_PATH)["features"]:
        area = float(feature["properties"].get("shape_area") or 0.0)
        for polygon_coords in geojson_polygons(feature["geometry"]):
            polygon = project_polygon(polygon_coords, lat0, 0.0)
            if not bbox_intersects(bounds_of_ring(polygon[0]), bounds):
                continue
            raster.append(polygon)
            if area >= MIN_DRAWN_WATER_AREA:
                drawn.append([round_path(simplify_ring(ring, 6.0)) for ring in polygon])
    return drawn, raster


def extract_major_streets(lat0: float, bounds: BBox) -> list:
    if not STREETS_PATH.exists():
        return []
    streets = []
    for element in load_json(STREETS_PATH).get("elements", []):
        tags = element.get("tags", {})
        kind = tags.get("highway")
        if element.get("type") != "way" or kind not in {"motorway", "trunk", "primary"} or "geometry" not in element:
            continue
        points = simplify_polyline([lonlat_to_xy(node["lon"], node["lat"], lat0) for node in element["geometry"]], 40.0)
        if len(points) < 2 or not bbox_intersects(bounds_of_points(points), bounds):
            continue
        streets.append({"kind": kind, "name": tags.get("name") or tags.get("ref") or "", "points": round_path(points)})
    return streets


def build_external_land(lat0: float, bounds: BBox, land: MultiPolygon) -> list:
    if not EXTERNAL_LAND_PATH.exists():
        return []
    visible = expand_bbox(bounds, 15_000.0)
    polygons = []
    for feature in load_json(EXTERNAL_LAND_PATH)["features"]:
        for polygon_coords in geojson_polygons(feature["geometry"]):
            polygon = project_polygon(polygon_coords, lat0, 40.0)
            if bbox_intersects(bounds_of_ring(polygon[0]), visible) and not point_in_multipolygon(
                polygon_centroid(polygon[0]), land
            ):
                polygons.append([round_path(ring) for ring in polygon])
    return polygons


def build_route_shapes(network: dict, lat0: float, bounds: BBox) -> list:
    draw_rank = {mode: rank for rank, mode in enumerate(cph_transit.MODE_DRAW_ORDER)}
    visible = expand_bbox(bounds, 2_000.0)
    shapes = []
    for shape in network["shapes"]:
        route = network["routes"][shape["route"]]
        points = simplify_polyline([lonlat_to_xy(lon, lat, lat0) for lon, lat in shape["lonlat"]], 30.0)
        if len(points) < 2 or not bbox_intersects(bounds_of_points(points), visible):
            continue
        shapes.append(
            {
                "routeId": shape["route"],
                "mode": route["mode"],
                "color": route["color"],
                "textColor": route["textColor"],
                "label": route["label"],
                "points": round_path(points),
            }
        )
    shapes.sort(key=lambda shape: (draw_rank.get(shape["mode"], 0), shape["routeId"]))
    return shapes


def rasterize_land(land: MultiPolygon, bounds: BBox, cols: int, rows: int) -> List[bytearray]:
    """Scanline fill: even-odd within each polygon (outer ring + holes), OR-ed across polygons."""
    min_x, min_y, max_x, max_y = bounds
    cell_w = (max_x - min_x) / cols
    cell_h = (max_y - min_y) / rows
    grid = [bytearray(cols) for _ in range(rows)]
    for polygon in land:
        poly_min_x, poly_min_y, poly_max_x, poly_max_y = bounds_of_ring(polygon[0])
        if not bbox_intersects((poly_min_x, poly_min_y, poly_max_x, poly_max_y), bounds):
            continue
        segments = [(x1, y1, x2, y2) for ring in polygon for (x1, y1), (x2, y2) in zip(ring, ring[1:])]
        first_row = max(0, math.floor((poly_min_y - min_y) / cell_h))
        last_row = min(rows - 1, math.ceil((poly_max_y - min_y) / cell_h))
        for row in range(first_row, last_row + 1):
            y = min_y + (row + 0.5) * cell_h
            crossings = sorted(
                x1 + (y - y1) * (x2 - x1) / (y2 - y1) for x1, y1, x2, y2 in segments if (y1 > y) != (y2 > y)
            )
            line = grid[row]
            for start, end in zip(crossings[0::2], crossings[1::2]):
                first = max(0, math.ceil((start - min_x) / cell_w - 0.5))
                last = min(cols - 1, math.floor((end - min_x) / cell_w - 0.5))
                for col in range(first, last + 1):
                    line[col] = 1
    return grid


def build_transit(
    network: dict, lat0: float, node_index: cph_streets.NodeIndex, bounds: BBox
) -> Tuple[list, list, list, list]:
    linkable = expand_bbox(bounds, 1_000.0)
    stations = []
    route_states = []
    station_states: List[List[int]] = []
    state_index: Dict[Tuple[int, str], int] = {}
    for station_index, station in enumerate(network["stations"]):
        point = lonlat_to_xy(station["lonlat"][0], station["lonlat"][1], lat0)
        stop_links = {}
        for stop_id, (lon, lat) in station["stops"].items():
            stop_point = lonlat_to_xy(lon, lat, lat0)
            node, meters = -1, 0.0
            if linkable[0] <= stop_point[0] <= linkable[2] and linkable[1] <= stop_point[1] <= linkable[3]:
                node, meters = node_index.nearest(stop_point, MAX_STATION_LINK_METERS)
                if meters > MAX_STATION_LINK_METERS:
                    node, meters = -1, 0.0
            stop_links[stop_id] = (node, meters)
        states = []
        for route_id in sorted(station["routes"]):
            node, meters = stop_links[station["routeStops"][route_id]]
            state_index[(station_index, route_id)] = len(route_states)
            states.append(len(route_states))
            route_states.append(
                {
                    "stationIndex": station_index,
                    "routeId": route_id,
                    "mode": network["routes"][route_id]["mode"],
                    "node": node,
                    "linkMeters": round(meters, 1),
                }
            )
        station_states.append(states)
        stations.append(
            {
                "id": station["id"],
                "name": station["name"],
                "point": round_point(point),
                "routes": station["routes"],
                "modes": station["modes"],
            }
        )

    waits = network["routeWaits"]
    adjacency: List[Dict[int, float]] = [dict() for _ in route_states]
    for from_station, to_station, route_id, minutes in network["edges"]:
        a = state_index.get((from_station, route_id))
        b = state_index.get((to_station, route_id))
        if a is not None and b is not None and minutes < adjacency[a].get(b, math.inf):
            adjacency[a][b] = minutes
    # In-station transfers: GTFS minimum transfer time plus the expected wait for the next line.
    for station_index, station in enumerate(network["stations"]):
        for from_route, to_route, seconds in station["transfers"]:
            a = state_index[(station_index, from_route)]
            b = state_index[(station_index, to_route)]
            adjacency[a][b] = round(seconds / 60.0 + waits.get(to_route, 4.0), 2)

    return (
        stations,
        route_states,
        station_states,
        [[[target, round(weight, 2)] for target, weight in sorted(edges.items())] for edges in adjacency],
    )


def write_binary(path: Path, arrays: List[Tuple[str, array]]) -> Dict[str, list]:
    """Concatenate typed arrays (little-endian), 4-byte aligned. Returns {name: [type, offset, length]}."""
    layout = {}
    blob = bytearray()
    for name, values in arrays:
        while len(blob) % 4:
            blob.append(0)
        layout[name] = [values.typecode, len(blob), len(values)]
        blob.extend(values.tobytes())
    path.write_bytes(bytes(blob))
    return layout


def main() -> None:
    network = cph_transit.load_network()
    municipality_payload = load_json(MUNICIPALITIES_PATH)
    lats = [lat for f in municipality_payload["features"] for poly in f["geometry"]["coordinates"] for _, lat in poly[0]]
    lat0 = (min(lats) + max(lats)) / 2.0
    full_bounds = expand_bbox(
        bounds_of_points(
            [lonlat_to_xy(lon, lat, lat0) for f in municipality_payload["features"] for poly in f["geometry"]["coordinates"] for lon, lat in poly[0]]
        ),
        200.0,
    )
    cols = math.ceil((full_bounds[2] - full_bounds[0]) / CELL_METERS)
    rows = math.ceil((full_bounds[3] - full_bounds[1]) / CELL_METERS)
    min_x, min_y = full_bounds[0], full_bounds[1]
    max_x, max_y = min_x + cols * CELL_METERS, min_y + rows * CELL_METERS
    bounds = (min_x, min_y, max_x, max_y)
    view_west, view_south, view_east, view_north = INITIAL_VIEW_BBOX
    initial_view = lonlat_to_xy(view_west, view_south, lat0) + lonlat_to_xy(view_east, view_north, lat0)

    municipalities, land = extract_municipalities(municipality_payload, lat0, bounds)
    external_land = build_external_land(lat0, bounds, land)
    parks = extract_parks(lat0, bounds)
    water, water_raster = extract_water(lat0, bounds)
    streets = extract_major_streets(lat0, bounds)
    route_shapes = build_route_shapes(network, lat0, bounds)

    print("Building street graph…")
    graph = cph_streets.build_street_graph(lambda lon, lat: lonlat_to_xy(lon, lat, lat0))
    xs, ys, street_adjacency = graph["xs"], graph["ys"], graph["adjacency"]
    snappable = cph_streets.walkable_nodes(street_adjacency)
    node_index = cph_streets.NodeIndex(xs, ys, snappable)
    node_snappable = array("B", [0]) * len(xs)
    for node in snappable:
        node_snappable[node] = 1
    print(f"  {len(xs)} nodes, {sum(len(a) for a in street_adjacency)} directed edges")

    stations, route_states, station_states, transit_adjacency = build_transit(network, lat0, node_index, bounds)

    print("Rasterizing grid…")
    land_grid = rasterize_land(land, bounds, cols, rows)
    for row, line in enumerate(rasterize_land(water_raster, bounds, cols, rows)):
        for col, is_water in enumerate(line):
            if is_water:
                land_grid[row][col] = 0
    cell_w = (max_x - min_x) / cols
    cell_h = (max_y - min_y) / rows
    cell_node = array("i", [-1]) * (cols * rows)
    cell_snap = array("H", [0]) * (cols * rows)
    for row in range(rows):
        for col in range(cols):
            if not land_grid[row][col]:
                continue
            point = (min_x + (col + 0.5) * cell_w, min_y + (row + 0.5) * cell_h)
            node, meters = node_index.nearest(point, MAX_CELL_SNAP_METERS)
            if node >= 0:
                cell_node[row * cols + col] = node
                cell_snap[row * cols + col] = min(65535, round(meters * 10))

    SITE_DATA_DIR.mkdir(parents=True, exist_ok=True)
    offsets = array("I", [0])
    targets = array("I")
    lengths = array("B")
    flags = array("B")
    for edges in street_adjacency:
        for target, length, flag in edges:
            targets.append(target)
            lengths.append(max(1, min(255, round(length * 10))))
            flags.append(flag)
        offsets.append(len(targets))
    layout = write_binary(
        SITE_GRAPH_PATH,
        [
            ("nodeX", array("f", (x - min_x for x in xs))),
            ("nodeY", array("f", (y - min_y for y in ys))),
            ("edgeOffsets", offsets),
            ("edgeTargets", targets),
            ("cellNode", cell_node),
            ("cellSnapDm", cell_snap),
            ("edgeLengthDm", lengths),
            ("edgeFlags", flags),
            ("nodeSnappable", node_snappable),
        ],
    )
    assert struct.pack("<I", 1) == array("I", [1]).tobytes(), "binary output assumes a little-endian machine"

    land_cells = sum(1 for value in cell_node if value >= 0)
    output = {
        "meta": {
            "lat0": round(lat0, 6),
            "bounds": [round(value, 1) for value in bounds],
            "initialView": [round(value, 1) for value in initial_view],
            "gridCols": cols,
            "gridRows": rows,
            "landCells": land_cells,
            "nodeCount": len(xs),
            "walkMetersPerMinute": WALK_METERS_PER_MINUTE,
            "bikeMetersPerMinute": round(BIKE_METERS_PER_MINUTE, 2),
            "stationAccessMinutes": STATION_ACCESS_MINUTES,
            "bikeStationExtraMinutes": BIKE_STATION_EXTRA_MINUTES,
            "walkFlag": cph_streets.WALK,
            "bikeFlag": cph_streets.BIKE,
            "serviceDate": network["serviceDate"],
            "binary": layout,
        },
        "municipalities": municipalities,
        "externalLand": external_land,
        "parks": parks,
        "water": water,
        "streets": streets,
        "routes": route_shapes,
        "stations": stations,
        "routeStates": route_states,
        "stationStates": station_states,
        "routeWaits": network["routeWaits"],
        "adjacency": transit_adjacency,
        "modes": [BIKE_MODE] + network["modes"],
        "routeStyles": network["routes"],
    }

    SITE_DATA_PATH.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {SITE_DATA_PATH} and {SITE_GRAPH_PATH}")
    print(f"  grid {cols}x{rows} ({CELL_METERS:.0f} m), {land_cells} land cells")


if __name__ == "__main__":
    main()
