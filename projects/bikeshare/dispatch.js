// Both live and replay decisions use this file. Forecasts only see the decision frame.
export const HORIZON = 30;
const BUFFER = 3;
const clock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit",
  second: "2-digit", hourCycle: "h23",
});
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function demandWeights(start, minutes) {
  const weights = [];
  const end = start + minutes * 60;
  for (let t = start; t < end;) {
    const parts = Object.fromEntries(clock.formatToParts(t * 1000).map(p => [p.type, p.value]));
    const minute = Number(parts.minute);
    const slot = Number(parts.hour) * 2 + Math.floor(minute / 30);
    const index = slot + (["Sat", "Sun"].includes(parts.weekday) ? 48 : 0);
    const seconds = Math.min(end - t, 1800 - (minute % 30) * 60 - Number(parts.second));
    weights.push([index, seconds / 1800]);
    t += seconds;
  }
  return weights;
}

export function forecast(stations, ts, demand) {
  if (Date.parse(demand.availableAt) > ts * 1000) throw Error("Trip baseline postdates this observation.");
  const weights = demandWeights(ts, HORIZON);
  return stations.map(station => {
    const history = demand.stations[station.shortName];
    const flows = weights.map(([i,w]) => ({minutes: HORIZON*w, rate: history ? history[i]/demand.scale/HORIZON : 0}));
    const net = flows.reduce((sum, f) => sum + f.minutes * f.rate, 0);
    const slots = station.bikes + station.docks;
    const futureBikes = clamp(station.bikes - net, 0, slots);
    const futureDocks = slots - futureBikes;
    const lowBikes = Math.min(station.bikes, futureBikes);
    const lowDocks = Math.min(station.docks, futureDocks);
    // Leave a reserve on both sides of a move, including at small stations.
    const reserve = Math.min(BUFFER, Math.floor(slots / 2));
    const target = Math.min(Math.ceil(slots * 0.3), 12);
    return {...station, modeled: Boolean(history), slots, flows, net, futureBikes, futureDocks,
      give: Math.max(0, Math.floor(lowBikes - reserve)),
      take: Math.max(0, Math.floor(lowDocks - reserve)),
      needBikes: lowBikes <= reserve ? Math.max(0, Math.ceil(target - lowBikes)) : 0,
      needDocks: lowDocks <= reserve ? Math.max(0, Math.ceil(target - lowDocks)) : 0};
  });
}

// A transfer can only change inventory after the crew reaches the station.
export function postTransferBikes(station, minute, quantity) {
  let demandBefore = 0, elapsed = 0;
  for (const flow of station.flows) {
    demandBefore += clamp(minute - elapsed, 0, flow.minutes) * flow.rate;
    elapsed += flow.minutes;
  }
  const atArrival = clamp(station.bikes - demandBefore, 0, station.slots);
  const afterTransfer = clamp(atArrival + quantity, 0, station.slots);
  return clamp(afterTransfer - (station.net - demandBefore), 0, station.slots);
}

function distanceKm(a, b) {
  const radians = Math.PI / 180;
  const dx = (a.lon - b.lon) * Math.cos((a.lat + b.lat) * radians / 2);
  return 111.195 * Math.hypot(dx, a.lat - b.lat);
}

export function planTransfers(stations, truckCapacity) {
  const donors = stations.filter(s => s.modeled && s.give > 0);
  const receivers = stations.filter(s => s.modeled && s.take > 0);
  const moves = [];
  for (const from of donors) {
    for (const to of receivers) {
      const need = Math.max(from.needDocks, to.needBikes);
      if (!need || from.id === to.id) continue;
      const bikes = Math.min(truckCapacity, from.give, to.take, need);
      const km = distanceKm(from, to) * 1.3; // Road-distance approximation, no traffic data.
      const load = 2 + 0.5 * bikes;
      const minutes = Math.ceil(load * 2 + km / 18 * 60);
      if (minutes > HORIZON) continue;
      const relief = Math.min(bikes, from.needDocks) + Math.min(bikes, to.needBikes);
      const urgency = Number(from.docks === 0) + Number(to.bikes === 0);
      moves.push({from, to, bikes, km, load, minutes, score: (relief + 2 * urgency) / minutes});
    }
  }
  moves.sort((a, b) => b.score - a.score || a.minutes - b.minutes ||
    a.from.id.localeCompare(b.from.id) || a.to.id.localeCompare(b.to.id));
  // Show alternatives for a single truck, with distinct endpoints for easy comparison.
  const used = new Set();
  const queue = [];
  for (const move of moves) {
    if (used.has(move.from.id) || used.has(move.to.id)) continue;
    queue.push(move);
    used.add(move.from.id);
    used.add(move.to.id);
    if (queue.length === 5) break;
  }
  return queue;
}

export function frameStations(record, frame) {
  return frame.rows.map(([index, bikes, docks, reported]) => ({
    ...record.stations[index], bikes, docks, reported,
  }));
}

