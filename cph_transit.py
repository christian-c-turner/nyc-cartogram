"""Extract a city's transit network from its GTFS feed.

Copenhagen's feed (GTFS/) covers all of Denmark; Stockholm's (GTFS-stockholm/) covers the whole
county. This module keeps the routes the city's `classify_route` (cities.py) recognises, restricts
them to stops in or near the mapped municipalities, picks one representative weekday, and returns
a compact network description that both the site-data builder and the static SVG generator consume.

The result is cached in data/<prefix>_transit_network.json and rebuilt when the GTFS files change.
"""

from __future__ import annotations

import bisect
import csv
import datetime as dt
import json
import math
import re
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

from cities import COPENHAGEN, City, city_from_argv
from platforms import PlatformDepth, platform_signature

CACHE_VERSION = 12

# Kept for the Copenhagen-only SVG generator.
MODE_DRAW_ORDER = COPENHAGEN.mode_draw_order
# Bus stops with the same name this close together (usually the two sides of the street) form one stop.
BUS_STOP_MERGE_RADIUS = 150.0

STATION_MERGE_RADIUS = 600.0
# Stations just outside the mapped municipalities still serve border neighbourhoods.
STATION_BOUNDARY_BUFFER = 400.0

SERVICE_WINDOW = (7 * 3600, 19 * 3600)
MIN_EDGE_SECONDS = 20
# Stops up to this long count as dwell, including layovers such as a regional train standing
# 12 minutes at København H before continuing to the airport.
MAX_DWELL_SECONDS = 30 * 60
MAX_EDGE_SECONDS = 45 * 60
MAX_SHAPES_PER_ROUTE_DIRECTION = 2
SHAPE_CLIP_MARGIN_DEG = (0.03, 0.05)  # lat, lon
MIN_WAIT = 1.5
MAX_WAIT = 30.0
# Used when transfers.txt has no entry for a pair of platforms in the same station.
DEFAULT_SAME_STOP_TRANSFER_SECONDS = 120
# Between different stops: a minute plus the walk (1.5x the straight line at 4.8 km/h), 2-6 min.
# Nørreport Metro -> S-tog (64 m apart) comes out at ~2.2 min.
CROSS_STOP_TRANSFER_BASE_SECONDS = 60
CROSS_STOP_TRANSFER_DETOUR = 1.5
CROSS_STOP_TRANSFER_RANGE_SECONDS = (120, 360)
# Changes between nearby stations (e.g. metro to a bus stop outside) get a direct edge with the
# timetable's wait when that beats walking over the street and waiting the average.
WALK_TRANSFER_RADIUS = 250.0
WALK_TRANSFER_DETOUR = 1.3
WALK_TRANSFER_MIN_GAIN_MINUTES = 0.5
WALK_METERS_PER_SECOND = 4800 / 3600

LonLat = Tuple[float, float]


def read_csv(gtfs_dir: Path, name: str) -> Iterable[dict]:
    path = gtfs_dir / name
    if not path.exists():
        return
    with path.open(encoding="utf-8-sig", newline="") as handle:
        yield from csv.DictReader(handle)


def parse_gtfs_time(value: str) -> int:
    hours, minutes, seconds = map(int, value.split(":"))
    return hours * 3600 + minutes * 60 + seconds


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def meters_between(a: LonLat, b: LonLat) -> float:
    kx = 111_320.0 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 111_320.0)


def point_in_ring(point: LonLat, ring: Sequence[LonLat]) -> bool:
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


