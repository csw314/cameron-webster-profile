import {forecast, postTransferBikes, planTransfers, frameStations, decisionFrames, evaluate, HORIZON} from "./dispatch.js?v=1";
import {fetchLive, json, latestSessions, replayURL} from "./feed.js?v=1";
import {StationMap} from "./map.js?v=1";

const el = id => document.getElementById(id);
const num = new Intl.NumberFormat("en-US");
const time = new Intl.DateTimeFormat("en-US", {timeZone:"America/New_York", hour:"numeric", minute:"2-digit"});
const day = new Intl.DateTimeFormat("en-US", {timeZone:"America/New_York", month:"short", day:"numeric", year:"numeric"});
const dcDate = new Intl.DateTimeFormat("en-CA", {timeZone:"America/New_York", year:"numeric",month:"2-digit",day:"2-digit"});
const timeKey = new Intl.DateTimeFormat("en-GB",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
const archive = {date: "2026-09-24", file: "data/sample-replay.json"};
const map = new StationMap(el("map"), station => inspect(station));
let mode = "live", generation = 0, timer, live, record, snapshot, demand, demandRequest;
let times = [], frameIndex = 0, stations = [], moves = [], choice = 0, inspected;
let showOutcome = false, sessions = [archive];

function node(tag, content, className) {
  const item = document.createElement(tag);
  if (content != null) item.textContent = content;
  if (className) item.className = className;
  return item;
}
function notice(message) {
  el("notice").textContent = message;
  el("notice").hidden = !message;
}
function stamp(ts) { return day.format(ts*1000) + " · " + time.format(ts*1000) + " ET"; }
function source(label, detail, status) {
  el("source-state").textContent = label;
  el("snapshot-time").textContent = detail;
  el("lamp").className = "source-lamp " + status;
}
function loadDemand() {
  if (!demandRequest) {
    demandRequest = json("data/demand.json").then(data => {
      if (data.binMinutes !== 30 || data.scale <= 0 || !data.stations) throw Error("Invalid demand baseline.");
      demand = data;
      el("demand-note").textContent = `The baseline uses ${num.format(data.rides)} trips from ${data.period.start} through ${data.period.end}. It averages station departures minus arrivals separately for weekdays and weekends, including zero-event days, and weights the half-hour bins by overlap with the forecast. Stations without a history match count toward inventory only.`;
      return data;
    }).catch(err => { demandRequest = null; throw err; });
  }
  return demandRequest;
}

function inspect(s, center = false) {
  inspected = s?.id;
  if (!s) {
    el("station-readout").textContent = "Select a station on the map or search by name.";
    el("station-search").value = "";
    map.inspect(null);
    return;
  }
  el("station-search").value = s.name;
  const future = s.modeled ? `Forecast at +30 min: ${Math.round(s.futureBikes)} bikes.` : "Trip-history match unavailable.";
  el("station-readout").textContent = `${s.name} · ${s.bikes} bikes · ${s.docks} docks. ${future}`;
  map.inspect(s, center);
}

function updateLookup() {
  const list = document.createDocumentFragment();
  for (const station of [...stations].sort((a,b) => a.name.localeCompare(b.name))) {
    const option = node("option");
    option.value = station.name;
    option.label = station.shortName;
    list.append(option);
  }
  el("station-names").replaceChildren(list);
  el("station-search").disabled = !stations.length;
}

function drawQueue() {
  const list = document.createDocumentFragment();
  moves.forEach((move, i) => {
    const button = node("button", null, "move");
    button.type = "button";
    button.setAttribute("aria-pressed", String(i === choice));
    const names = node("span");
    names.append(node("span",move.from.name,"pair-name"),node("span","→ " + move.to.name,"pair-name"));
    const quantity = node("span",move.bikes + (move.bikes === 1 ? " bike" : " bikes"),"qty");
    quantity.append(node("small",move.minutes + " min"));
    button.append(node("span",String(i+1).padStart(2,"0"),"rank"),names,quantity);
    button.addEventListener("click",()=>selectMove(i,true));
    list.append(button);
  });
  if (!moves.length) list.append(node("p","No feasible moves meet the reserve, capacity, and 30-minute constraints in this snapshot.","placeholder"));
  el("queue").replaceChildren(list);
}

function currentCondition(move) {
  const {from,to} = move;
  if (from.docks === 0 && to.bikes === 0) return "The pickup is full and the destination is empty.";
  if (to.bikes === 0) return "The destination currently has no bikes to rent.";
  if (from.docks === 0) return "The pickup currently has no docks for returns.";
  if (to.needBikes && from.needDocks) return "This move builds a buffer for both renters and returning riders.";
  return to.needBikes ? "This move replenishes a station with a low bike supply." : "This move opens docks where return space is tight.";
}

function selectMove(i, fit) {
  choice = i;
  const move = moves[i];
  map.select(move,fit);
  el("fit-pair").disabled = !move;
  Array.from(el("queue").children).forEach((b,j) => {
    if (b.tagName === "BUTTON") b.setAttribute("aria-pressed",String(i===j));
  });
  if (!move) {
    el("brief").replaceChildren(node("p","There is no recommended transfer for this snapshot.","placeholder"));
    el("move-estimate").textContent = "";
  } else {
    el("move-estimate").textContent = `${move.km.toFixed(1)} km estimated · ${move.minutes} min including handling`;
    const body = node("div",null,"brief-body");
    const action = node("div");
    action.append(node("span","Truck assignment","leg"),node("h3",`Move ${move.bikes} ${move.bikes===1?"bike":"bikes"}`,"amount"),
      node("p",currentCondition(move)));
    body.append(action);
    for (const [letter,s,minute,quantity] of [
      ["A / Pick up",move.from,move.load,-move.bikes],
      ["B / Drop off",move.to,move.minutes,move.bikes],
    ]) {
      const after = postTransferBikes(s,minute,quantity);
      const end = node("div");
      const bar = node("div",null,"forecast-bar");
      const ink = node("i");
      ink.style.width = Math.min(100,Math.max(0,after / s.slots*100)) + "%";
      bar.append(ink);
      end.append(node("span",letter,"leg"),node("h3",s.name),
        node("p",`${s.bikes} bikes and ${s.docks} open docks now.`), bar,
        node("p",`+30 min forecast · ${Math.round(s.futureBikes)} bikes without transfer → ${Math.round(after)} with transfer.`));
      body.append(end);
    }
    el("brief").replaceChildren(body);
  }
  if (showOutcome && mode === "replay") drawOutcome();
}

function renderSnapshot(next, newContext = false) {
  const old = moves[choice];
  snapshot = next;
  stations = forecast(next.stations,next.ts,demand);
  moves = planTransfers(stations,Number(el("capacity").value));
  const same = newContext || !old ? -1 : moves.findIndex(m => m.from.id===old.from.id && m.to.id===old.to.id);
  choice = Math.max(0,same);
  el("k-stations").textContent = num.format(stations.length);
  el("k-bikes").textContent = num.format(stations.reduce((a,s)=>a+s.bikes,0));
  el("k-empty").textContent = num.format(stations.filter(s=>s.bikes===0).length);
  el("k-full").textContent = num.format(stations.filter(s=>s.docks===0).length);
  el("fit-network").disabled = false;
  map.inventory(stations);
  drawQueue();
  selectMove(choice, same < 0);
  if (!moves.length && newContext) map.fitNetwork();
  updateLookup();
  inspect(!newContext && stations.find(s=>s.id===inspected));
}

function clearBoard() {
  snapshot = null; moves = []; stations = [];
  for (const id of ["k-stations","k-bikes","k-empty","k-full"]) el(id).textContent = "—";
  el("queue").replaceChildren(node("p","Waiting for station inventory…","placeholder"));
  el("brief").replaceChildren(node("p","Choose a transfer to see the inventory forecast.","placeholder"));
  el("move-estimate").textContent = "";
  el("fit-pair").disabled = el("fit-network").disabled = true;
  map.inventory([]); map.select(null,false); updateLookup(); inspect(null);
}

function liveStatus() {
  const lag = (Date.now()/1000-live.ts)/60;
  source(lag>5 ? "Delayed operator snapshot" : "Operator feed",stamp(live.ts),lag>5 ? "warn" : "good");
  notice(lag>5 ? `The operator timestamp is ${Math.max(0,Math.floor(lag))} minutes old. Inventory and recommendations are as of the displayed time.` : "");
}
async function refresh() {
  if (mode !== "live") return;
  const ticket = ++generation;
  clearTimeout(timer);
  el("refresh").disabled = true;
  try {
    const [next] = await Promise.all([fetchLive(),loadDemand()]);
    if (ticket !== generation) return;
    if (live && next.ts < live.ts) throw Error("The feed returned an older observation.");
    live = next;
    renderSnapshot(live, !snapshot);
    liveStatus();
  } catch (err) {
    if (ticket !== generation) return;
    source(live ? "Last received snapshot" : "Operator feed unavailable",live ? stamp(live.ts) : "","warn");
    notice(`Live refresh failed. ${live ? "The last received snapshot is shown." : "Try the recorded commute or refresh the feed."}`);
    console.warn("Bikeshare feed:",err.message);
  } finally {
    if (ticket === generation && mode === "live") {
      el("refresh").disabled = false;
      if (!document.hidden) timer = setTimeout(refresh,(live?.ttl || 60)*1000);
    }
  }
}

function dateLabel(date) {
  return day.format(new Date(date + "T12:00:00Z"));
}
function sessionOptions() {
  el("session").replaceChildren(...sessions.map(s => {
    const o = node("option", dateLabel(s.date));
    o.value = s.file;
    return o;
  }));
}
function syncAddress() {
  const url = new URL(location.href);
  if (mode === "replay" && snapshot && record) {
    url.searchParams.set("replay",record.date);
    url.searchParams.set("at",timeKey.format(snapshot.ts*1000));
  } else {
    url.searchParams.delete("replay"); url.searchParams.delete("at");
  }
  if (!showOutcome && url.hash === "#outcome") url.hash = "";
  if (showOutcome) url.hash = "outcome";
  history.replaceState(null,"",url);
}

function atDecision() {
  frameIndex = times[Number(el("decision-time").value)];
  const frame = record.frames[frameIndex];
  el("decision-label").textContent = time.format(frame.ts*1000) + " ET";
  el("decision-time").setAttribute("aria-valuetext", el("decision-label").textContent);
  renderSnapshot({ts:frame.ts, stations:frameStations(record,frame)},true);
  source(record.source.name,stamp(frame.ts) + " · recorded", "archive");
  syncAddress();
}

async function loadSession(file, fallback = true, at = "17:10") {
  const ticket = ++generation;
  el("decision-time").disabled = el("outcome-button").disabled = true;
  setOutcome(false);
  clearBoard();
  source("Opening recorded commute","","archive");
  try {
    const url = file === archive.file ? file : replayURL(file);
    const [data] = await Promise.all([json(url),loadDemand()]);
    if (ticket !== generation) return;
    const available = decisionFrames(data);
    if (!available.length) throw Error("No continuous decision window.");
    record = data; times = available;
    const slider = el("decision-time");
    slider.max = String(times.length-1);
    const chosen = times.findIndex(i => timeKey.format(record.frames[i].ts*1000) === at);
    slider.value = String(Math.max(0,chosen));
    slider.disabled = times.length === 1;
    el("outcome-button").disabled = false;
    atDecision();
  } catch (err) {
    if (ticket !== generation) return;
    if (fallback && file !== archive.file) {
      notice("That recording is unavailable. Showing the built-in September commute.");
      el("session").value = archive.file;
      await loadSession(archive.file,false);
    } else {
      source("Replay unavailable","","warn");
      notice("The recording could not be loaded. Retry the session or switch to the live network.");
    }
  }
}

async function setMode(next, requested = {}) {
  const ticket = ++generation;
  mode = next; clearTimeout(timer); notice(""); setOutcome(false);
  el("live-mode").setAttribute("aria-pressed",String(mode==="live"));
  el("replay-mode").setAttribute("aria-pressed",String(mode==="replay"));
  el("refresh").hidden = mode!=="live";
  el("replay-tools").hidden = mode!=="replay";
  clearBoard();
  if (next === "live") {
    syncAddress();
    source("Connecting to operator","","");
    if (live && demand) {renderSnapshot(live,true); liveStatus();}
    await refresh();
    return;
  }
  source("Opening recorded commute","","archive");
  el("session").disabled = true;
  el("decision-time").disabled = el("outcome-button").disabled = true;
  let recent = [];
  try { recent = await latestSessions(); }
  catch { if (ticket === generation) notice("The latest session index is unavailable. The built-in archive is available below."); }
  if (ticket !== generation) return;
  sessions = [...recent.filter(s=>s.date!==archive.date),archive];
  sessionOptions();
  const today = dcDate.format(Date.now());
  const exact = sessions.find(s=>s.date===requested.date);
  const preferred = exact || sessions.find(s=>s.date<today) || sessions[0];
  if (requested.date && !exact) notice("That recording is outside the retained sessions. The displayed date identifies the available replay.");
  el("session").value = preferred.file;
  el("session").disabled = false;
  await loadSession(preferred.file, true, requested.at || "17:10");
  if (requested.outcome && mode === "replay" && snapshot && record?.date === requested.date) {setOutcome(true);syncAddress();}
}

function traceChart(traces) {
  const root = el("trace");
  root.replaceChildren();
  const values = traces.flatMap(p=>[p.pickup,p.drop]).filter(Number.isFinite);
  if (!values.length) return;
  root.append(node("small","Observed bikes · A pickup (mint) / B drop-off (amber)"));
  const svgNS = "http://www.w3.org/2000/svg";
  function svgNode(tag,attrs) {
    const n = document.createElementNS(svgNS,tag);
    for(const [k,v] of Object.entries(attrs)) n.setAttribute(k,v);
    return n;
  }
  const chart = svgNode("svg",{viewBox:"0 0 310 95",role:"img","aria-label":"Observed bike counts during the half-hour after the selected decision. Gaps indicate missing observations."});
  const max = Math.max(1,...values);
  const start = traces[0].ts;
  const x = ts => 23 + (ts-start) / (HORIZON*60) * 277;
  const y = v => 70 - v/max*57;
  for(const [v,label] of [[max,String(max)],[0,"0"]]){
    chart.append(svgNode("line",{x1:23,x2:300,y1:y(v),y2:y(v),stroke:"#34434d"}));
    const txt=svgNode("text",{x:1,y:y(v)+4,fill:"#acbcc8","font-size":10});txt.textContent=label;chart.append(txt);
  }
  for(const [key,col] of [["pickup","#a2e7c2"],["drop","#edc47d"]]) {
    let path="", pen=false;
    for(const row of traces){
      if (!Number.isFinite(row[key])) {pen=false;continue;}
      const sx=x(row.ts),sy=y(row[key]);
      path+=(pen?" L":" M")+sx+" "+sy;pen=true;
      chart.append(svgNode("circle",{cx:sx,cy:sy,r:2.4,fill:col}));
    }
    chart.append(svgNode("path",{d:path,fill:"none",stroke:col,"stroke-width":2}));
  }
  for(const [position,label] of [[23,"Decision"],[245,"+30 min"]]){
    const txt=svgNode("text",{x:position,y:89,fill:"#acbcc8","font-size":10});txt.textContent=label;chart.append(txt);
  }
  root.append(chart);
}

function drawOutcome() {
  const result = evaluate(record,frameIndex,stations,moves[choice]);
  const ts=record.frames[frameIndex].ts;
  el("outcome-period").textContent = time.format(ts*1000)+" – "+time.format((ts+HORIZON*60)*1000)+" ET";
  el("coverage").textContent = `${result.eligible} stations had a trip-history match and continuous observations. Of ${result.sides} eligible bike or dock counts, ${result.model.events} reached zero in the next 30 minutes.`;
  const pct=n => n==null?"—":Math.round(100*n)+"%";
  el("evaluation").replaceChildren(...[["Demand forecast",result.model],["Inventory ≤ 3",result.baseline]].map(([label,s])=>{
    const tr=node("tr");
    const th=node("th",label);th.scope="row";tr.append(th);
    for(const v of [s.hits+" / "+s.alerts,pct(s.precision),pct(s.recall),s.events-s.hits,s.median==null?"—":Math.round(s.median)+" min"])tr.append(node("td",v));
    return tr;
  }));
  el("events").replaceChildren(...result.events.map(e=>node("li",`${time.format(e.ts*1000)} · ${e.name} · ${e.side==="bikes"?"empty":"full"} · ${e.alerted?"forecast alerted":"forecast missed"}`)));
  if(!result.events.length)el("events").append(node("li","No new shortages in the continuously observed stations."));
  const impact=el("impact");
  impact.replaceChildren();
  if(result.impact){
    const s=result.impact;
    const delta=Math.round(s.actualMinutes-s.simulatedMinutes);
    impact.append(node("strong",delta===0?"No change in station-minutes":Math.abs(delta)+" "+(delta>0?"fewer":"more")+" station-minutes"),
      node("p",`Observed empty/full time across this pair was ${Math.round(s.actualMinutes)} station-minutes. With the simulated transfer it was ${Math.round(s.simulatedMinutes)}. The truck delivered ${s.delivered} of ${moves[choice].bikes} planned bikes.`));
  }else impact.append(node("p",moves.length?"One or both stations are missing a checkpoint. This pair has insufficient observations to estimate transfer impact.":"No transfer was proposed for this snapshot."));
  traceChart(result.traces);
}

function setOutcome(open) {
  showOutcome=open;
  el("outcome").hidden=!open;
  el("outcome-button").setAttribute("aria-expanded",String(open));
  el("outcome-button").textContent=open?"Hide 30-minute outcome ↑":"Show 30-minute outcome ↓";
  if(open){ drawOutcome(); el("outcome").focus({preventScroll:true}); el("outcome").scrollIntoView({block:"start"}); }
}

el("live-mode").onclick=()=>setMode("live");
el("replay-mode").onclick=()=>setMode("replay");
el("refresh").onclick=refresh;
el("session").onchange=()=>{notice("");loadSession(el("session").value);};
el("decision-time").oninput=atDecision;
el("outcome-button").onclick=()=>{setOutcome(!showOutcome);syncAddress();};
el("capacity").onchange=()=>{if(snapshot)renderSnapshot(snapshot);};
el("fit-pair").onclick=()=>map.fitMove();
el("fit-network").onclick=()=>map.fitNetwork();
el("zoom-in").onclick=()=>map.zoom(.65);
el("zoom-out").onclick=()=>map.zoom(1/.65);
el("station-search").addEventListener("input", e=>{
  const value=e.target.value.trim().toLowerCase();
  if(!value){inspect(null);return;}
  const station=stations.find(s=>s.name.toLowerCase()===value || s.shortName===value);
  if(station)inspect(station,true);
  else if(inspected){inspected=null;map.inspect(null);el("station-readout").textContent="Choose a matching station to inspect its inventory.";}
});
document.addEventListener("visibilitychange",()=>{
  clearTimeout(timer);
  if(mode==="live" && !document.hidden)refresh();
});
json("data/basemap.json").then(data=>map.geography(data)).catch(()=>{
  document.querySelector(".map-attribution").textContent="Basemap unavailable · station coordinates shown";
});
const incoming = new URL(location.href);
const date = incoming.searchParams.get("replay");
if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
  setMode("replay",{date, at:incoming.searchParams.get("at"), outcome:incoming.hash==="#outcome"});
} else setMode("live");

json("data/streets.json").then(data=>map.streets(data)).catch(()=>{ /* The regional map still works. */ });
