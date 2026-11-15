import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {forecast, planTransfers, postTransferBikes, frameStations, decisionFrames, evaluate} from "../projects/bikeshare/dispatch.js";
import {liveSnapshot} from "../projects/bikeshare/feed.js";

const data = name => JSON.parse(readFileSync(new URL("../projects/bikeshare/data/"+name+".json",import.meta.url)));
const replay = data("sample-replay"), demand = data("demand");

test("bin weighting crosses Friday midnight into the weekend without future training data", () => {
  const rates = Array(96).fill(0);
  rates[47]=600; rates[48]=200;
  const p = {...demand,stations:{s:rates}};
  const station={id:"A",shortName:"s",bikes:7,docks:7};
  const [s]=forecast([station],Date.parse("2026-09-25T23:45:00-04:00")/1000,p);
  assert.equal(s.net,4);
  assert.equal(s.futureBikes,3);
  assert.equal(postTransferBikes(s,15,2),5);
  assert.throws(()=>forecast([station],Date.parse("2026-08-01")/1000,p),/postdates/);
});

test("feed join excludes closed, virtual, stale, duplicate and unknown stations",()=>{
  const ts=1790281800;
  const ids=["open","closed","stale","virtual","faulty"];
  const info={data:{stations:ids.map(id=>({station_id:id,name:id,lat:38.9,lon:-77,short_name:id,is_virtual_station:id==="virtual"}))}};
  const rows=ids.map(id=>({station_id:id,num_bikes_available:id==="faulty"?-1:1,num_docks_available:4,
    is_installed:1,is_renting:1,is_returning:id!=="closed",last_reported:ts-(id==="stale"?601:20)}));
  const snapshot=liveSnapshot(info,{last_updated:ts,ttl:90,data:{stations:[...rows,rows[0],{...rows[0],station_id:"unknown"}]}});
  assert.deepEqual(snapshot.stations.map(s=>s.id),["open"]); assert.equal(snapshot.ttl,90);
});

test("all archived plans protect inventory, available docks, crew time and truck capacity",()=>{
  for(const frame of replay.frames) {
    const stations=forecast(frameStations(replay,frame),frame.ts,demand);
    for(const capacity of [2,4,8,12]){
      const moves=planTransfers(stations,capacity);
      assert.ok(moves.length>0);
      assert.equal(new Set(moves.flatMap(m=>[m.from.id,m.to.id])).size,moves.length*2);
      for(const m of moves){
        assert.ok(m.from.modeled && m.to.modeled && m.bikes>0 && m.bikes<=capacity);
        assert.ok(m.bikes<=m.from.give && m.bikes<=m.to.take && m.minutes<=30);
        assert.ok(m.km>=0 && m.load<=m.minutes);
      }
    }
  }
});

test("replay compares both alert rules on identical observed station-sides",()=>{
  const i=8,f=replay.frames[i];
  const s=forecast(frameStations(replay,f),f.ts,demand);
  const m=planTransfers(s,8)[0];
  const e=evaluate(replay,i,s,m);
  assert.deepEqual([e.sides,e.eligible,e.model.events,e.model.hits,e.model.alerts,e.baseline.hits,e.baseline.alerts],
    [424,218,18,2,7,12,63]);
  assert.equal(e.events.length,e.model.events);
  assert.deepEqual(e.impact,{actualMinutes:35,simulatedMinutes:20,pickedUp:6,delivered:6});
  // Drop a checkpoint for a selected station. Its observed trajectory becomes unknown.
  const incomplete=structuredClone(replay);
  const target=replay.stations.findIndex(s=>s.id===m.from.id);
  const next=incomplete.frames[i+1];
  next.rows=next.rows.filter(row=>row[0]!==target);
  const missing=evaluate(incomplete,i,s,m);
  assert.equal(missing.impact,null);
  assert.equal(missing.eligible,e.eligible-1);
});

test("decision times require six subsequent five-minute checkpoints",()=>{
  assert.equal(decisionFrames(replay).length,13);
  const partial={frames:replay.frames.slice(0,7)};
  assert.deepEqual(decisionFrames(partial),[0]);
  partial.frames.splice(3,1);
  assert.deepEqual(decisionFrames(partial),[]);
});
