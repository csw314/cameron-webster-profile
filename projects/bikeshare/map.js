// Local Census geometry, projected into kilometers around central Washington.
const project = (lon, lat) => [(lon + 77.04) * 86.55, (38.90 - lat) * 111.195];
const places = [
  ["GEORGETOWN",-77.067,38.908], ["DOWNTOWN",-77.033,38.901],
  ["CAPITOL HILL",-76.996,38.886], ["DUPONT CIRCLE",-77.043,38.910],
  ["COLUMBIA HEIGHTS",-77.029,38.928], ["SHAW",-77.022,38.913],
  ["NOMA",-77.004,38.908], ["NAVY YARD",-77.000,38.873], ["ANACOSTIA",-76.986,38.865],
  ["ARLINGTON",-77.104,38.881], ["ROSSLYN",-77.072,38.896],
  ["ALEXANDRIA",-77.052,38.806], ["BETHESDA",-77.097,38.985],
  ["SILVER SPRING",-77.027,38.995], ["COLLEGE PARK",-76.931,38.985],
  ["RESTON",-77.355,38.958], ["FAIRFAX",-77.302,38.849],
  ["ROCKVILLE",-77.153,39.084], ["FALLS CHURCH",-77.173,38.883],
  ["TAKOMA",-77.017,38.974], ["BROOKLAND",-76.988,38.934], ["HYATTSVILLE",-76.944,38.955],
  ["PETWORTH",-77.024,38.943], ["TENLEYTOWN",-77.079,38.949], ["PENTAGON CITY",-77.059,38.863],
];

function pathFor(geometry) {
  const path = new Path2D();
  function add(line, close = false) {
    line.forEach(([lon,lat], i) => {
      const [x,y] = project(lon,lat);
      if (i === 0) path.moveTo(x,y);
      else path.lineTo(x,y);
    });
    if (close) path.closePath();
  }
  if (geometry.type === "LineString") add(geometry.coordinates);
  if (geometry.type === "MultiLineString") geometry.coordinates.forEach(line => add(line));
  if (geometry.type === "Polygon") geometry.coordinates.forEach(line => add(line, true));
  if (geometry.type === "MultiPolygon") geometry.coordinates.forEach(poly => poly.forEach(line => add(line,true)));
  return path;
}