class Area:
    """The mapped municipalities in lon/lat, for station filtering."""

    def __init__(self, city: City) -> None:
        payload = json.loads(city.municipalities_path.read_text(encoding="utf-8"))
        self.polygons: List[List[List[LonLat]]] = []
        for feature in payload["features"]:
            for polygon in feature["geometry"]["coordinates"]:
                self.polygons.append([[(lon, lat) for lon, lat in ring] for ring in polygon])
        lons = [lon for polygon in self.polygons for lon, _ in polygon[0]]
        lats = [lat for polygon in self.polygons for _, lat in polygon[0]]
        self.bbox = (min(lons), min(lats), max(lons), max(lats))

    def contains(self, point: LonLat) -> bool:
        for polygon in self.polygons:
            if point_in_ring(point, polygon[0]) and not any(point_in_ring(point, hole) for hole in polygon[1:]):
                return True
        return False

    def distance_to_boundary(self, point: LonLat) -> float:
        kx = 111_320.0 * math.cos(math.radians(point[1]))
        ky = 111_320.0
        px, py = point[0] * kx, point[1] * ky
        best = math.inf
        for polygon in self.polygons:
            ring = polygon[0]
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                ax, ay, bx, by = x1 * kx, y1 * ky, x2 * kx, y2 * ky
                dx, dy = bx - ax, by - ay
                length_sq = dx * dx + dy * dy
                t = 0.0 if length_sq == 0 else clamp(((px - ax) * dx + (py - ay) * dy) / length_sq, 0.0, 1.0)
                best = min(best, math.hypot(px - (ax + dx * t), py - (ay + dy * t)))
        return best

    def serves(self, point: LonLat) -> bool:
        min_lon, min_lat, max_lon, max_lat = self.bbox
        if not (min_lon - 0.02 <= point[0] <= max_lon + 0.02 and min_lat - 0.01 <= point[1] <= max_lat + 0.01):
            return False
        return self.contains(point) or self.distance_to_boundary(point) <= STATION_BOUNDARY_BUFFER


def contains_run(longer: Sequence[int], shorter: Sequence[int]) -> bool:
    """Whether `shorter` appears as a contiguous run inside `longer`."""
    size = len(shorter)
    return any(tuple(longer[start : start + size]) == tuple(shorter) for start in range(len(longer) - size + 1))


def active_services_by_date(gtfs_dir: Path) -> Dict[str, set]:
    weekdays = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
    active: Dict[str, set] = defaultdict(set)
    for row in read_csv(gtfs_dir, "calendar.txt"):
        start = dt.datetime.strptime(row["start_date"], "%Y%m%d").date()
        end = dt.datetime.strptime(row["end_date"], "%Y%m%d").date()
        day = start
        while day <= end:
            if row[weekdays[day.weekday()]] == "1":
                active[day.strftime("%Y%m%d")].add(row["service_id"])
            day += dt.timedelta(days=1)
    for row in read_csv(gtfs_dir, "calendar_dates.txt"):
        if row["exception_type"] == "1":
            active[row["date"]].add(row["service_id"])
        elif row["exception_type"] == "2":
            active[row["date"]].discard(row["service_id"])
    return active


def pick_service_date(trips: Dict[str, dict], active: Dict[str, set]) -> str:
    """Use the Monday–Friday date with the most modelled trips (avoids holidays and gaps)."""
    trips_per_service = Counter(trip["service_id"] for trip in trips.values())
    best_date, best_count = None, -1
    for date, services in active.items():
        if dt.datetime.strptime(date, "%Y%m%d").weekday() >= 5:
            continue
        count = sum(trips_per_service.get(service, 0) for service in services)
        if count > best_count:
            best_date, best_count = date, count
    if best_date is None:
        raise RuntimeError("No weekday service found in GTFS calendar")
    return best_date


def gtfs_signature(gtfs_dir: Path) -> List[List]:
    return [[path.name, path.stat().st_size, int(path.stat().st_mtime)] for path in sorted(gtfs_dir.glob("*.txt"))]