export function decisionFrames(record) {
  const {frames} = record;
  // Only offer decisions with an uninterrupted half hour of observations ahead.
  return frames.flatMap((frame, i) => {
    const end = frame.ts + HORIZON * 60;
    for (let j = i + 1; j < frames.length; j++) {
      if (frames[j].ts - frames[j - 1].ts !== 300) break;
      if (frames[j].ts >= end) return [i];
    }
    return [];
  });
}

function observationWindow(record, index) {
  const end = record.frames[index].ts + HORIZON * 60;
  const window = [];
  for (let i = index; i < record.frames.length; i++) {
    const frame = record.frames[i];
    if (i > index && frame.ts - record.frames[i - 1].ts !== 300) break;
    if (frame.ts > end) break;
    const byId = new Map(frame.rows.map(([j, bikes, docks]) => [record.stations[j].id, {bikes, docks}]));
    window.push({ts: frame.ts, byId});
  }
  return window;
}

function summarize(stats) {
  const lead = stats.leads.sort((a, b) => a - b);
  const mid = Math.floor(lead.length / 2);
  return {...stats, precision: stats.alerts ? stats.hits / stats.alerts : null,
    recall: stats.events ? stats.hits / stats.events : null,
    median: lead.length ? (lead[mid] + lead[Math.floor((lead.length - 1) / 2)]) / 2 : null};
}

export function evaluate(record, index, stations, selected) {
  const window = observationWindow(record, index);
  const start = window[0].ts;
  const end = start + HORIZON * 60;
  const outcomes = [0, 1].map(() => ({alerts: 0, hits: 0, events: 0, leads: []}));
  let eligible = 0;
  let sides = 0;
  const events = [];
  for (const station of stations) {
    if (!station.modeled) continue;
    const series = window.map(frame => frame.byId.get(station.id));
    if (series.some(row => !row)) continue;
    eligible++;
    for (const [side, after] of [["bikes", station.futureBikes], ["docks", station.futureDocks]]) {
      if (station[side] === 0) continue; // Only new empty/full events are targets.
      sides++;
      const first = series.findIndex(row => row[side] === 0);
      const alerts = [after <= 1, station[side] <= 3];
      if (first !== -1) events.push({name: station.name, side, ts: window[first].ts, alerted: alerts[0]});
      for (const [i, stats] of outcomes.entries()) {
        if (first !== -1) stats.events++;
        if (!alerts[i]) continue;
        stats.alerts++;
        if (first !== -1) {
          stats.hits++;
          stats.leads.push((window[first].ts - start) / 60);
        }
      }
    }
  }

  let impact = null;
  if (selected && window.every(f => f.byId.has(selected.from.id) && f.byId.has(selected.to.id))) {
    // Apply the observed interval changes to two counterfactual station inventories.
    // A transfer can worsen service at the donor. Both stations count in the metric.
    const ids = [selected.from.id, selected.to.id];
    const modeled = ids.map(id => window[0].byId.get(id).bikes);
    let actualMinutes = 0, simulatedMinutes = 0, pickedUp = 0, delivered = 0;
    let didPick = false, didDrop = false;
    for (let i = 0; i < window.length; i++) {
      const f = window[i];
      const observed = ids.map(id => f.byId.get(id));
      const slots = observed.map(s => s.bikes + s.docks);
      if (i) ids.forEach((id, k) => {
        const delta = observed[k].bikes - window[i - 1].byId.get(id).bikes;
        modeled[k] = clamp(modeled[k] + delta, 0, slots[k]);
      });
      // A move takes effect at the first sample at or after its estimated event time.
      if (!didPick && f.ts >= start + selected.load * 60) {
        pickedUp = Math.min(selected.bikes, modeled[0]);
        modeled[0] -= pickedUp;
        didPick = true;
      }
      if (!didDrop && didPick && f.ts >= start + selected.minutes * 60) {
        delivered = Math.min(pickedUp, slots[1] - modeled[1]);
        modeled[1] += delivered;
        didDrop = true;
      }
      const minutes = ((window[i + 1]?.ts ?? end) - f.ts) / 60;
      observed.forEach((s, k) => {
        if (s.bikes === 0 || s.docks === 0) actualMinutes += minutes;
        if (modeled[k] === 0 || modeled[k] === slots[k]) simulatedMinutes += minutes;
      });
    }
    impact = {actualMinutes, simulatedMinutes, pickedUp, delivered};
  }
  const traces = selected ? window.map(f => ({ts: f.ts, pickup: f.byId.get(selected.from.id)?.bikes,
    drop: f.byId.get(selected.to.id)?.bikes})) : [];
  return {model: summarize(outcomes[0]), baseline: summarize(outcomes[1]), eligible, sides, impact,
    events: events.sort((a,b) => a.ts-b.ts || a.name.localeCompare(b.name)), traces};
}
