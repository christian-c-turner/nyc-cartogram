"""Platform access times: minutes from a station's street entrance to a platform.

A rail platform is underground when the nearest OSM track of its kind (City.track_railway, e.g.
railway=subway for a metro) runs in a tunnel; data/<prefix>_rail_tracks.json comes from
fetch_cph_basemap.py. Used by cph_transit (walking times for changes between nearby stops) and,
through the transit network it caches, by the site builder.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

from cities import City

# A platform's GTFS stop is matched to the nearest track of its kind within this distance.
PLATFORM_TRACK_METERS = 80.0
CELL_METERS = 100.0

XY = Tuple[float, float]


def platform_signature(city: City) -> List:
    """Changes whenever platform times would: the track file or the city's access settings."""
    path = city.rail_tracks_path
    tracks = [path.stat().st_size, int(path.stat().st_mtime)] if path.exists() else []
    settings = [
        city.station_access_minutes,
        city.underground_access_minutes,
        city.track_railway,
        city.station_access_overrides,
    ]
    return [tracks, json.loads(json.dumps(settings, sort_keys=True))]


class PlatformDepth:
    def __init__(self, city: City):
        self.city = city
        self.cells: Dict[Tuple[int, int], List[Tuple[str, bool, XY, XY]]] = defaultdict(list)
        self.lat0 = sum(city.street_bbox[0::2]) / 2
        self.kx = 111_320.0 * math.cos(math.radians(self.lat0))
        path: Path = city.rail_tracks_path
        if not path.exists():
            print(f"  no {path.name}; treating every platform as street level")
            return
        for way in json.loads(path.read_text(encoding="utf-8"))["ways"]:
            points = [self.xy(lon, lat) for lon, lat in way["points"]]
            for a, b in zip(points, points[1:]):
                segment = (way["railway"], way["tunnel"], a, b)
                # Index every cell along the segment (sampled at half a cell), so a stop beside the
                # middle of a long straight track still finds it.
                steps = max(1, math.ceil(math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL_METERS / 2)))
                cells = {self.cell_of((a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps)) for i in range(steps + 1)}
                for cell in cells:
                    self.cells[cell].append(segment)

    def xy(self, lon: float, lat: float) -> XY:
        return (lon * self.kx, lat * 110_540.0)

    @staticmethod
    def cell_of(point: XY) -> Tuple[int, int]:
        return (math.floor(point[0] / CELL_METERS), math.floor(point[1] / CELL_METERS))

    def in_tunnel(self, lon: float, lat: float, railway: str) -> bool:
        """Whether the nearest track of this kind (within PLATFORM_TRACK_METERS) runs in a tunnel."""
        point = self.xy(lon, lat)
        cx, cy = self.cell_of(point)
        best, tunnel = PLATFORM_TRACK_METERS, False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for kind, is_tunnel, (ax, ay), (bx, by) in self.cells.get((cx + dx, cy + dy), ()):
                    if kind != railway:
                        continue
                    vx, vy = bx - ax, by - ay
                    length_sq = vx * vx + vy * vy
                    t = ((point[0] - ax) * vx + (point[1] - ay) * vy) / length_sq if length_sq else 0.0
                    t = max(0.0, min(1.0, t))
                    meters = math.hypot(point[0] - ax - t * vx, point[1] - ay - t * vy)
                    if meters < best:
                        best, tunnel = meters, is_tunnel
        return tunnel

    def access_minutes(self, mode: str, lon: float, lat: float, station_name: str = "") -> float:
        """Minutes from the street to a platform of this mode at this stop."""
        city = self.city
        override = city.station_access_overrides.get(mode, {}).get(station_name)
        if override is not None:
            return override
        if mode in city.underground_access_minutes and self.in_tunnel(lon, lat, city.track_railway[mode]):
            return city.underground_access_minutes[mode]
        return city.station_access_minutes.get(mode, 1.5)
