"""Record a DC evening dispatch replay. Optional raw output is for private analytics."""
import argparse
import gzip
import json
import math
import os
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo("America/New_York")
DISCOVERY = "https://gbfs.capitalbikeshare.com/gbfs/2.3/gbfs.json"
INTERVAL = 300
MAX_REPORT_AGE = 600


def fetch(url):
    request = Request(url, headers={"User-Agent": "CamWebster-DispatchPortfolio/1.0"})
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def endpoints():
    return {row["name"]: row["url"] for row in fetch(DISCOVERY)["data"]["en"]["feeds"]}


def compact(status, info, ts):
    """Join a source update already received at the decision time to station metadata."""
    if not 0 <= ts - status["last_updated"] <= MAX_REPORT_AGE:
        return []
    rows = {}
    for s in status["data"]["stations"]:
        station = info.get(s["station_id"])
        bikes, docks = s.get("num_bikes_available"), s.get("num_docks_available")
        reported = s.get("last_reported") or 0
        if (not station or station.get("is_virtual_station") or not s.get("is_installed")
                or not s.get("is_renting") or not s.get("is_returning")
                or not 0 <= ts - reported <= MAX_REPORT_AGE
                or any(type(n) is not int or n < 0 for n in (bikes, docks)) or bikes + docks == 0):
            continue
        rows[s["station_id"]] = [s["station_id"], bikes, docks, reported]
    return list(rows.values())


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as tmp:
        json.dump(data, tmp, ensure_ascii=False, separators=(",", ":"))
        tmp.write("\n")
    os.replace(tmp.name, path)


def save_raw(folder, kind, payload, received):
    if folder is None:
        return
    dest = folder / kind / f"{payload['last_updated']}.json.gz"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as tmp:
        with gzip.GzipFile(fileobj=tmp, mode="wb") as zipped:
            zipped.write(json.dumps({"received_at": received, **payload}, separators=(",", ":")).encode())
    os.replace(tmp.name, dest)


def capture(until, raw_dir, check=False):
    urls = endpoints()
    information = fetch(urls["station_information"])
    save_raw(raw_dir, "station_information", information, int(time.time()))
    info = {s["station_id"]: s for s in information["data"]["stations"]
            if s.get("name") and all(isinstance(s.get(k), (int, float)) for k in ("lat", "lon"))}
    frames = []
    next_grid = math.ceil(time.time() / INTERVAL) * INTERVAL
    next_poll = 0
    status = None
    while time.time() < until:
        if time.time() >= next_poll:
            try:
                new = fetch(urls["station_status"])
                received = int(time.time())
                if not status or new["last_updated"] > status["last_updated"]:
                    save_raw(raw_dir, "station_status", new, received)
                    # Preserve what the collector actually knew at a grid boundary
                    # crossed during the network request.
                    if next_grid < received and next_grid <= until:
                        if status:
                            rows = compact(status, info, next_grid)
                            if rows:
                                frames.append({"ts": next_grid, "rows": rows})
                        next_grid += INTERVAL
                    status = new
                next_poll = received + max(60, new.get("ttl", 60))
                if check:
                    now_rows = compact(new, info, received)
                    if not now_rows:
                        raise ValueError("No fresh eligible stations")
                    print(f"Joined {len(now_rows)} operating stations at {new['last_updated']}.")
                    return None
            except (OSError, KeyError, ValueError) as exc:
                if check:
                    raise
                print(f"Feed unavailable: {exc}", flush=True)
                next_poll = time.time() + 60
        if next_grid <= time.time() and next_grid <= until:
            rows = compact(status, info, next_grid) if status else []
            if rows:
                frames.append({"ts": next_grid, "rows": rows})
            next_grid += INTERVAL
        time.sleep(max(0, min(next_grid, next_poll, until) - time.time()))

    if not any(frames[i + 6]["ts"] - f["ts"] == 1800 for i, f in enumerate(frames[:-6])):
        raise RuntimeError("No continuous 30-minute observation window; previous replay retained.")
    ids = sorted({row[0] for f in frames for row in f["rows"]})
    indices = {station_id: i for i, station_id in enumerate(ids)}
    for f in frames:
        for row in f["rows"]:
            row[0] = indices[row[0]]
    stations = [{"id": key, "shortName": str(info[key].get("short_name", "")),
                 "name": info[key]["name"], "lat": info[key]["lat"], "lon": info[key]["lon"]} for key in ids]
    return {"version": 1, "date": datetime.fromtimestamp(frames[0]["ts"], EASTERN).date().isoformat(),
            "timeZone": str(EASTERN), "source": {"name": "Operator GBFS capture", "url": DISCOVERY,
            "maxAgeSeconds": MAX_REPORT_AGE}, "stations": stations, "frames": frames}


def publish_files(folder, record):
    # A single Actions job updates the retained files and index in one Git commit.
    file = record["date"] + ".json"
    index = folder / "sessions.json"
    entries = json.loads(index.read_text())["sessions"] if index.exists() else []
    entries = [s for s in entries if s["date"] != record["date"]]
    entries.append({"date": record["date"], "file": file})
    entries.sort(key=lambda s: s["date"], reverse=True)
    save_json(folder / file, record)
    save_json(index, {"version": 1, "sessions": entries[:3]})
    for old in entries[3:]:
        (folder / (old["date"] + ".json")).unlink(missing_ok=True)


def scheduled_window(now):
    """Keep the commute window when possible and give a delayed runner 40 minutes."""
    start = now.replace(hour=16, minute=29, second=0, microsecond=0)
    end = now.replace(hour=18, minute=0, second=5, microsecond=0)
    # Wait only for the ordinary early launch. A run delayed across midnight
    # must not sleep for most of the day and exhaust its GitHub job timeout.
    if start - timedelta(minutes=20) <= now < start:
        return start, end
    if start <= now and end - now >= timedelta(minutes=40):
        return now, end
    return now, now + timedelta(minutes=40)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path(".cache/bikeshare/replays"))
    parser.add_argument("--raw-dir", type=Path, help="Private folder for timestamped raw GBFS observations")
    parser.add_argument("--check", action="store_true", help="Validate one feed join and exit")
    parser.add_argument("--minutes", type=int, help="Capture a session starting now; default is 16:30–18:00 Eastern")
    args = parser.parse_args()
    now = datetime.now(EASTERN)
    start, end = scheduled_window(now)
    if args.minutes is not None:
        if args.minutes < 35:
            parser.error("--minutes must allow at least 35 minutes for seven five-minute checkpoints")
        start, end = now, now + timedelta(minutes=args.minutes)
    if not args.check:
        print(f"Recording {start.isoformat()} through {end.isoformat()}", flush=True)
        time.sleep(max(0, start.timestamp() - time.time()))
    result = capture(time.time() + 60 if args.check else end.timestamp(), args.raw_dir, args.check)
    if result:
        publish_files(args.out, result)
        print(f"Saved {len(result['frames'])} checkpoints for {result['date']}.")
