"""Create the built-in 16:30–18:00 Eastern commute from archived inventory changes.

Run from the repository root with Python 3.11+ and duckdb==2.0.0 installed:
    python scripts/bikeshare/import_replay.py --date 2026-09-24
The monthly CityBikes Parquet contains UTC event times and GBFS station UUIDs.
The operator's last published trip file supplies the station codes used for demand.
"""

import argparse
import csv
import hashlib
import io
import json
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from zoneinfo import ZoneInfo

import duckdb

from build_demand import local_zip, published_files


OUTPUT = Path(__file__).resolve().parents[2] / "projects/bikeshare/data/sample-replay.json"
FRESHNESS_SECONDS = 15 * 60
EASTERN = ZoneInfo("America/New_York")


def station_codes(archive_path):
    """Keep only exact, unambiguous trip station-name to terminal-code matches."""
    by_name = defaultdict(set)
    with zipfile.ZipFile(archive_path) as archive:
        names = [n for n in archive.namelist() if n.endswith(".csv") and "__MACOSX" not in n]
        if not names:
            raise ValueError(f"No trip CSV in {archive_path}")
        for filename in names:
            with archive.open(filename) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as stream:
                for row in csv.DictReader(stream):
                    for endpoint in ("start", "end"):
                        name = row[f"{endpoint}_station_name"].strip()
                        code = row[f"{endpoint}_station_id"].strip()
                        if name and code:
                            by_name[name].add(code)
    return {name: next(iter(codes)) for name, codes in by_name.items() if len(codes) == 1}


def read_events(archive_path, first, last):
    """Retrieve every change in the window, including closures and broken records."""
    with duckdb.connect() as conn:
        return conn.execute("""
            SELECT nuid, name, latitude, longitude, bikes, free,
                   CAST(epoch(timestamp) AS BIGINT) AS captured,
                   CAST(epoch(try_cast(extra->>'last_updated' AS TIMESTAMP)) AS BIGINT) AS reported,
                   try_cast(extra->>'renting' AS BOOLEAN)
                     AND try_cast(extra->>'returning' AS BOOLEAN)
                     AND NOT try_cast(extra->>'virtual' AS BOOLEAN) AS operating
              FROM read_parquet(?)
             WHERE nuid IS NOT NULL AND timestamp BETWEEN ? AND ?
             ORDER BY timestamp, nuid
        """, [str(archive_path),
              datetime.fromtimestamp(first - FRESHNESS_SECONDS, timezone.utc).replace(tzinfo=None),
              datetime.fromtimestamp(last, timezone.utc).replace(tzinfo=None)]).fetchall()


def build(day, archive_path, archive_url, code_lookup, code_url):
    first = int(datetime.combine(day, time(16, 30), EASTERN).timestamp())
    last = int(datetime.combine(day, time(18), EASTERN).timestamp())
    events = read_events(archive_path, first, last)
    latest, indexes, stations, frames = {}, {}, [], []
    i = 0
    for ts in range(first, last + 1, 300):
        while i < len(events) and events[i][6] <= ts:
            latest[events[i][0]] = events[i]
            i += 1
        rows = []
        for uid, name, lat, lon, bikes, docks, captured, reported, operating in latest.values():
            if not operating or reported is None or not ts - FRESHNESS_SECONDS <= reported <= captured:
                continue
            if None in (lat, lon, bikes, docks) or min(bikes, docks) < 0 or bikes + docks == 0:
                continue
            if uid not in indexes:
                indexes[uid] = len(stations)
                stations.append({"id": uid, "shortName": code_lookup.get(name, ""),
                                 "name": name, "lat": lat, "lon": lon})
            rows.append([indexes[uid], bikes, docks, reported])
        if not rows:
            raise ValueError(f"No eligible observations at {datetime.fromtimestamp(ts, EASTERN)}")
        frames.append({"ts": ts, "rows": rows})
    return {
        "version": 1, "date": day.isoformat(), "timeZone": EASTERN.key,
        "source": {
            "name": "CityBikes archive", "url": archive_url,
            "credit": "Bike-share data by CityBikes contributors and available from https://data.citybik.es.",
            "license": "ODbL 1.0 (CityBikes database and this derived replay)",
            "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
            "operatorTerms": "https://capitalbikeshare.com/data-license-agreement",
            "archiveSha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
            "stationCodesFrom": code_url, "maxAgeSeconds": FRESHNESS_SECONDS,
            "method": "Latest archived change captured by each five-minute checkpoint; supplier report at most 15 minutes old. "
                      "Only physical stations renting and accepting returns with usable bikes or docks. Missing stations are unknown. "
                      "Names and coordinates come from the archive. Station codes use exact, unique names from earlier trips.",
        },
        "stations": stations, "frames": frames,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", type=date.fromisoformat, default=date(2026, 9, 24))
    parser.add_argument("--cache-dir", type=Path, help="Reuse downloaded month files in this directory")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    with TemporaryDirectory() as temp:
        cache = args.cache_dir or Path(temp)
        cache.mkdir(parents=True, exist_ok=True)
        month = args.date.strftime("%Y%m")
        filename = f"{month}-capital-bikeshare-stats.parquet"
        archive_url = f"https://data.citybik.es/dumps/by-network/{args.date.year}/{filename}"
        archive_path = cache / filename
        if not archive_path.exists():
            with TemporaryDirectory(dir=cache) as staging:
                partial = Path(staging) / filename
                urllib.request.urlretrieve(archive_url, partial)
                partial.replace(archive_path)
        trip_files = published_files(args.date - timedelta(days=1))
        prior = max(m for m in trip_files if m < args.date.strftime("%Y-%m"))
        trip = trip_files[prior]
        codes = station_codes(local_zip(trip, cache))
        replay = build(args.date, archive_path, archive_url, codes, trip["url"])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(replay, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(replay['stations'])} stations, {len(replay['frames'])} five-minute frames in {args.output}")


if __name__ == "__main__":
    main()