export class StationMap {
  constructor(canvas, onInspect) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onInspect = onInspect;
    this.center = [0,0];
    this.span = 15; // Horizontal geographic extent in km.
    this.points = [];
    this.layers = [];
    this.streetTiles = new Map();
    this.width = this.height = 1;
    new ResizeObserver(() => this.resize()).observe(canvas);
    let pointer = null;
    canvas.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      pointer = {x:e.clientX, y:e.clientY, center:[...this.center], moved:false};
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", e => {
      if (!pointer) return;
      const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;
      if (Math.hypot(dx, dy) > 4) pointer.moved = true;
      if (!pointer.moved) return;
      this.center = [pointer.center[0] - dx / this.scale, pointer.center[1] - dy / this.scale];
      this.draw();
    });
    canvas.addEventListener("pointerup", e => {
      if (pointer && !pointer.moved) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        let nearest, distance = 13;
        for (const p of this.points) {
          const [sx, sy] = this.screen(p.xy);
          const d = Math.hypot(x - sx, y - sy);
          if (d < distance) { distance = d; nearest = p.station; }
        }
        if (nearest) onInspect(nearest);
      }
      pointer = null;
    });
    canvas.addEventListener("pointercancel", () => { pointer = null; });
  }

  get scale() { return this.width / this.span; }
  screen([x,y]) {
    return [this.width / 2 + (x - this.center[0]) * this.scale,
            this.height / 2 + (y - this.center[1]) * this.scale];
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1,rect.width);
    this.height = Math.max(1,rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.draw();
  }

  geography(data) {
    this.layers = data.features.map(f => ({...f.properties, path:pathFor(f.geometry)}));
    this.draw();
  }

  streets(data) {
    // Decode the quantized Census lines once. Draw only tiles overlapping the viewport.
    const factor = 10 ** data.precision;
    for (const line of data.lines) {
      let pos = 0, lat = 0, lon = 0, tile;
      const delta = () => {
        let shift = 0, value = 0, byte;
        do {
          byte = line.charCodeAt(pos++) - 63;
          value |= (byte & 31) << shift;
          shift += 5;
        } while (byte >= 32);
        return value & 1 ? ~(value >> 1) : value >> 1;
      };
      while (pos < line.length) {
        lat += delta(); lon += delta();
        const [x,y] = project(lon/factor,lat/factor);
        if (!tile) {
          const key = Math.floor(x/3) + "," + Math.floor(y/3);
          tile = this.streetTiles.get(key) || {path: new Path2D(), left:x, right:x, top:y, bottom:y};
          this.streetTiles.set(key,tile);
          tile.path.moveTo(x,y);
        } else tile.path.lineTo(x,y);
        tile.left = Math.min(tile.left,x); tile.right = Math.max(tile.right,x);
        tile.top = Math.min(tile.top,y); tile.bottom = Math.max(tile.bottom,y);
      }
    }
    this.draw();
  }

  inventory(stations) {
    this.points = stations.map(station => ({station, xy:project(station.lon,station.lat)}));
    this.draw();
  }

  select(move, fit = true) {
    this.move = move;
    this.highlight = null;
    if (fit && move) this.fitMove();
    else this.draw();
  }

  inspect(station, center = false) {
    this.highlight = station;
    if (center) {
      this.center = project(station.lon,station.lat);
      this.span = 7;
    }
    this.draw();
  }

  fitMove() {
    if (!this.move) return;
    const {from, to} = this.move;
    const [x1,y1] = project(from.lon, from.lat), [x2,y2] = project(to.lon,to.lat);
    this.center = [(x1 + x2) / 2, (y1 + y2) / 2];
    this.span = Math.max(4.2, Math.abs(x2-x1)*2.5, Math.abs(y2-y1)*2.5*this.width/this.height);
    this.draw();
  }

  fitNetwork() {
    if (!this.points.length) return;
    const xs = this.points.map(p=>p.xy[0]), ys = this.points.map(p=>p.xy[1]);
    this.center = [(Math.min(...xs)+Math.max(...xs))/2,(Math.min(...ys)+Math.max(...ys))/2];
    this.span = Math.max(2,(Math.max(...xs)-Math.min(...xs))*1.12,
      (Math.max(...ys)-Math.min(...ys))*1.12*this.width/this.height);
    this.draw();
  }

  zoom(factor) {
    this.span = Math.max(0.7, Math.min(130,this.span * factor));
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx || !this.dpr) return;
    ctx.setTransform(this.dpr,0,0,this.dpr,0,0);
    ctx.fillStyle = "#152029";
    ctx.fillRect(0,0,this.width,this.height);
    const scale = this.scale;
    const [ox,oy] = this.screen([0,0]);
    // A kilometer grid provides orientation even outside the geographic clip.
    const gridKm = this.span < 8 ? .25 : this.span < 30 ? 1 : 5;
    const step = scale * gridKm;
    ctx.strokeStyle = "#1b2933"; ctx.lineWidth = 1; ctx.beginPath();
    for (let x=(ox%step+step)%step; x<this.width; x+=step) {ctx.moveTo(x,0);ctx.lineTo(x,this.height);}
    for (let y=(oy%step+step)%step; y<this.height; y+=step) {ctx.moveTo(0,y);ctx.lineTo(this.width,y);}
    ctx.stroke();
    ctx.save(); ctx.translate(ox,oy); ctx.scale(scale,scale);
    if (this.span < 35) {
      ctx.strokeStyle = this.span < 12 ? "#344451" : "#2a3742";
      ctx.lineWidth = (this.span < 12 ? .95 : .65) / scale;
      for (const tile of this.streetTiles.values()) {
        if (tile.right*scale+ox < 0 || tile.left*scale+ox > this.width ||
            tile.bottom*scale+oy < 0 || tile.top*scale+oy > this.height) continue;
        ctx.stroke(tile.path);
      }
    }
    for (const layer of this.layers) {
      if (layer.kind === "water") {
        ctx.fillStyle = "#193c4a"; ctx.fill(layer.path,"evenodd");
        ctx.strokeStyle = "#27505d"; ctx.lineWidth = .9/scale; ctx.stroke(layer.path);
      } else {
        ctx.strokeStyle = layer.kind === "boundary" ? "#53636c" : layer.class === "primary" ? "#4b5860" : "#35444f";
        ctx.lineWidth = (layer.class === "primary" ? 1.5 : .95)/scale;
        ctx.setLineDash(layer.kind === "boundary" ? [4/scale,4/scale] : []);
        ctx.stroke(layer.path);
      }
    }
    ctx.restore();
    const radius = this.span > 35 ? 2.2 : this.span > 12 ? 2.9 : 3.7;
    for (const {station:s,xy} of this.points) {
      const [x,y] = this.screen(xy);
      if (x < -5 || x > this.width+5 || y < -5 || y > this.height+5) continue;
      ctx.beginPath(); ctx.arc(x,y,radius,0,Math.PI*2);
      ctx.fillStyle = s.bikes === 0 ? "#ff9b80" : s.docks === 0 ? "#e7be72" : "#78a0a8";
      ctx.fill(); ctx.strokeStyle = "#10191e"; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.font = "600 10px ui-monospace,monospace"; ctx.textAlign = "center";
    const labeled = [];
    for (const [name,lon,lat] of places) {
      const [x,y] = this.screen(project(lon,lat));
      if (x<5 || x>this.width-5 || y<16 || y>this.height-10 ||
          labeled.some(([a,b]) => Math.abs(x-a)<92 && Math.abs(y-b)<18)) continue;
      ctx.lineWidth = 3; ctx.strokeStyle = "#14202be6"; ctx.strokeText(name,x,y);
      ctx.fillStyle = "#b3c6cf"; ctx.fillText(name,x,y); labeled.push([x,y]);
    }
    if (this.move) {
      const points = [this.move.from,this.move.to].map(s => this.screen(project(s.lon,s.lat)));
      const [[x1,y1],[x2,y2]] = points;
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2);
      ctx.strokeStyle = "#0d2620"; ctx.lineWidth = 6; ctx.stroke();
      ctx.strokeStyle = "#a5edcc"; ctx.lineWidth = 2.5; ctx.setLineDash([6,4]); ctx.stroke(); ctx.setLineDash([]);
      const theta = Math.atan2(y2-y1,x2-x1);
      const xm = (x1+x2)/2, ym = (y1+y2)/2;
      ctx.save(); ctx.translate(xm,ym); ctx.rotate(theta); ctx.fillStyle = "#abefcf";
      ctx.beginPath(); ctx.moveTo(5,0); ctx.lineTo(-4,-4); ctx.lineTo(-4,4); ctx.closePath(); ctx.fill(); ctx.restore();
      points.forEach(([x,y],i) => {
        ctx.beginPath(); ctx.arc(x,y,10,0,Math.PI*2);
        ctx.fillStyle = i ? "#a6ecca" : "#14251f"; ctx.fill(); ctx.strokeStyle = "#a6ecca"; ctx.lineWidth = 2; ctx.stroke();
        ctx.font = "bold 11px ui-monospace,monospace"; ctx.fillStyle = i ? "#14251f" : "#b0f0d2";
        ctx.fillText(i ? "B" : "A",x,y+3.5);
        if (this.span <= 17 && x >= 0 && x <= this.width && y >= 0 && y <= this.height) {
          const name = (i ? this.move.to : this.move.from).name.split(" / ")[0];
          const label = name.length > 38 ? name.slice(0,35) + "…" : name;
          ctx.font = "550 11px Arial,sans-serif";
          const w = ctx.measureText(label).width + 12;
          const lx = Math.max(w/2+4,Math.min(this.width-w/2-4,x));
          const ly = Math.max(12,Math.min(this.height-18,y+(i ? 22 : -22)));
          ctx.fillStyle = "#101b21ea"; ctx.fillRect(lx-w/2,ly-9,w,18);
          ctx.fillStyle = "#d1e6df"; ctx.fillText(label,lx,ly+3.5);
        }
      });
    }
    if (this.highlight) {
      const [x,y] = this.screen(project(this.highlight.lon,this.highlight.lat));
      ctx.beginPath(); ctx.arc(x,y,14,0,Math.PI*2); ctx.strokeStyle="#fff"; ctx.lineWidth=2; ctx.stroke();
    }
    const barKm = this.span <= 4 ? .25 : this.span <= 16 ? 1 : this.span <= 60 ? 2 : 5;
    const y = this.height - 13;
    ctx.strokeStyle="#b3c4cb"; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(12,y-4);
    ctx.lineTo(12,y); ctx.lineTo(12+barKm*scale,y); ctx.lineTo(12+barKm*scale,y-4); ctx.stroke();
    ctx.textAlign="left"; ctx.font="10px ui-monospace,monospace"; ctx.fillStyle="#c4d2d7";
    ctx.fillText(barKm < 1 ? "250 m" : barKm+" km",12,y-6);
  }
}
