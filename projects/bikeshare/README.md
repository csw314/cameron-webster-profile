# Capital Bikeshare dispatch

Choose a bike transfer for one truck operating in the Washington region. [Open the dashboard](https://csw314.github.io/cameron-webster-profile/projects/bikeshare/).

## Live network

The browser discovers the operator's GBFS 2.3 feeds, joins station information to status by station ID, and reads bikes, open docks, operating flags, and source timestamps. Automatic updates respect the feed TTL with a one-minute minimum and stop while the page is hidden. The UTC source timestamp is displayed in Eastern time. The last received snapshot stays dated and visibly labeled on refresh failure. Only physical stations open for pickup and return with usable inventory and reports no more than ten minutes old enter the live board. All eligible inventory counts toward the headline metrics. A match to historical demand is required for dispatch. [Operator system data](https://capitalbikeshare.com/system-data) · [GBFS discovery](https://gbfs.capitalbikeshare.com/gbfs/2.3/gbfs.json)

The dependency-free map uses actual station coordinates and locally served, simplified TIGER/Line roads, waterways, and DC boundaries. A and B mark pickup and drop-off. The dashed line connects endpoints. Search, tap a station, pan, zoom, or fit the network. Street geometry uses 2024 Census ROADS (named local streets near stations), PRISECROADS, AREAWATER and COUNTY shapefiles. Local street lines are delta encoded at four decimal places to reduce transfer size. [US Census Bureau TIGER/Line](https://www2.census.gov/geo/tiger/TIGER2024/)

## Demand and dispatch decisions

The bundled baseline was built from 1,299,753 distinct rides across July and August 2026. Group station-coded departures and arrivals separately by operator terminal code, local half hour, and weekday/weekend. Divide the net counts by all eligible days, including zero-event days. GBFS short codes link live UUIDs to terminal IDs in trip history. Missing dockless endpoints contribute no station counts. The exact source URLs, publication dates, filters' row counts and denominators are in `data/demand.json`. Both training months were publicly available by September 9, before the built-in replay.

For a 30-minute decision, weight net departures by the overlap with each local half-hour bin. Subtract the result from available bikes, bounding the projection by usable bike-plus-dock inventory. This is a historical average. Events, weather, traffic and differences between e-bikes and classic bikes can change actual conditions.

* Flag pickup or drop-off pressure if the current or projected inventory falls to the station reserve (up to three bikes or docks). Restore up to 30% of usable slots, rounded up and capped at 12 bikes.
* Preserve the donor's bike reserve and the receiver's dock reserve. Bound the transfer by both endpoints and the selected vehicle capacity.
* Estimate distance as 1.3 × geographic distance, speed as 18 km/h, and handling time at each end as two minutes plus 30 seconds per bike. Start the clock at the donor. Discard moves over 30 minutes.
* Rank feasible pairs by units restored toward each endpoint's target plus a two-unit priority bonus for each currently empty/full affected end, divided by crew minutes. Display up to five alternatives with distinct endpoints. Select one transfer for the truck. The display estimates post-transfer inventory at each stop using demand before and after the crew's arrival.

## Recorded commutes

The built-in September 24, 2026 replay covers 4:30–6:00 p.m. Eastern. Nineteen five-minute checkpoints use operator reports found in the CityBikes change archive. The importer uses the most recent change known by each checkpoint, discards stale or closed stations and limits supplier report age to 15 minutes. Historical coordinates and names come from the archive. Exact, unambiguous names in an earlier trip file recover terminal IDs for the demand join. The default decision time is 5:10 p.m. when available.

The daily [GitHub Actions recorder](../../.github/workflows/bikeshare.yml) starts at 4:17 p.m. Eastern for a target 4:30–6:00 p.m. session. It polls the live status feed at its TTL, deduplicates source updates, and samples them onto five-minute checkpoints. Late runner starts shorten the available session. A capture without a continuous 30-minute window fails while preserving the previous recordings. Sessions and their index are published together to the separate [bikeshare-replays branch](https://github.com/csw314/cameron-webster-profile/tree/bikeshare-replays). Its index retains the three most recent dates. The replay menu defaults to the latest previous date when available and shows the actual date on every recording. The built-in session also works while new captures accumulate. A manual workflow dispatch records 65 minutes starting at invocation.

Each forecast sees only its decision checkpoint and the previously published trip baseline. **Show 30-minute outcome** reveals observed station-side events at six later checkpoints. Precision is true alerts / alerts. Recall is true alerts / newly empty or full station-sides. The table compares a one-bike-or-dock projected threshold to a current-stock threshold of three, on identical eligible station-sides. Coverage requires a trip-history match, a positive starting count on that side, and observations at all seven checkpoints. An unavailable reading stays unknown.

For the selected pair, simulate the same observed bike-count changes from checkpoint to checkpoint. Apply pickup and drop-off at the first checkpoint at or after each estimated event time. Bound loading by stock and delivery by available docks. Count the minutes each endpoint is empty or full, with the left observation held over each five-minute interval. Compare the observed and simulated totals. The simulation cannot recover people who walked away, latent demand, actual driver routes or staff interventions.

## Run and reproduce

From the repository root:

```sh
npm run dev
node --test tests/bikeshare.test.mjs
python -m unittest discover -s tests -p test_bikeshare_recorder.py
python scripts/bikeshare/collect.py --check
```

Open `/projects/bikeshare/` on the dev server. The site requires no API key or application server. To record a private session and retain raw source updates for analysis:

```sh
python scripts/bikeshare/collect.py --minutes 65 --raw-dir .cache/bikeshare/raw
```

Rebuild the study's fixed training baseline and historical example:

```sh
python scripts/bikeshare/build_demand.py --months 2026-07 2026-08 --cache-dir .cache/bikeshare/sources
python -m pip install duckdb==2.0.0
python scripts/bikeshare/import_replay.py --date 2026-09-24 --cache-dir .cache/bikeshare/sources
```

A later baseline must have a publication date before any replay that uses it. Keep the original model available when adding more recent training data.

## Databricks

Open [the source notebook](../../databricks/bikeshare_history.py) in a Databricks Git folder or import it as a Python notebook. Choose a writable Unity Catalog catalog/schema in its widgets and run it on compute with public HTTPS access. The notebook ingests the published replay documents into a bronze Delta table, merges station observations into a silver Delta table, and exposes 15-minute availability summaries and a point-in-time alert evaluation view. A daily run preserves captures beyond the public dashboard's rolling index. Repeated runs deduplicate identical payloads and checkpoints. The public dashboard and recorder operate independently of Databricks.

## Attribution

This independent, noncommercial analysis uses data provided by Capital Bikeshare under its [Data License Agreement](https://capitalbikeshare.com/data-license-agreement).

Bike-share data by CityBikes contributors and available from https://data.citybik.es. The derived September replay database is provided under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Its source URL, checksum, attribution, reconstruction assumptions and operator terms are included in the replay file. [Historical Parquet source](https://data.citybik.es/dumps/by-network/2026/202609-capital-bikeshare-stats.parquet)
