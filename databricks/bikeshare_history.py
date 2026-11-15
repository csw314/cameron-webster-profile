# Databricks notebook source
# MAGIC %md
# MAGIC # Capital Bikeshare station history
# MAGIC Run in a Unity Catalog schema where you can create tables. Each run ingests
# MAGIC the built-in commute and the recent published recordings. A daily job can
# MAGIC retain sessions beyond the public index's three-day window. The website
# MAGIC can serve visitors independently of this workspace.
# MAGIC
# MAGIC Input timestamps are UTC epoch seconds. Demand slots use Washington local time.
# MAGIC The archived CityBikes session is an ODbL 1.0 derivative. See its embedded
# MAGIC attribution and operator terms. Bike-share data by CityBikes contributors
# MAGIC and available from https://data.citybik.es.

# COMMAND ----------

import hashlib
import json
import re
import urllib.request
from datetime import datetime, timezone

from pyspark.sql import functions as F

dbutils.widgets.text("catalog", spark.sql("SELECT current_catalog()").first()[0])
dbutils.widgets.text("schema", "bikeshare_portfolio")
catalog, schema = (dbutils.widgets.get(k) for k in ("catalog", "schema"))
if not all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) for name in (catalog, schema)):
    raise ValueError("Use a catalog and schema name containing letters, digits, or underscores.")
namespace = f"`{catalog}`.`{schema}`"
spark.conf.set("spark.sql.session.timeZone", "UTC")
spark.sql(f"CREATE SCHEMA IF NOT EXISTS {namespace}")

# COMMAND ----------

assets = "https://csw314.github.io/cameron-webster-profile/projects/bikeshare/data/"
recordings = "https://raw.githubusercontent.com/csw314/cameron-webster-profile/bikeshare-replays/"

def read_url(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read().decode("utf-8")

sources = [assets + "sample-replay.json"]
for entry in json.loads(read_url(recordings + "sessions.json"))["sessions"]:
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}\.json", entry["file"]):
        sources.append(recordings + entry["file"])
inputs = []
for url in sources:
    payload = read_url(url)
    replay = json.loads(payload)
    if replay["version"] != 1 or not replay["frames"]:
        raise ValueError(f"Invalid replay at {url}")
    inputs.append((hashlib.sha256(payload.encode()).hexdigest(), url,
                   datetime.now(timezone.utc), payload))
spark.createDataFrame(inputs, "digest string, source_url string, ingested_at timestamp, payload string"
                      ).createOrReplaceTempView("cabi_incoming")
spark.sql(f"""CREATE TABLE IF NOT EXISTS {namespace}.bikeshare_bronze
              (digest STRING, source_url STRING, ingested_at TIMESTAMP, payload STRING) USING DELTA""")
spark.sql(f"""MERGE INTO {namespace}.bikeshare_bronze b USING cabi_incoming i
              ON b.digest = i.digest WHEN NOT MATCHED THEN INSERT *""")

# COMMAND ----------

# Parse the same replay contract as the public app. A repeated source report may
# legitimately persist across checkpoints; each station counts once per checkpoint.
payload_type = """STRUCT<date:STRING,source:STRUCT<name:STRING>,
 stations:ARRAY<STRUCT<id:STRING,shortName:STRING,name:STRING,lat:DOUBLE,lon:DOUBLE>>,
 frames:ARRAY<STRUCT<ts:BIGINT,rows:ARRAY<ARRAY<BIGINT>>>>>"""
raw = spark.table(f"{namespace}.bikeshare_bronze").select(
    F.from_json("payload", payload_type).alias("r"), "ingested_at")
raw.select("r.source.name", "r.stations", F.explode("r.frames").alias("frame"), "ingested_at"
           ).selectExpr("name AS source", "stations", "frame.ts AS checkpoint",
                        "explode(frame.rows) AS counts", "ingested_at"
           ).selectExpr("source", "checkpoint", "stations[CAST(counts[0] AS INT)] AS station",
                        "CAST(counts[1] AS INT) AS bikes", "CAST(counts[2] AS INT) AS docks",
                        "counts[3] AS reported", "ingested_at"
           ).selectExpr("source", "checkpoint", "station.id AS station_id", "station.shortName AS code",
                        "station.name AS station_name", "station.lat", "station.lon", "bikes", "docks",
                        "reported", "ingested_at").createOrReplaceTempView("cabi_flat")

spark.sql(f"""CREATE TABLE IF NOT EXISTS {namespace}.bikeshare_silver (
    source STRING, checkpoint BIGINT, station_id STRING, code STRING, station_name STRING,
    lat DOUBLE, lon DOUBLE, bikes INT, docks INT, reported BIGINT, ingested_at TIMESTAMP)
    USING DELTA""")
