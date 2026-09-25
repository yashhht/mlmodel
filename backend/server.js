import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const ML_URL = process.env.ML_URL || "http://127.0.0.1:8100/predict";
const PORT = Number(process.env.PORT || 8000);

const app = express();
app.use(cors());
app.use(express.json());

const stationCatalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "stations.json"), "utf8"));
const stations = stationCatalog.stations;
const clients = new Set();
const streams = new Map();
const latest = new Map();
const history = new Map();
const events = [];
let selectedStation = stations[0]?.id || "AWS_001";
let mode = "normal";
let sequence = 0;

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split(",");
  return lines.map(line => {
    const values = line.split(",");
    const row = Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
    for (const k of ["temperature", "pressure", "humidity", "fault_label"]) {
      row[k] = row[k] === "" ? null : Number(row[k]);
    }
    return row;
  });
}

for (const station of stations) {
  const file = path.join(DATA_DIR, "raw", station.city, `${station.id}.csv`);
  if (fs.existsSync(file)) {
    streams.set(station.id, { rows: parseCsv(fs.readFileSync(file, "utf8")), index: 0 });
    history.set(station.id, []);
  }
}

function cityCatalog() {
  return [...new Set(stations.map(s => s.city))].map(city => {
    const ss = stations.filter(s => s.city === city);
    return {
      name: city,
      cityId: `MH-${city.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8)}`,
      stationId: ss[0]?.id,
      stationCount: ss.length,
      prototypeStations: ss.filter(s => s.originalPrototype).length,
      stations: ss.map(s => ({ id: s.id, name: s.name }))
    };
  });
}

function nextRaw(station) {
  const stream = streams.get(station.id);
  if (!stream || !stream.rows.length) return null;
  const raw = stream.rows[stream.index % stream.rows.length];
  stream.index = (stream.index + 1) % stream.rows.length;
  sequence += 1;
  return {
    stationId: station.id,
    stationName: station.name,
    city: station.city,
    latitude: station.lat,
    longitude: station.lon,
    elevation: station.elevation,
    timestamp: new Date().toISOString(),
    sequence,
    temperature: raw.temperature,
    pressure: raw.pressure,
    humidity: raw.humidity,
    battery: 12.4,
    sourceEvent: raw.event,
    quality: raw.quality
  };
}

function applyScenario(reading, station) {
  if (!reading) return reading;
  // Fault simulations affect only the selected station.
  if (station.id === selectedStation) {
    if (mode === "spike" && reading.temperature != null) reading.temperature = Number((reading.temperature + 24).toFixed(2));
    if (mode === "drift" && reading.temperature != null) {
      const h = history.get(station.id) || [];
      reading.temperature = Number((reading.temperature + Math.min(12, h.length * 0.18)).toFixed(2));
    }
    if (mode === "stuck") {
      const h = history.get(station.id) || [];
      const prev = h[h.length - 1];
      if (prev) {
        reading.temperature = prev.temperature;
        reading.pressure = prev.pressure;
        reading.humidity = prev.humidity;
      }
    }
    if (mode === "dropout") {
      reading.temperature = null;
      reading.pressure = null;
      reading.humidity = null;
      reading.quality = "MISSING";
    }
  }
  // Weather event is regional: selected city stations move coherently.
  if (mode === "extreme" && station.city === stations.find(s => s.id === selectedStation)?.city) {
    if (reading.temperature != null) reading.temperature = Number((reading.temperature + 6.5).toFixed(2));
    if (reading.pressure != null) reading.pressure = Number((reading.pressure - 5.0).toFixed(2));
    if (reading.humidity != null) reading.humidity = Number(Math.min(100, reading.humidity + 18).toFixed(2));
  }
  return reading;
}

function distanceKm(a, b) {
  if (a.lat == null || b.lat == null) return null;
  const R = 6371, p = Math.PI / 180;
  const dLat = (b.lat - a.lat) * p, dLon = (b.lon - a.lon) * p;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function nearbyFor(station) {
  return stations
    .filter(s => s.id !== station.id && s.city === station.city)
    .map(s => {
      const r = latest.get(s.id);
      if (!r) return null;
      return { ...r, distanceKm: distanceKm(station, s) };
    })
    .filter(Boolean)
    .sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999))
    .slice(0, 5);
}

async function analyze(observation, stationHistory, neighbors) {
  try {
    const r = await fetch(ML_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ observation, history: stationHistory, neighbors })
    });
    if (!r.ok) throw new Error(`ML service ${r.status}`);
    return await r.json();
  } catch (err) {
    const fault = observation?.quality === "MISSING" ? 0.99 : 0.2;
    return {
      status: observation?.quality === "MISSING" ? "COMMUNICATION GAP" : "REVIEW REQUIRED",
      fault_probability: fault,
      weather_probability: 0,
      confidence: Math.max(fault, 1 - fault),
      model_city: observation?.city,
      evidence: { validation: observation?.quality === "MISSING" ? 0 : 1, temporal: 0, physics: 0, spatial: 0 },
      explanation: [`Python ML unavailable: ${err.message}`],
      recommendation: "Retain the raw observation and check the ML service connection."
    };
  }
}