def build_network(city: City = COPENHAGEN) -> dict:
    gtfs_dir = city.gtfs_dir
    area = Area(city)
    agency_names = {row["agency_id"]: row["agency_name"] for row in read_csv(gtfs_dir, "agency.txt")}

    route_info: Dict[str, Tuple[str, str]] = {}
    route_labels: Dict[str, str] = {}
    for row in read_csv(gtfs_dir, "routes.txt"):
        classified = city.classify_route(row, agency_names.get(row.get("agency_id", ""), ""))
        if classified:
            mode, route_key, label = classified
            route_info[row["route_id"]] = (mode, route_key)
            route_labels[route_key] = label

    trips: Dict[str, dict] = {}
    for row in read_csv(gtfs_dir, "trips.txt"):
        if row["route_id"] not in route_info:
            continue
        mode, route_key = route_info[row["route_id"]]
        trips[row["trip_id"]] = {
            "mode": mode,
            "route": route_key,
            "service_id": row["service_id"],
            "direction": row.get("direction_id") or "0",
            "shape_id": row.get("shape_id") or "",
        }

    active = active_services_by_date(gtfs_dir)
    service_date = pick_service_date(trips, active)
    services = active[service_date]
    trips = {trip_id: trip for trip_id, trip in trips.items() if trip["service_id"] in services}
    print(f"  service date {service_date}: {len(trips)} trips")

    stop_times: Dict[str, List[Tuple[int, str, int, int]]] = defaultdict(list)
    for row in read_csv(gtfs_dir, "stop_times.txt"):
        trip_id = row["trip_id"]
        if trip_id not in trips:
            continue
        arrival, departure = row["arrival_time"] or row["departure_time"], row["departure_time"] or row["arrival_time"]
        if not arrival:
            continue  # untimed stop between timepoints
        stop_times[trip_id].append(
            (int(row["stop_sequence"]), row["stop_id"], parse_gtfs_time(arrival), parse_gtfs_time(departure))
        )
    stop_modes: Dict[str, set] = defaultdict(set)
    for trip_id, rows in stop_times.items():
        for _, stop_id, _, _ in rows:
            stop_modes[stop_id].add(trips[trip_id]["mode"])

    stops: Dict[str, dict] = {}
    for row in read_csv(gtfs_dir, "stops.txt"):
        if row["stop_id"] not in stop_modes:
            continue
        point = (float(row["stop_lon"]), float(row["stop_lat"]))
        if area.serves(point):
            bus_only = stop_modes[row["stop_id"]] == {"bus"}
            # Bus stops keep their full name ("Nørreport St. (Nørre Voldgade)") and are never merged
            # into a rail station; rail platforms merge by their normalized name.
            name = re.sub(r"\s+", " ", row["stop_name"]).strip() if bus_only else city.normalize_station_name(row["stop_name"])
            stops[row["stop_id"]] = {"name": name, "point": point, "bus": bus_only}

    # Group stops into station complexes: same name, close together.
    complexes: List[dict] = []
    stop_to_station: Dict[str, int] = {}
    by_name: Dict[Tuple[bool, str], List[int]] = defaultdict(list)
    for stop_id, stop in sorted(stops.items()):
        group = (stop["bus"], stop["name"])
        radius = BUS_STOP_MERGE_RADIUS if stop["bus"] else STATION_MERGE_RADIUS
        match = next(
            (
                index
                for index in by_name[group]
                if meters_between(complexes[index]["points"][0], stop["point"]) <= radius
            ),
            None,
        )
        if match is None:
            match = len(complexes)
            complexes.append({"name": stop["name"], "points": [], "stops": {}})
            by_name[group].append(match)
        complexes[match]["points"].append(stop["point"])
        complexes[match]["stops"][stop_id] = stop["point"]
        stop_to_station[stop_id] = match

    # Each trip as its run of station complexes in the area: (station, stop_id, arrival, departure).
    runs: Dict[str, List[Tuple[int, str, int, int]]] = {}
    for trip_id, rows in stop_times.items():
        rows.sort()
        run: List[Tuple[int, str, int, int]] = []
        for _, stop_id, arrival, departure in rows:
            if stop_id not in stop_to_station:
                continue
            station = stop_to_station[stop_id]
            if run and run[-1][0] == station:
                run[-1] = (station, run[-1][1], run[-1][2], departure)
            else:
                run.append((station, stop_id, arrival, departure))
        if len(run) >= 2:
            runs[trip_id] = run

    def in_window(seconds: int) -> bool:
        return SERVICE_WINDOW[0] <= seconds < SERVICE_WINDOW[1]

    # Daytime departures per mode between consecutive stations, and of those, per pair of hops a
    # train makes in a row. All lines of a mode are counted together, so where several lines run the
    # same way (S-tog A, B, C, E toward Hellerup; T17/T18/T19 toward T-Centralen; buses 5C and 350S)
    # you take whichever comes first and the wait reflects their combined frequency. Riding on past
    # a station where some of them turn off adds the wait for one that goes your way (see below).
    # Routes with no regular daytime service (night buses, a few peak-only extras) would otherwise
    # look available all day; leave them out, and don't count them toward anyone's wait either.
    route_hop_departures: Counter = Counter()
    for trip_id, run in runs.items():
        for k in range(len(run) - 1):
            if in_window(run[k][3]):
                route_hop_departures[(trips[trip_id]["route"], run[k][0], run[k + 1][0])] += 1
    active_routes = {route_key for (route_key, _a, _b), count in route_hop_departures.items() if count >= 2}

    hop_departures: Counter = Counter()
    through_departures: Counter = Counter()
    # All departure times per (mode, station, next station), for timetable waits at changes.
    hop_departure_times: Dict[Tuple[str, int, int], List[int]] = defaultdict(list)
    for trip_id, run in runs.items():
        if trips[trip_id]["route"] not in active_routes:
            continue
        mode = trips[trip_id]["mode"]
        for k in range(len(run) - 1):
            hop_departure_times[(mode, run[k][0], run[k + 1][0])].append(run[k][3])
            if not in_window(run[k][3]):
                continue
            hop_departures[(mode, run[k][0], run[k + 1][0])] += 1
            if k:
                through_departures[(mode, run[k - 1][0], run[k][0], run[k + 1][0])] += 1

    # Split each line into services: trips with the same stopping pattern, with short workings
    # (a contiguous part of a longer pattern) folded into the longer one. You can only stay on board
    # along a service, so two trains of the same line are never chained into a ride no train makes
    # (e.g. DSB west from Valby to Glostrup, then back east on the airport train).
    pattern_trips: Dict[Tuple[str, Tuple[int, ...]], List[str]] = defaultdict(list)
    for trip_id, run in runs.items():
        route_key = trips[trip_id]["route"]
        if route_key in active_routes and any(in_window(row[3]) for row in run[:-1]):
            pattern_trips[(route_key, tuple(row[0] for row in run))].append(trip_id)
    service_stations: List[Tuple[int, ...]] = []
    service_routes: List[str] = []
    service_trips: List[List[str]] = []
    services_by_route: Dict[str, List[int]] = defaultdict(list)
    for (route_key, pattern), trip_ids in sorted(
        pattern_trips.items(), key=lambda item: (-len(item[0][1]), -len(item[1]), item[0])
    ):
        containing = [
            service for service in services_by_route[route_key] if contains_run(service_stations[service], pattern)
        ]
        if containing:
            service = max(containing, key=lambda index: len(service_trips[index]))
        else:
            service = len(service_stations)
            service_stations.append(pattern)
            service_routes.append(route_key)
            service_trips.append([])
            services_by_route[route_key].append(service)
        service_trips[service].extend(trip_ids)
    service_ids = [f"{route_key}#{services_by_route[route_key].index(index) + 1}" for index, route_key in enumerate(service_routes)]

    # Ride times are arrival-to-arrival, so time standing at stations a train passes through is
    # included; the dwell at each (station, service) is kept so a ride is timed from its departure
    # where you board (see "dwell" in the output and how the app subtracts it when boarding).
    durations: Dict[Tuple[int, int, int], List[float]] = defaultdict(list)
    dwells: Dict[Tuple[int, int], List[float]] = defaultdict(list)
    service_stops: Dict[Tuple[int, int], Counter] = defaultdict(Counter)
    route_modes: Dict[str, str] = {}
    shape_counts: Dict[Tuple[str, str], Counter] = defaultdict(Counter)
    for service, trip_ids in enumerate(service_trips):
        for trip_id in trip_ids:
            trip = trips[trip_id]
            run = runs[trip_id]
            route_modes[trip["route"]] = trip["mode"]
            if trip["shape_id"]:
                shape_counts[(trip["route"], trip["direction"])][trip["shape_id"]] += 1
            for station, stop_id, arrival, departure in run:
                service_stops[(station, service)][stop_id] += 1
                if 0 <= departure - arrival <= MAX_DWELL_SECONDS:
                    dwells[(station, service)].append((departure - arrival) / 60.0)
            for prev, nxt in zip(run, run[1:]):
                seconds = nxt[2] - prev[2]
                if MIN_EDGE_SECONDS <= seconds <= MAX_EDGE_SECONDS:
                    durations[(prev[0], nxt[0], service)].append(seconds / 60.0)
    dwell = {key: round(statistics.median(values), 2) for key, values in dwells.items()}

    # Expected waits are half the daytime headway, 1.5–30 min. Boarding a service costs the wait for
    # its next hop, counting every train of its mode that makes that hop. Staying on past a station
    # where fewer of those trains continue (Glostrup, for the hourly airport train; Hellerup, where
    # S-tog lines split) adds the difference there: the wait for a train that does both hops, less
    # the wait already counted for the hop before.
    window_minutes = (SERVICE_WINDOW[1] - SERVICE_WINDOW[0]) / 60.0

    def expected_wait(departures: int) -> float:
        if departures <= 0:
            return MAX_WAIT
        return clamp(window_minutes / departures / 2.0, MIN_WAIT, MAX_WAIT)

    state_waits: Dict[Tuple[int, int], float] = {}
    edge_extra_waits: Dict[Tuple[int, int, int], float] = {}
    for service, stations_ in enumerate(service_stations):
        mode = route_modes[service_routes[service]]
        for k in range(len(stations_) - 1):
            here, after = stations_[k], stations_[k + 1]
            wait = expected_wait(hop_departures[(mode, here, after)])
            extra = 0.0
            if k:
                before = stations_[k - 1]
                extra = max(
                    0.0,
                    expected_wait(through_departures[(mode, before, here, after)])
                    - expected_wait(hop_departures[(mode, before, here)]),
                )
                # Someone boarding here pays at least the dwell (the app takes it off the wait), so
                # keep wait + extra at the full wait even when the train stands here a while.
                extra = min(extra, max(0.0, wait - dwell.get((here, service), 0.0)))
            edge_key = (here, after, service)
            edge_extra_waits[edge_key] = max(edge_extra_waits.get(edge_key, 0.0), extra)
            state_waits[(here, service)] = min(state_waits.get((here, service), math.inf), wait - extra)

    # Minimum platform-to-platform transfer times from transfers.txt (seconds). Line-specific
    # rows (e.g. cross-platform S-tog changes) take precedence over stop-level ones.
    route_key_by_id = {route_id: info[1] for route_id, info in route_info.items()}
    stop_transfers: Dict[Tuple[str, str], int] = {}
    route_transfers: Dict[Tuple[str, str, str, str], int] = {}
    for row in read_csv(gtfs_dir, "transfers.txt"):
        from_stop, to_stop = row["from_stop_id"], row["to_stop_id"]
        if from_stop not in stop_to_station or stop_to_station.get(to_stop) != stop_to_station[from_stop]:
            continue
        if row.get("from_trip_id") or row.get("to_trip_id") or row.get("transfer_type") != "2":
            continue
        seconds = int(row.get("min_transfer_time") or 0)
        if row.get("from_route_id") and row.get("to_route_id"):
            key = (
                from_stop,
                to_stop,
                route_key_by_id.get(row["from_route_id"], ""),
                route_key_by_id.get(row["to_route_id"], ""),
            )
            route_transfers[key] = min(seconds, route_transfers.get(key, seconds))
        else:
            stop_transfers[(from_stop, to_stop)] = min(seconds, stop_transfers.get((from_stop, to_stop), seconds))

    def transfer_seconds(from_stop: str, to_stop: str, from_route: str, to_route: str) -> int:
        if (from_stop, to_stop, from_route, to_route) in route_transfers:
            return route_transfers[(from_stop, to_stop, from_route, to_route)]
        if (from_stop, to_stop) in stop_transfers:
            return stop_transfers[(from_stop, to_stop)]
        if from_stop == to_stop:
            return DEFAULT_SAME_STOP_TRANSFER_SECONDS
        walk = meters_between(stops[from_stop]["point"], stops[to_stop]["point"]) * CROSS_STOP_TRANSFER_DETOUR / WALK_METERS_PER_SECOND
        return round(clamp(CROSS_STOP_TRANSFER_BASE_SECONDS + walk, *CROSS_STOP_TRANSFER_RANGE_SECONDS))

    # Where each service comes from and goes next at each station, for pruning useless transfers.
    previous_stations: Dict[Tuple[int, int], set] = defaultdict(set)
    next_stations: Dict[Tuple[int, int], set] = defaultdict(set)
    for service, stations_ in enumerate(service_stations):
        for here, after in zip(stations_, stations_[1:]):
            next_stations[(here, service)].add(after)
            previous_stations[(after, service)].add(here)
    station_services: Dict[int, List[int]] = defaultdict(list)
    for station, service in sorted(service_stops):
        station_services[station].append(service)

    # Timetable waits at changes. Journey planners pick an actual connection, so a change to a line
    # timed to meet yours (buses meeting trains, Ropsten → Lidingö) costs less than the average wait,
    # and a badly timed one more. For each daytime arrival of the service you're on, take the next
    # departure your way after the transfer walk, and average. Like the state waits, "your way" is
    # any train of the mode making the next hop; riding past a split adds its extra wait later.
    for hop_times in hop_departure_times.values():
        hop_times.sort()
    service_arrivals: Dict[Tuple[int, int], List[int]] = defaultdict(list)
    for service, trip_ids in enumerate(service_trips):
        for trip_id in trip_ids:
            for k, (station, _stop, arrival, _departure) in enumerate(runs[trip_id]):
                if k and in_window(arrival):
                    service_arrivals[(station, service)].append(arrival)

    def timetable_wait(from_station: int, a: int, to_station: int, b: int, transfer_s: float) -> float | None:
        """Expected minutes from being ready (arrival + transfer) to b's departure, less the extra
        wait its ride edges will add; None if service a has no daytime arrivals here."""
        arrivals = service_arrivals.get((from_station, a))
        if not arrivals:
            return None
        mode = route_modes[service_routes[b]]
        best = None
        for after in next_stations[(to_station, b)]:
            times = hop_departure_times.get((mode, to_station, after))
            if not times:
                continue
            total = 0.0
            for arrival in arrivals:
                ready = arrival + transfer_s
                index = bisect.bisect_left(times, ready)
                total += min(times[index] - ready, MAX_WAIT * 60) if index < len(times) else MAX_WAIT * 60
            average = total / len(arrivals) / 60.0
            # state_waits[(station, b)] is the average wait less the extra charged on b's next ride
            # edge; take the same extra off here so the change and the ride add up to `average`.
            extra = max(0.0, expected_wait(hop_departures[(mode, to_station, after)]) - state_waits.get((to_station, b), 0.0))
            value = max(0.0, average - extra)
            best = value if best is None else min(best, value)
        return best

    depth = PlatformDepth(city)
    access: Dict[Tuple[int, int], float] = {}
    for (station, service), counter in service_stops.items():
        lon, lat = stops[counter.most_common(1)[0][0]]["point"]
        access[(station, service)] = depth.access_minutes(
            route_modes[service_routes[service]], lon, lat, complexes[station]["name"]
        )

    # Drop complexes no modelled service actually stops at, then re-index.
    keep = sorted(station_services)
    remap = {old: new for new, old in enumerate(keep)}
    stations = []
    for old in keep:
        station = complexes[old]
        lon = sum(p[0] for p in station["points"]) / len(station["points"])
        lat = sum(p[1] for p in station["points"]) / len(station["points"])
        services_here = station_services[old]
        stops_used = {service: service_stops[(old, service)].most_common(1)[0][0] for service in services_here}
        # Changing is only useful from a service that arrives here to one that leaves, and not onto
        # the same line heading back where you came from. Each change is [from, to, minimum transfer
        # seconds, timetable wait in minutes (or null: use the average)].
        transfers = []
        for a in services_here:
            for b in services_here:
                if (
                    a == b
                    or not previous_stations[(old, a)]
                    or not next_stations[(old, b)]
                    or (service_routes[a] == service_routes[b] and next_stations[(old, b)] & previous_stations[(old, a)])
                ):
                    continue
                seconds = transfer_seconds(stops_used[a], stops_used[b], service_routes[a], service_routes[b])
                wait = timetable_wait(old, a, old, b, seconds)
                transfers.append([service_ids[a], service_ids[b], seconds, None if wait is None else round(wait, 2)])
        routes_here = sorted({service_routes[service] for service in services_here})
        stations.append(
            {
                "id": str(len(stations)),
                "name": station["name"],
                "lonlat": [round(lon, 6), round(lat, 6)],
                "routes": routes_here,
                "modes": sorted({route_modes[route] for route in routes_here}),
                "stops": {
                    stop_id: [round(point[0], 6), round(point[1], 6)]
                    for stop_id, point in station["stops"].items()
                    if stop_id in stops_used.values()
                },
                "services": {
                    service_ids[service]: {
                        "route": service_routes[service],
                        "stop": stops_used[service],
                        "dwell": dwell.get((old, service), 0.0),
                        "access": access[(old, service)],
                        # A service's last stop has nothing to board.
                        "wait": round(state_waits.get((old, service), MAX_WAIT), 2),
                    }
                    for service in services_here
                },
                "transfers": transfers,
            }
        )

    # Changes between nearby stations: [from station, from service, to station, to service, walk
    # seconds (platform to street, the walk, street to platform), timetable wait in minutes]. Only
    # kept where the timetable makes the change clearly quicker than the street route, which pays
    # the average wait; otherwise the street route already covers it.
    stop_of = {(station, service): counter.most_common(1)[0][0] for (station, service), counter in service_stops.items()}
    near_cells: Dict[Tuple[int, int], List[Tuple[int, int, LonLat]]] = defaultdict(list)
    cell_deg = WALK_TRANSFER_RADIUS / 111_320.0
    for (station, service), stop_id in stop_of.items():
        if station in remap:
            point = stops[stop_id]["point"]
            near_cells[(math.floor(point[1] / cell_deg), math.floor(point[0] / (2 * cell_deg)))].append((station, service, point))
    walk_transfers = []
    for (from_station, a), stop_id in sorted(stop_of.items()):
        if from_station not in remap or not previous_stations[(from_station, a)]:
            continue
        point = stops[stop_id]["point"]
        ci, cj = math.floor(point[1] / cell_deg), math.floor(point[0] / (2 * cell_deg))
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for to_station, b, to_point in near_cells.get((ci + di, cj + dj), ()):
                    if to_station == from_station or not next_stations[(to_station, b)]:
                        continue
                    if service_routes[a] == service_routes[b] or next_stations[(to_station, b)] & previous_stations[(from_station, a)]:
                        continue
                    meters = meters_between(point, to_point)
                    if meters > WALK_TRANSFER_RADIUS:
                        continue
                    seconds = (access[(from_station, a)] + access[(to_station, b)]) * 60 + meters * WALK_TRANSFER_DETOUR / WALK_METERS_PER_SECOND
                    wait = timetable_wait(from_station, a, to_station, b, seconds)
                    if wait is None or wait > state_waits.get((to_station, b), MAX_WAIT) - WALK_TRANSFER_MIN_GAIN_MINUTES:
                        continue
                    walk_transfers.append(
                        [remap[from_station], service_ids[a], remap[to_station], service_ids[b], round(seconds), round(wait, 2)]
                    )
    print(f"  {len(walk_transfers)} timed changes between nearby stations")

    edges = [
        [
            remap[a],
            remap[b],
            service_ids[service],
            round(statistics.median(values), 2),
            round(edge_extra_waits.get((a, b, service), 0.0), 2),
        ]
        for (a, b, service), values in sorted(durations.items())
    ]

    selected_shapes: Dict[str, str] = {}
    for (route_key, _direction), counter in shape_counts.items():
        for shape_id, _ in counter.most_common(MAX_SHAPES_PER_ROUTE_DIRECTION):
            selected_shapes[shape_id] = route_key
    shape_points: Dict[str, List[Tuple[int, LonLat]]] = defaultdict(list)
    for row in read_csv(gtfs_dir, "shapes.txt"):
        if row["shape_id"] in selected_shapes:
            shape_points[row["shape_id"]].append(
                (int(row["shape_pt_sequence"]), (float(row["shape_pt_lon"]), float(row["shape_pt_lat"])))
            )

    min_lon, min_lat, max_lon, max_lat = area.bbox
    lat_margin, lon_margin = SHAPE_CLIP_MARGIN_DEG

    def in_clip(point: LonLat) -> bool:
        return (
            min_lon - lon_margin <= point[0] <= max_lon + lon_margin
            and min_lat - lat_margin <= point[1] <= max_lat + lat_margin
        )

    shapes = []
    for shape_id, route_key in sorted(selected_shapes.items()):
        points = [point for _, point in sorted(shape_points.get(shape_id, []))]
        run: List[LonLat] = []
        for point in points + [None]:
            if point is not None and in_clip(point):
                run.append(point)
                continue
            if len(run) >= 2:
                shapes.append({"route": route_key, "lonlat": [[round(x, 6), round(y, 6)] for x, y in run]})
            run = []

    routes = {}
    for route_key, mode in sorted(route_modes.items()):
        mode_color = next(m["color"] for m in city.modes if m["id"] == mode)
        routes[route_key] = {
            "mode": mode,
            "label": route_labels[route_key],
            "color": city.route_colors.get(route_key, mode_color),
            "textColor": city.route_text_colors.get(route_key, "#FFFFFF"),
        }

    return {
        "version": CACHE_VERSION,
        "gtfs": gtfs_signature(gtfs_dir),
        "platforms": platform_signature(city),
        "serviceDate": service_date,
        "modes": list(city.modes),
        "routes": routes,
        "services": {service_id: service_routes[index] for index, service_id in enumerate(service_ids)},
        "stations": stations,
        "edges": edges,
        "walkTransfers": walk_transfers,
        "shapes": shapes,
    }


