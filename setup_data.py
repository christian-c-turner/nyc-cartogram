#!/usr/bin/env python3
"""One-shot setup for a fresh clone: download the inputs that aren't in git, then build the site data.

  python3 setup_data.py                 # everything that's missing, then build
  python3 setup_data.py --refresh-gtfs  # also replace GTFS/ with the latest Rejseplanen feed
  python3 setup_data.py --refresh-osm   # also re-download all OpenStreetMap layers
  python3 setup_data.py --svg           # also render output/cph_transit_weighted_projection.svg

Steps:
  1. GTFS/  <- Rejseplanen's national GTFS feed (~55 MB zip, ~350 MB unzipped; not in git)
  2. data/  <- OpenStreetMap layers via Overpass (the ~73 MB street network is not in git;
               the smaller layers are, and are only re-fetched with --refresh-osm)
  3. site/data/commute_map_data.json + site/data/street_graph.bin  <- build_commute_site_data.py
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GTFS_DIR = ROOT / "GTFS"
GTFS_URL = "https://www.rejseplanen.info/labs/GTFS.zip"
GTFS_REQUIRED = ("agency.txt", "routes.txt", "trips.txt", "stop_times.txt", "stops.txt", "calendar.txt", "shapes.txt")


def log(message: str) -> None:
    print(message, flush=True)


def gtfs_present() -> bool:
    return all((GTFS_DIR / name).exists() for name in GTFS_REQUIRED)


def download_gtfs() -> None:
    log(f"Downloading GTFS feed from {GTFS_URL} …")
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "GTFS.zip"
        request = urllib.request.Request(GTFS_URL, headers={"User-Agent": "cph-cartogram-setup/1.0"})
        with urllib.request.urlopen(request, timeout=600) as response, archive.open("wb") as handle:
            shutil.copyfileobj(response, handle)
        log(f"  downloaded {archive.stat().st_size / 1e6:.0f} MB; unzipping into GTFS/")
        if GTFS_DIR.exists():
            shutil.rmtree(GTFS_DIR)
        GTFS_DIR.mkdir()
        with zipfile.ZipFile(archive) as zipped:
            for member in zipped.infolist():
                # Flatten any folder inside the zip; GTFS files must sit directly in GTFS/.
                name = Path(member.filename).name
                if member.is_dir() or not name.endswith(".txt"):
                    continue
                with zipped.open(member) as source, (GTFS_DIR / name).open("wb") as target:
                    shutil.copyfileobj(source, target)
    missing = [name for name in GTFS_REQUIRED if not (GTFS_DIR / name).exists()]
    if missing:
        sys.exit(f"GTFS download is missing {missing}; check {GTFS_URL}")


def main() -> None:
    args = set(sys.argv[1:])
    unknown = args - {"--refresh-gtfs", "--refresh-osm", "--svg"}
    if unknown:
        sys.exit(f"Unknown option(s): {', '.join(sorted(unknown))}\n{__doc__}")

    if "--refresh-gtfs" in args or not gtfs_present():
        download_gtfs()
    else:
        log("GTFS/ present; skipping download (use --refresh-gtfs for the latest feed)")

    import fetch_cph_basemap  # noqa: E402 - local scripts, imported after the GTFS step

    log("Fetching OpenStreetMap layers (skips files already in data/) …")
    sys.argv = [sys.argv[0]] + (["--force"] if "--refresh-osm" in args else [])
    fetch_cph_basemap.main()

    import build_commute_site_data  # noqa: E402

    log("Building site data …")
    build_commute_site_data.main()

    if "--svg" in args:
        import generate_cph_transit_weighted_projection  # noqa: E402

        generate_cph_transit_weighted_projection.main()

    log("Done. Run `python3 serve.py 8080` and open http://localhost:8080/")


if __name__ == "__main__":
    main()
