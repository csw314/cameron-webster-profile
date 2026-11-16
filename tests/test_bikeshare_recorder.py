"""Check the recorder's clock, unknown observations, and rolling-publication contract."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.bikeshare import collect


class RecorderTests(unittest.TestCase):
    def test_delayed_schedule(self):
        from datetime import datetime, timedelta
        for stamp in ["2026-11-15T17:29:59", "2026-11-15T20:04:36", "2026-11-16T01:05:00"]:
            now = datetime.fromisoformat(stamp).replace(tzinfo=collect.EASTERN)
            start, end = collect.scheduled_window(now)
            self.assertEqual(start, now)
            self.assertEqual(end - start, timedelta(minutes=40))
        now = now.replace(hour=16, minute=17)
        start, end = collect.scheduled_window(now)
        self.assertEqual((start.hour, start.minute, end.hour), (16, 29, 18))

    def test_time_grid_and_feed_deduplication(self):
        clock = [1_800_000_001]
        station = {"station_id": "A", "short_name": "42", "name": "First", "lat": 38.9, "lon": -77.0}
        row = {"station_id": "A", "is_installed": 1, "is_renting": 1, "is_returning": 1,
               "num_bikes_available": 2, "num_docks_available": 1}

        def fake_fetch(url):
            if url == "info":
                return {"last_updated": clock[0], "data": {"stations": [station]}}
            # The feed changes every two minutes while its TTL is one minute.
            source_ts = int(clock[0] // 120 * 120)
            return {"last_updated": source_ts, "ttl": 60,
                    "data": {"stations": [{**row, "last_reported": source_ts}]}}

        def sleep(seconds):
            clock[0] += seconds

        with patch.object(collect, "endpoints", return_value={"station_information": "info", "station_status": "status"}), \
             patch.object(collect, "fetch", side_effect=fake_fetch), \
             patch.object(collect.time, "time", side_effect=lambda: clock[0]), \
             patch.object(collect.time, "sleep", side_effect=sleep):
            with tempfile.TemporaryDirectory() as tmp:
                study = collect.capture(clock[0] + 2400, Path(tmp))
                raw = list((Path(tmp) / "station_status").glob("*.json.gz"))
        self.assertEqual(len(raw), 20)
        self.assertEqual([f["ts"] for f in study["frames"]], list(range(1800000300, 1800002401, 300)))
        for f in study["frames"]:
            index, bikes, docks, reported = f["rows"][0]
            self.assertEqual((index, bikes, docks), (0, 2, 1))
            self.assertLessEqual(reported, f["ts"])
        self.assertEqual(study["stations"][0]["shortName"], "42")

    def test_index_handles_retries_and_retains_three_sessions(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            for n in [1, 2, 3, 3, 4]:
                collect.publish_files(folder, {"date": f"2026-11-{n:02}"})
            sessions = json.loads((folder / "sessions.json").read_text())["sessions"]
            self.assertEqual([s["date"] for s in sessions], ["2026-11-04", "2026-11-03", "2026-11-02"])
            self.assertEqual(len(list(folder.glob("2026*.json"))), 3)
            self.assertTrue(all((folder / s["file"]).exists() for s in sessions))

    def test_old_feed_does_not_become_a_new_observation(self):
        self.assertEqual(collect.compact({"last_updated": 100, "data": {"stations": []}}, {}, 800), [])
