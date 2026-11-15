"""Build station half-hour demand estimates from Capital Bikeshare's public trip files.

Examples (from the repository root):
    python scripts/bikeshare/build_demand.py --as-of 2026-09-24
    python scripts/bikeshare/build_demand.py --months 2026-07 2026-08 --cache-dir /tmp/cabi-trips

Both the official CSVs and GBFS short_name use the operator's station codes.
Demand values are signed hundredths of a bike: departures minus arrivals per
weekday or weekend day at that local time. Zero-event days count in the mean.
"""

import argparse
import calendar
import csv
import io
import json
import re
import shutil
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BASE = "https://s3.amazonaws.com/capitalbikeshare-data/"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[2] / "projects/bikeshare/data/demand.json"
MONTH_FILE = re.compile(r"^(\d{4})(\d{2})-capitalbikeshare-tripdata\.zip$")
NS = {"s": "http://s3.amazonaws.com/doc/2006-03-01/"}


def published_files(as_of):
    """Only files that were already published on the requested date (UTC)."""
    url = BASE + "?list-type=2"
    entries = {}
    while True:
        with urllib.request.urlopen(url, timeout=60) as response:
            root = ET.parse(response).getroot()
        for item in root.findall("s:Contents", NS):
            key = item.findtext("s:Key", namespaces=NS)
            match = MONTH_FILE.fullmatch(key)
            modified = item.findtext("s:LastModified", namespaces=NS)
            if match and modified[:10] <= as_of.isoformat():
                month = "-".join(match.groups())
                entries[month] = {
                    "month": month,
                    "url": BASE + key,
                    "publishedAt": modified,
                    "bytes": int(item.findtext("s:Size", namespaces=NS)),
                }
        token = root.findtext("s:NextContinuationToken", namespaces=NS)
        if not token:
            return entries
        url = BASE + "?list-type=2&continuation-token=" + urllib.parse.quote(token, safe="")


def local_zip(source, cache):
    path = cache / source["url"].rsplit("/", 1)[1]
    if not path.exists() or path.stat().st_size != source["bytes"]:
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as tmp:
            partial = Path(tmp.name)
            try:
                with urllib.request.urlopen(source["url"], timeout=120) as response:
                    shutil.copyfileobj(response, tmp)
                if tmp.tell() != source["bytes"]:
                    raise ValueError(f"Incomplete trip archive: {source['url']}")
                tmp.close()
                partial.replace(path)
            finally:
                partial.unlink(missing_ok=True)
    return path


def day_types(months):
    days = {}
    for month in months:
        first = date.fromisoformat(month + "-01")
        for i in range(calendar.monthrange(first.year, first.month)[1]):
            day = first + timedelta(days=i)
            days[day.isoformat()] = 48 if day.weekday() >= 5 else 0
    return days


def accumulate(path, bins, days, seen):
    counts = {"rows": 0, "duplicateRides": 0, "departures": 0, "arrivals": 0}
    with zipfile.ZipFile(path) as archive:
        names = [n for n in archive.namelist() if n.endswith(".csv") and "__MACOSX" not in n]
        if not names:
            raise ValueError(f"No trip CSV in {path}")
        for filename in sorted(names):
            with archive.open(filename) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as stream:
                for row in csv.DictReader(stream):
                    counts["rows"] += 1
                    ride_id = row["ride_id"]
                    if ride_id in seen:
                        counts["duplicateRides"] += 1
                        continue
                    if not ride_id:
                        raise ValueError(f"Missing ride ID in {filename}")
                    seen.add(ride_id)
                    for station_col, time_col, sign, counter in (
                        ("start_station_id", "started_at", 1, "departures"),
                        ("end_station_id", "ended_at", -1, "arrivals"),
                    ):
                        code = row[station_col].strip()
                        when = row[time_col]
                        offset = days.get(when[:10])
                        if code and offset is not None:
                            slot = int(when[11:13]) * 2 + int(when[14:16]) // 30
                            bins[code][offset + slot] += sign
                            counts[counter] += 1
    return counts


def build(months, files, cache):
    days = day_types(months)
    weekdays = sum(offset == 0 for offset in days.values())
    weekends = len(days) - weekdays
    bins = defaultdict(lambda: [0] * 96)
    seen = set()
    sources = []
    for month in months:
        source = files[month]
        counts = accumulate(local_zip(source, cache), bins, days, seen)
        sources.append({**source, **counts})
        print(f"{month}: {counts['rows']:,} trip rows", flush=True)
    return {
        "version": 1,
        "timeZone": "America/New_York",
        "binMinutes": 30,
        "scale": 100,
        "months": months,
        "period": {"start": min(days), "end": max(days)},
        "availableAt": max(x["publishedAt"] for x in sources),
        "dayCounts": {"weekday": weekdays, "weekend": weekends},
        "rides": len(seen),
        "sources": sources,
        "stations": {
            code: [round(n * 100 / (weekdays if i < 48 else weekends)) for i, n in enumerate(values)]
            for code, values in sorted(bins.items())
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--months", nargs="+", help="Explicit published months, such as 2026-07 2026-08")
    parser.add_argument("--as-of", type=date.fromisoformat, default=datetime.now(timezone.utc).date(),
                        help="Use only files published by this UTC date. Default: today.")
    parser.add_argument("--cache-dir", type=Path, help="Keep downloaded ZIP files here for reuse")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    files = published_files(args.as_of)
    months = sorted(args.months) if args.months else sorted(files)[-2:]
    if not months or len(set(months)) != len(months) or any(m not in files for m in months):
        parser.error("Requested months must be distinct and available by --as-of")
    if args.cache_dir:
        args.cache_dir.mkdir(parents=True, exist_ok=True)
        result = build(months, files, args.cache_dir)
    else:
        with tempfile.TemporaryDirectory() as cache:
            result = build(months, files, Path(cache))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {len(result['stations']):,} station profiles; {result['rides']:,} distinct rides.")


if __name__ == "__main__":
    main()