function departmentInsights(result) {
  const fault = result.fault_probability || 0;
  const weather = result.weather_probability || 0;
  return {
    agriculture: fault > 0.7
      ? { title: "Data hold", instruction: "Do not use this station alone for advisory generation; compare nearby validated observations." }
      : { title: "Monitor", instruction: "Keep the observation in the QC stream while local weather conditions are monitored." },
    disaster: weather > 0.55
      ? { title: "Weather watch", instruction: "Review regional observations and official warning workflows before issuing any public alert." }
      : { title: "No escalation", instruction: "No department escalation is suggested by this QC result." },
    aviation: fault > 0.7
      ? { title: "Verify station", instruction: "Use validated nearby observations while this station is investigated." }
      : { title: "Monitor", instruction: "Continue monitoring the station quality stream." }
  };
}

function shouldLog(result) {
  return mode !== "normal" || ["FAULT SUSPECTED", "REVIEW REQUIRED", "WEATHER EVENT LIKELY", "COMMUNICATION GAP"].includes(result.status);
}

async function tick() {
  // Advance every station so spatial comparison is genuinely based on a live network stream.
  for (const station of stations) {
    let reading = nextRaw(station);
    if (!reading) continue;
    reading = applyScenario(reading, station);
    latest.set(station.id, reading);
    const h = history.get(station.id) || [];
    h.push(reading);
    if (h.length > 50) h.shift();
    history.set(station.id, h);
  }

  const station = stations.find(s => s.id === selectedStation) || stations[0];
  const observation = latest.get(station.id);
  const stationHistory = history.get(station.id) || [];
  const neighbors = nearbyFor(station);
  const result = await analyze(observation, stationHistory.slice(-30), neighbors);
  const timeline = events.filter(e => e.observation?.stationId === station.id).slice(0, 8).map(e => ({
    time: e.observation.timestamp,
    status: e.status,
    message: e.explanation?.[0] || e.status,
    confidence: e.confidence
  }));
  const packet = {
    type: "decision",
    ...result,
    observation,
    nearby: neighbors,
    timeline,
    departments: departmentInsights(result),
    network: { stationCount: stations.length, cityStationCount: stations.filter(s => s.city === station.city).length },
    dataType: "DEMO/SIMULATED"
  };

  if (shouldLog(result)) {
    events.unshift(packet);
    if (events.length > 200) events.pop();
  }
  broadcast(packet);
}

function broadcast(message) {
  const raw = JSON.stringify(message);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(raw);
}

const server = app.listen(PORT, () => {
  console.log(`SkyGuard backend on http://localhost:${PORT}`);
  console.log(`Loaded ${stations.length} synthetic AWS stations across ${cityCatalog().length} Maharashtra cities.`);
  setInterval(() => tick().catch(console.error), 2000);
  tick().catch(console.error);
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "connected", selectedStation, mode, stations, cityCatalog: cityCatalog(), dataType: "DEMO/SIMULATED" }));

  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "set_station" && stations.some(s => s.id === msg.stationId)) {
        selectedStation = msg.stationId;
        mode = "normal";
        broadcast({ type: "selection", selectedStation, mode });
      }
      if (msg.type === "set_mode" && ["normal", "spike", "drift", "stuck", "dropout", "extreme"].includes(msg.mode)) {
        mode = msg.mode;
        broadcast({ type: "mode", mode, selectedStation });
      }
    } catch {}
  });
  ws.on("close", () => clients.delete(ws));
});

app.get("/api/health", (_, res) => res.json({ ok: true, selectedStation, mode, connectedOperators: clients.size, stationCount: stations.length, cityCount: cityCatalog().length, mlService: ML_URL, dataType: "DEMO/SIMULATED" }));
app.get("/api/stations", (_, res) => res.json({ stations, source: "SkyGuard synthetic AWS network + 10 preserved prototype records", dataType: "DEMO/SIMULATED" }));
app.get("/api/cities", (_, res) => res.json({ cities: cityCatalog(), dataType: "synthetic demonstration network; not an official IMD station registry" }));
app.get("/api/events", (_, res) => res.json(events.slice(0, 100)));
app.get("/api/events/:stationId", (req, res) => res.json(events.filter(e => e.observation?.stationId === req.params.stationId).slice(0, 100)));
app.get("/api/stations/:stationId/nearby", (req, res) => {
  const s = stations.find(x => x.id === req.params.stationId);
  if (!s) return res.status(404).json({ error: "station not found" });
  res.json(nearbyFor(s));
});
app.post("/api/mode", (req, res) => {
  if (!["normal", "spike", "drift", "stuck", "dropout", "extreme"].includes(req.body.mode)) return res.status(400).json({ error: "invalid mode" });
  mode = req.body.mode;
  broadcast({ type: "mode", mode, selectedStation });
  res.json({ mode, selectedStation });
});
app.post("/api/feedback", (req, res) => res.json({ ok: true, received: req.body }));
