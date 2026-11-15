// The operator's public GBFS 2.3 discovery document supplies the actual feed URLs.
export const DISCOVERY_URL = "https://gbfs.capitalbikeshare.com/gbfs/2.3/gbfs.json";
const DATA_ORIGIN = "https://raw.githubusercontent.com/csw314/cameron-webster-profile/bikeshare-replays/";
const LIVE_MAX_AGE = 600;
let metadata;
let metadataExpires = 0;
let endpoints;

export async function json(url, options = {}) {
  const response = await fetch(url, {signal: AbortSignal.timeout(15000), ...options});
  if (!response.ok) throw Error(`Data source returned HTTP ${response.status}.`);
  return response.json();
}

function validPoint(s) {
  return Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.name && s.station_id;
}

export function liveSnapshot(info, status) {
  const ts = status.last_updated;
  if (!Number.isInteger(ts) || ts > Date.now() / 1000 + 120) throw Error("Invalid operator timestamp.");
  const byId = new Map(info.data.stations.filter(validPoint).map(s => [s.station_id, s]));
  const stations = [];
  const seen = new Set();
  for (const row of status.data.stations) {
    const s = byId.get(row.station_id);
    const bikes = row.num_bikes_available, docks = row.num_docks_available;
    if (!s || seen.has(s.station_id) || !row.is_installed || !row.is_renting || !row.is_returning ||
        s.is_virtual_station || !(row.last_reported > 0) || row.last_reported > ts + 60 ||
        ts - row.last_reported > LIVE_MAX_AGE || ![bikes, docks].every(n => Number.isInteger(n) && n >= 0) ||
        bikes + docks === 0) continue;
    stations.push({id: s.station_id, shortName: String(s.short_name ?? ""), name: s.name,
      lat: s.lat, lon: s.lon, bikes, docks, reported: row.last_reported});
    seen.add(s.station_id);
  }
  if (!stations.length) throw Error("No recent operating stations in the operator response.");
  return {ts, stations, ttl: Math.max(Number(status.ttl) || 0, 60), total: byId.size};
}

export async function fetchLive() {
  if (!metadata || Date.now() >= metadataExpires) {
    const index = await json(DISCOVERY_URL);
    const feeds = index.data.en.feeds;
    endpoints = Object.fromEntries(feeds.map(f => [f.name, f.url]));
    const [info, status] = await Promise.all([json(endpoints.station_information),
      json(endpoints.station_status, {cache: "no-cache"})]);
    const snapshot = liveSnapshot(info, status);
    metadata = info;
    metadataExpires = Date.now() + 3600000;
    return snapshot;
  }
  return liveSnapshot(metadata, await json(endpoints.station_status, {cache: "no-cache"}));
}

export function replayURL(filename) {
  if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(filename)) throw Error("Invalid replay filename.");
  return DATA_ORIGIN + filename;
}

export async function latestSessions() {
  const manifest = await json(DATA_ORIGIN + "sessions.json", {cache: "no-cache"});
  return manifest.sessions.filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.file === s.date + ".json")
    .sort((a, b) => b.date.localeCompare(a.date));
}