spark.sql(f"""MERGE INTO {namespace}.bikeshare_silver s USING (
    SELECT source, checkpoint, station_id, code, station_name, lat, lon, bikes, docks, reported, ingested_at
    FROM (SELECT *, ROW_NUMBER() OVER (
      PARTITION BY source, checkpoint, station_id ORDER BY reported DESC, ingested_at DESC) AS n
      FROM cabi_flat WHERE bikes >= 0 AND docks >= 0 AND reported <= checkpoint) WHERE n = 1
  ) t ON s.source=t.source AND s.checkpoint=t.checkpoint AND s.station_id=t.station_id
  WHEN MATCHED AND (t.reported > s.reported OR
       (t.reported = s.reported AND t.ingested_at > s.ingested_at)) THEN UPDATE SET *
  WHEN NOT MATCHED THEN INSERT *""")

# COMMAND ----------

# The count makes incomplete 15-minute windows visible. Zero samples are unknown.
spark.sql(f"""CREATE OR REPLACE VIEW {namespace}.bikeshare_station_15m AS
  SELECT source, station_id, station_name,
    timestamp_seconds(CAST(FLOOR(checkpoint / 900) * 900 AS BIGINT)) AS window_start,
    COUNT(*) AS observations, MIN(bikes) AS min_bikes, MIN(docks) AS min_docks,
    AVG(bikes) AS mean_bikes, COUNT_IF(bikes = 0) AS empty_checkpoints,
    COUNT_IF(docks = 0) AS full_checkpoints
  FROM {namespace}.bikeshare_silver GROUP BY source, station_id, station_name, window_start""")

# COMMAND ----------

# Persist the fixed, dated demand baseline so the score view is reproducible.
profile = json.loads(read_url(assets + "demand.json"))
published = int(datetime.fromisoformat(profile["availableAt"].replace("Z", "+00:00")).timestamp())
profiles = [(code, [v/profile["scale"] for v in values], published)
            for code, values in profile["stations"].items()]
spark.createDataFrame(profiles, "code string, rates array<double>, published_epoch long"
                      ).createOrReplaceTempView("cabi_profile")
spark.sql(f"""CREATE TABLE IF NOT EXISTS {namespace}.bikeshare_demand
              (code STRING, rates ARRAY<DOUBLE>, published_epoch BIGINT) USING DELTA""")
spark.sql(f"""MERGE INTO {namespace}.bikeshare_demand d USING cabi_profile p
  ON d.code=p.code AND d.published_epoch=p.published_epoch
  WHEN NOT MATCHED THEN INSERT *""")

# COMMAND ----------

# Evaluate observed new shortages, including stations the alert rules missed.
# Build future labels before joining the profile; use only the as-of profile for
# the forecast. A full half hour consists of seven five-minute observations.
spark.sql(f"""CREATE OR REPLACE VIEW {namespace}.bikeshare_alert_scores AS
  WITH future AS (
    SELECT *, COUNT(*) OVER w AS checkpoints,
      MIN(bikes) OVER w AS next_min_bikes, MIN(docks) OVER w AS next_min_docks
    FROM {namespace}.bikeshare_silver
    WINDOW w AS (PARTITION BY source, station_id ORDER BY checkpoint
                 RANGE BETWEEN CURRENT ROW AND 1800 FOLLOWING)
  ), available AS (
    SELECT f.*, d.rates,
      from_utc_timestamp(timestamp_seconds(checkpoint),'America/New_York') AS local_start,
      from_utc_timestamp(timestamp_seconds(checkpoint+1800),'America/New_York') AS local_end,
      ROW_NUMBER() OVER (PARTITION BY f.source, f.station_id, f.checkpoint ORDER BY d.published_epoch DESC) AS n
    FROM future f JOIN {namespace}.bikeshare_demand d
      ON d.code=f.code AND d.published_epoch <= f.checkpoint WHERE f.checkpoints=7
  ), bins AS (
    SELECT *, IF(dayofweek(local_start) IN (1,7),48,0) + hour(local_start)*2
                 + INT(minute(local_start)/30) AS slot1,
              IF(dayofweek(local_end) IN (1,7),48,0) + hour(local_end)*2
                 + INT(minute(local_end)/30) AS slot2,
              (minute(local_start) % 30)/30.0 AS fraction
    FROM available WHERE n=1
  ), forecasts AS (
    SELECT *, rates[slot1]*(1-fraction) + rates[slot2]*fraction AS net FROM bins
  ), sides AS (
    SELECT source, checkpoint, bikes AS inventory, LEAST(bikes+docks, GREATEST(0, bikes-net)) AS projected,
       next_min_bikes=0 AS actual FROM forecasts
    UNION ALL
    SELECT source, checkpoint, docks AS inventory, LEAST(bikes+docks, GREATEST(0, docks+net)) AS projected,
       next_min_docks=0 AS actual FROM forecasts
  )
  SELECT source, timestamp_seconds(checkpoint) AS decision_time, COUNT(*) AS eligible_sides,
    COUNT_IF(actual) AS new_shortages, COUNT_IF(projected<=1) AS forecast_alerts,
    COUNT_IF(projected<=1 AND actual) AS forecast_hits, COUNT_IF(inventory<=3) AS baseline_alerts,
    COUNT_IF(inventory<=3 AND actual) AS baseline_hits
  FROM sides WHERE inventory>0 GROUP BY source, checkpoint""")
display(spark.table(f"{namespace}.bikeshare_alert_scores").orderBy(F.desc("decision_time")))