def load_network(force: bool = False, city: City = COPENHAGEN) -> dict:
    cache_path = city.transit_cache_path
    if not force and cache_path.exists():
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        if (
            cached.get("version") == CACHE_VERSION
            and cached.get("gtfs") == gtfs_signature(city.gtfs_dir)
            and cached.get("platforms") == platform_signature(city)
        ):
            return cached
    if not (city.gtfs_dir / "stop_times.txt").exists():
        raise SystemExit(f"{city.gtfs_dir} has no GTFS feed; run `python3 setup_data.py --city {city.id}` first.")
    print(f"Extracting the {city.name} network from GTFS (takes a minute)…")
    network = build_network(city)
    cache_path.write_text(json.dumps(network, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  cached to {cache_path}")
    return network


if __name__ == "__main__":
    net = load_network(force=True, city=city_from_argv(sys.argv))
    print(f"{len(net['stations'])} stations, {len(net['edges'])} edges, {len(net['shapes'])} shape runs")
    by_mode = Counter(info["mode"] for info in net["routes"].values())
    print("  routes per mode:", dict(by_mode))
    services_per_route = Counter(net["services"].values())
    for route_key, info in net["routes"].items():
        if info["mode"] != "bus":
            print(f"  {info['mode']:9s} {route_key:12s} {services_per_route[route_key]} services")
