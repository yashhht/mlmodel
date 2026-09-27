import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity, AlertTriangle, ArrowLeft, ArrowRight, Bell, BrainCircuit, CheckCircle2,
  ChevronRight, Cloud, CloudRain, Database, Gauge, Leaf, MapPin, Mic, Network,
  Radio, Search, ShieldAlert, ShieldCheck, Thermometer, Users, Volume2, Wind, Plane,
  Wifi, WifiOff, RefreshCw, Clock3, SlidersHorizontal, Menu, X, Zap
} from "lucide-react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import "./styles.css";

const API = "http://localhost:8000";
const WS = "ws://localhost:8000/ws";
const MODES = [
  ["normal", "Normal stream"], ["spike", "Sensor spike"], ["drift", "Sensor drift"],
  ["stuck", "Stuck sensor"], ["dropout", "Communication gap"], ["extreme", "Regional weather event"]
];
const fmt = (v, digits = 1) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "—" : Number(v).toFixed(digits);
const pct = v => `${Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100)}%`;
const asList = v => Array.isArray(v) ? v : typeof v === "string" ? [v] : [];

function App() {
  const [page, setPage] = useState("home");
  const [city, setCity] = useState("Pune");
  const [station, setStation] = useState("AWS_001");
  const [connection, setConnection] = useState("disconnected");
  const [mode, setMode] = useState("normal");
  const [tab, setTab] = useState("overview");
  const [search, setSearch] = useState("");
  const [cities, setCities] = useState([]);
  const [stations, setStations] = useState([]);
  const [latest, setLatest] = useState({});
  const [history, setHistory] = useState({});
  const [events, setEvents] = useState({});
  const [nearby, setNearby] = useState([]);
  const [departments, setDepartments] = useState(null);
  const [voice, setVoice] = useState(false);
  const [networkError, setNetworkError] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const wsRef = useRef(null);
  const cityStrip = useRef(null);
  const recognition = useRef(null);
  const stationRef = useRef(station);
  const modeRef = useRef(mode);
  const lastEventRef = useRef("");
  useEffect(() => { stationRef.current = station; }, [station]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const loadCatalog = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([fetch(`${API}/api/cities`), fetch(`${API}/api/stations`)]);
      if (!c.ok || !s.ok) throw new Error("Backend returned an error");
      const [cj, sj] = await Promise.all([c.json(), s.json()]);
      setCities(cj.cities || []); setStations(sj.stations || []); setNetworkError("");
    } catch { setNetworkError("Backend not reachable. Start the SkyGuard backend on port 8000."); }
  }, []);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  const connect = useCallback(() => {
    if (wsRef.current && [WebSocket.OPEN, WebSocket.CONNECTING].includes(wsRef.current.readyState)) wsRef.current.close();
    setConnection("connecting");
    const socket = new WebSocket(WS); wsRef.current = socket;
    socket.onopen = () => {
      if (wsRef.current !== socket) return;
      setConnection("live");
      socket.send(JSON.stringify({ type: "set_station", stationId: stationRef.current }));
      socket.send(JSON.stringify({ type: "set_mode", mode: modeRef.current }));
    };
    socket.onmessage = event => {
      if (wsRef.current !== socket) return;
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "connected") { setStations(msg.stations || []); setCities(msg.cityCatalog || []); return; }
      if (msg.type === "mode") { setMode(msg.mode || "normal"); return; }
      if (msg.type === "selection") { if (msg.selectedStation) setStation(msg.selectedStation); setMode(msg.mode || "normal"); return; }
      if (msg.type !== "decision") return;
      const obs = msg.observation; const id = obs?.stationId || stationRef.current;
      setLatest(prev => ({ ...prev, [id]: msg }));
      if (obs) setHistory(prev => ({ ...prev, [id]: [...(prev[id] || []), {
        time: new Date(obs.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        temperature: obs.temperature, pressure: obs.pressure, humidity: obs.humidity
      }].slice(-48) }));
      if (id === stationRef.current) {
        setNearby(msg.nearby || []); setDepartments(msg.departments || null);
        const signature = `${id}|${msg.status}|${msg.observation?.sourceEvent}|${msg.explanation?.[0]}`;
        if ((msg.status && msg.status !== "NORMAL") || modeRef.current !== "normal") {
          if (signature !== lastEventRef.current) {
            lastEventRef.current = signature;
            setEvents(prev => ({ ...prev, [id]: [msg, ...(prev[id] || [])].slice(0, 30) }));
          }
        } else lastEventRef.current = "";
      }
    };
    socket.onerror = () => { if (wsRef.current === socket) setConnection("error"); };
    socket.onclose = () => { if (wsRef.current === socket) setConnection("disconnected"); };
  }, []);
  useEffect(() => {
    if (page !== "dashboard") return undefined;
    connect();
    return () => { const s = wsRef.current; wsRef.current = null; s?.close(); setConnection("disconnected"); };
  }, [page, connect]);

  const openCity = cityOrObject => {
    const c = typeof cityOrObject === "string" ? cities.find(x => x.name === cityOrObject) : cityOrObject;
    if (!c) return;
    const firstStation = c.stationId || stations.find(s => s.city === c.name)?.id;
    if (!firstStation) return;
    setCity(c.name); setStation(firstStation); stationRef.current = firstStation;
    setMode("normal"); modeRef.current = "normal"; setTab("overview"); setPage("dashboard");
    setLatest({}); setHistory({}); setEvents({}); setNearby([]); setDepartments(null); lastEventRef.current = "";
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "set_station", stationId: firstStation }));
      wsRef.current.send(JSON.stringify({ type: "set_mode", mode: "normal" }));
    }
  };
  const chooseStation = id => {
    const s = stations.find(x => x.id === id); if (!s) return;
    setStation(id); stationRef.current = id; setCity(s.city); setMode("normal"); modeRef.current = "normal";
    setNearby([]); setDepartments(null); lastEventRef.current = "";
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "set_station", stationId: id }));
      wsRef.current.send(JSON.stringify({ type: "set_mode", mode: "normal" }));
    }
  };
  const chooseMode = value => {
    setMode(value); modeRef.current = value;
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "set_mode", mode: value }));
  };
  const startVoice = () => {
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Speech) { window.alert("Voice search is not supported in this browser. Try Chrome or Edge."); return; }
    if (voice) { recognition.current?.stop(); setVoice(false); return; }
    const r = new Speech(); recognition.current = r; r.lang = "en-IN"; r.interimResults = false;
    r.onstart = () => setVoice(true); r.onend = () => setVoice(false); r.onerror = () => setVoice(false);
    r.onresult = e => { const spoken = e.results[0][0].transcript; const found = cities.find(c => c.name.toLowerCase().includes(spoken.toLowerCase()) || spoken.toLowerCase().includes(c.name.toLowerCase())); setSearch(found?.name || spoken); if (found) openCity(found); };
    r.start();
  };
  const current = latest[station];
  const cityStations = stations.filter(s => s.city === city);
  if (page === "home") return <Home search={search} setSearch={setSearch} cities={cities} cityStrip={cityStrip} voice={voice} startVoice={startVoice} openCity={openCity} networkError={networkError} />;
  return <Dashboard city={city} station={station} stationList={cityStations} connection={connection} mode={mode} tab={tab} setTab={setTab} current={current} history={history[station] || []} nearby={nearby} departments={departments} events={events[station] || []} chooseMode={chooseMode} chooseStation={chooseStation} back={() => setPage("home")} reconnect={connect} mobileNav={mobileNav} setMobileNav={setMobileNav} />;
}

function Home({ search, setSearch, cities, cityStrip, voice, startVoice, openCity, networkError }) {
  const filtered = cities.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  const totalStations = cities.reduce((sum, c) => sum + (c.stationCount || 0), 0);
  const scroll = n => cityStrip.current?.scrollBy({ left: n, behavior: "smooth" });
  return <div className="home-shell">
    <header className="home-nav"><a className="brand" href="#top"><span className="brand-mark"><Cloud size={22}/></span><span>SKYGUARD <b>AI</b><small>WEATHER QUALITY INTELLIGENCE</small></span></a><div className="nav-right"><span className="demo-pill"><i/> SIMULATED NETWORK</span><a href="#how">How it works</a><a href="#departments">Use cases</a></div></header>
    <section className="hero" id="top"><div className="hero-glow"/><div className="hero-copy"><div className="eyebrow"><span/> AWS OBSERVABILITY · OPERATOR-FIRST AI</div><h1>Trust the signal.<br/><em>Understand the weather.</em></h1><p>SkyGuard evaluates sensor behavior alongside nearby station evidence—then explains what an operator should review.</p>
      <div className="hero-search"><Search size={19}/><input aria-label="Search city" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search a Maharashtra city… e.g. Pune, Solapur"/><button className={voice ? "mic-btn listening" : "mic-btn"} onClick={startVoice} title="Voice search"><Mic size={18}/></button></div>{voice && <div className="voice-hint"><Volume2 size={14}/> Listening… say a city name</div>}
      <div className="hero-actions"><span><CheckCircle2 size={16}/> Explainable evidence</span><span><CheckCircle2 size={16}/> Raw observations retained</span><span><CheckCircle2 size={16}/> Human review stays in control</span></div>
    </div><div className="hero-visual" aria-label="Weather station monitoring illustration"><div className="visual-orbit orbit-one"/><div className="visual-orbit orbit-two"/><div className="visual-core"><CloudRain size={58}/><span>LIVE AWS</span></div><div className="float-card card-top"><Activity size={16}/><div><b>Signal health</b><small>Temporal + spatial checks</small></div><span className="tiny-live"/></div><div className="float-card card-bottom"><Network size={17}/><div><b>Station network</b><small>Cross-check available neighbors</small></div></div><div className="visual-label label-a">T · P · RH</div><div className="visual-label label-b">QUALITY CONTROL</div></div>
    </section>
    <main className="home-main">
      <section className="city-section"><div className="section-heading"><div><div className="eyebrow dark">EXPLORE THE DEMO NETWORK</div><h2>Choose a city to inspect</h2><p>Open a station dashboard with sensor trends, spatial comparison and review guidance.</p></div><div className="network-stat"><b>{totalStations || "—"}</b><span>demo AWS nodes</span><small>{cities.length} cities · Maharashtra</small></div></div>
        {networkError && <div className="notice"><AlertTriangle size={17}/>{networkError}</div>}
        <div className="city-carousel"><button className="carousel-arrow" onClick={() => scroll(-360)} aria-label="Scroll cities left"><ArrowLeft size={18}/></button><div className="city-strip" ref={cityStrip}>{filtered.map((c, i) => <button className="city-card" key={c.name} onClick={() => openCity(c)}><div className={`city-art art-${i % 5}`}><CityIcon i={i}/><span className="art-sun"/></div><div className="city-card-info"><b>{c.name}</b><span>{c.stationCount || 0} stations <ChevronRight size={15}/></span></div><small>{c.prototypeStations ? `${c.prototypeStations} prototype records included` : "Synthetic demonstration data"}</small></button>)}</div><button className="carousel-arrow" onClick={() => scroll(360)} aria-label="Scroll cities right"><ArrowRight size={18}/></button></div>
        {filtered.length === 0 && <div className="empty-state">No city matches “{search}”. Try another name.</div>}
      </section>
      <section className="how-section" id="how"><div className="section-heading"><div><div className="eyebrow dark">FROM READING TO REVIEW</div><h2>Designed for clear decisions</h2><p>Multiple evidence streams are presented together—not hidden behind a single anomaly score.</p></div></div><div className="workflow-grid"><WorkflowStep n="01" icon={<Radio/>} title="Receive" text="Collect temperature, pressure and relative humidity observations."/><WorkflowStep n="02" icon={<BrainCircuit/>} title="Evaluate" text="Review temporal patterns, validation and available spatial context."/><WorkflowStep n="03" icon={<ShieldCheck/>} title="Explain" text="Show supporting evidence, uncertainty and a recommended review step."/><WorkflowStep n="04" icon={<Users/>} title="Keep control" text="Operators decide what to verify, retain or escalate through official workflows."/></div></section>
      <section className="usecase-section" id="departments"><div><div className="eyebrow dark">BUILT FOR TEAMS THAT USE WEATHER DATA</div><h2>One quality layer.<br/>Different operational contexts.</h2><p>SkyGuard provides context for teams while leaving official advisories and operational decisions to authorized workflows.</p></div><div className="usecase-cards"><UseCase icon={<Leaf/>} title="Agriculture" text="Check station quality before using observations in local monitoring."/><UseCase icon={<AlertTriangle/>} title="Disaster management" text="Review regional consistency before an authorized warning workflow."/><UseCase icon={<Plane/>} title="Aviation" text="Identify observations that may need verification before operational use."/></div></section>
      <footer className="home-footer"><span>© SkyGuard AI · SIH prototype</span><span><i/> Demo data only · Not an official IMD service</span></footer>
    </main>
  </div>;
}

function Dashboard({ city, station, stationList, connection, mode, tab, setTab, current, history, nearby, departments, events, chooseMode, chooseStation, back, reconnect, mobileNav, setMobileNav }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const o = current?.observation;
  const fault = Number(current?.fault_probability) || 0, weather = Number(current?.weather_probability) || 0;
  const status = current?.status || "AWAITING DATA";
  const tabs = [["overview", "Overview", Activity], ["fault", "Sensor quality", ShieldAlert], ["weather", "Weather event", CloudRain], ["nearby", "Station network", Network], ["departments", "Use-case guidance", Users], ["events", "Review log", Clock3]];
  return <div className="dashboard-shell">
    <aside className={mobileNav ? "sidebar open" : "sidebar"}><div className="sidebar-brand"><span className="brand-mark"><Cloud size={21}/></span><span>SKYGUARD <b>AI</b><small>OPERATOR CONSOLE</small></span><button className="sidebar-close" onClick={() => setMobileNav(false)}><X size={18}/></button></div><div className="sidebar-label">WORKSPACE</div><button className="back-link" onClick={back}><ArrowLeft size={16}/> All cities</button><div className="sidebar-label nav-label">MONITORING</div><nav className="side-nav">{tabs.map(([id, label, Icon]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => { setTab(id); setMobileNav(false); }}><Icon size={17}/><span>{label}</span>{id === "events" && events.length > 0 && <small>{events.length}</small>}</button>)}</nav><div className="sidebar-bottom"><div className="sidebar-status"><span className={connection === "live" ? "status-dot live-dot" : "status-dot"}/><div><b>{connection === "live" ? "Stream connected" : connection === "connecting" ? "Connecting…" : "Stream offline"}</b><small>{connection === "live" ? "Receiving demo observations" : "Check backend service"}</small></div></div><div className="sidebar-foot">SkyGuard AI · Prototype v5<br/>Synthetic demonstration network</div></div></aside>
    {mobileNav && <button className="nav-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation"/>}
    <div className="dashboard-content"><header className="topbar"><button className="mobile-menu" onClick={() => setMobileNav(true)}><Menu size={20}/></button><div className="breadcrumb"><span>Monitoring</span><ChevronRight size={15}/><b>{city}</b></div><div className="topbar-right"><span className={`connection-pill ${connection}`}><i/>{connection === "live" ? "Live stream" : connection === "connecting" ? "Connecting" : "Offline"}</span><span className="top-clock"><Clock3 size={15}/>{now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} IST</span><button className="icon-button" onClick={reconnect} title="Reconnect stream"><RefreshCw size={17}/></button></div></header>
      <main className="dashboard-main"><div className="page-title-row"><div><div className="eyebrow dark">AWS QUALITY MONITORING / {city.toUpperCase()}</div><h1>{tab === "overview" ? "Station overview" : tabs.find(t => t[0] === tab)?.[1]}</h1><p>Review observation quality and supporting evidence for this station.</p></div><div className="station-picker"><label htmlFor="station-select">Selected station</label><div><MapPin size={16}/><select id="station-select" value={station} onChange={e => chooseStation(e.target.value)}>{stationList.map(s => <option key={s.id} value={s.id}>{s.id} · {s.name}</option>)}</select></div></div></div>
      <div className="demo-banner"><Zap size={16}/><span><b>DEMO ENVIRONMENT</b> — synthetic AWS observations and simulated scenarios; not an official operational feed.</span><span className="demo-time">Updated {o?.timestamp ? new Date(o.timestamp).toLocaleTimeString("en-IN") : "waiting"}</span></div>
      <div className="scenario-toolbar"><div><SlidersHorizontal size={17}/><div><b>Scenario controls</b><small>Choose a test condition to see the evidence response.</small></div></div><div className="scenario-buttons">{MODES.map(([value, label]) => <button key={value} className={mode === value ? "selected" : ""} onClick={() => chooseMode(value)}>{label}</button>)}</div></div>
      {tab === "overview" && <Overview city={city} station={station} current={current} history={history} nearby={nearby} events={events} departments={departments} fault={fault} weather={weather} />}
      {tab === "fault" && <AnalysisTab type="fault" current={current} history={history} nearby={nearby} station={station}/>}
      {tab === "weather" && <AnalysisTab type="weather" current={current} history={history} nearby={nearby} station={station}/>}
      {tab === "nearby" && <Nearby nearby={nearby} station={station} o={o}/>}
      {tab === "departments" && <DepartmentPage departments={departments}/>}
      {tab === "events" && <EventPage events={events}/>}
      </main></div>
  </div>;
}

function Overview({ city, station, current, history, nearby, events, departments, fault, weather }) {
  const o = current?.observation; const status = current?.status || "WAITING FOR OBSERVATION";
  const type = /WEATHER/i.test(status) || weather > fault ? "weather" : /FAULT|COMMUNICATION/i.test(status) || fault > weather ? "fault" : "review";
  const title = type === "weather" ? "Weather pattern requires review" : type === "fault" ? "Sensor quality requires review" : "Observation under monitoring";
  const explanation = asList(current?.explanation);
  return <div className="content-stack">
    <section className={`decision-card ${type}`}><div className="decision-symbol">{type === "weather" ? <CloudRain size={25}/> : type === "fault" ? <ShieldAlert size={25}/> : <Activity size={25}/>}</div><div className="decision-copy"><div className="decision-kicker">CURRENT ASSESSMENT <span className={`status-tag ${type}`}>{status}</span></div><h2>{title}</h2><p>{explanation[0] || "Waiting for enough observations to produce a quality assessment."}</p><small>AI output is decision support; review evidence before operational use.</small></div><div className="decision-scores"><Score label="Weather evidence" value={weather}/><Score label="Sensor-fault evidence" value={fault}/><Score label="Model confidence" value={current?.confidence}/></div></section>
    <div className="metric-grid"><Metric icon={<Thermometer/>} label="Temperature" value={fmt(o?.temperature)} unit="°C" detail="Air temperature"/><Metric icon={<CloudRain/>} label="Relative humidity" value={fmt(o?.humidity)} unit="%" detail="Moisture in air"/><Metric icon={<Gauge/>} label="Pressure" value={fmt(o?.pressure, 1)} unit="hPa" detail="Atmospheric pressure"/><Metric icon={<Radio/>} label="Data stream" value={o ? "Receiving" : "Waiting"} unit="" detail={o?.quality || "No observation yet"}/></div>
    <ObservationLifecycle current={current}/>
    <div className="two-column"><SpatialPanel nearby={nearby} station={station} o={o}/><EvidencePanel current={current}/></div>
    <Trend history={history}/>
    <div className="two-column"><EventTimeline events={events}/><DepartmentMini departments={departments}/></div>
  </div>;
}
function Score({ label, value }) { return <div className="score-item"><span>{label}</span><b>{pct(value)}</b><div className="score-track"><i style={{ width: pct(value) }}/></div></div>; }
function Metric({ icon, label, value, unit, detail }) { return <article className="metric-card"><div className="metric-icon">{icon}</div><div className="metric-label">{label}</div><div className="metric-value">{value}<small>{unit}</small></div><div className="metric-detail">{detail}</div></article>; }
function ObservationLifecycle({ current }) {
  const steps = [["Received", !!current?.observation], ["Validated", !!current?.evidence], ["Cross-checked", !!current?.nearby?.length], ["Assessed", !!current?.status], ["Operator review", false]];
  return <section className="panel lifecycle-panel"><PanelHeading icon={<Activity size={17}/>} title="Observation lifecycle" sub="Transparent processing from incoming reading to human review."/><div className="lifecycle-track">{steps.map(([label, done], i) => <div className={`lifecycle-step ${done ? "done" : ""}`} key={label}><span>{done ? <CheckCircle2 size={17}/> : i + 1}</span><b>{label}</b>{i < steps.length - 1 && <i/>}</div>)}</div><div className="lifecycle-foot"><span><ShieldCheck size={15}/> Raw observation retained</span><span>{current?.observation?.timestamp ? `Observation time: ${new Date(current.observation.timestamp).toLocaleString("en-IN")}` : "Awaiting first observation"}</span></div></section>;
}
function SpatialPanel({ nearby, station, o }) {
  const target = Number(o?.temperature); const validTarget = o?.temperature !== null && o?.temperature !== undefined && Number.isFinite(target);
  const rows = nearby.filter(x => x.temperature !== null && x.temperature !== undefined && Number.isFinite(Number(x.temperature))).map(x => ({ ...x, delta: validTarget ? Math.abs(Number(x.temperature) - target) : null }));
  return <section className="panel spatial-panel"><PanelHeading icon={<Network size={17}/>} title="Spatial evidence" sub="Temperature comparison with currently available same-city stations."/><div className="target-reading"><div><small>SELECTED AWS</small><b>{station}</b></div><strong>{validTarget ? `${target.toFixed(1)}°C` : "—"}</strong></div>
    {rows.length ? <div className="spatial-rows">{rows.slice(0, 5).map(r => <div className="spatial-row" key={r.stationId}><span className="station-status-dot"/><div className="spatial-station"><b>{r.stationId}</b><small>{r.distanceKm != null ? `${fmt(r.distanceKm)} km away` : "Reference station"}</small></div><strong>{fmt(r.temperature)}°C</strong><span className={`delta-pill ${r.delta !== null && r.delta > 5 ? "diff" : "close"}`}>{r.delta === null ? "No target" : `${r.delta.toFixed(1)}° delta`}</span></div>)}</div> : <EmptyState text="Neighbor observations are not available yet. Missing spatial evidence is not treated as agreement."/>}
    <div className="spatial-note"><b>{rows.length ? `${rows.length} available comparison${rows.length === 1 ? "" : "s"}` : "Spatial check pending"}</b><span>Agreement can support interpretation but does not prove a weather event or sensor fault.</span></div></section>;
}
function EvidencePanel({ current }) {
  const e = current?.evidence || {}; const lines = [["Temporal model", e.temporal], ["Physics context", e.physics], ["Spatial evidence", e.spatial], ["Data validation", e.validation]];
  return <section className="panel evidence-panel"><PanelHeading icon={<BrainCircuit size={17}/>} title="Evidence breakdown" sub="Evidence components returned by the analysis service."/><div className="evidence-bars">{lines.map(([label, value]) => <div className="evidence-bar" key={label}><div><span>{label}</span><b>{value == null ? "—" : pct(value)}</b></div><div className="evidence-track"><i style={{ width: value == null ? "0%" : pct(value) }}/></div></div>)}</div><div className="explanation-box"><ShieldCheck size={17}/><div><b>Why this assessment?</b>{asList(current?.explanation).length ? <ul>{asList(current.explanation).slice(0, 4).map((x, i) => <li key={i}>{x}</li>)}</ul> : <p>Waiting for evidence from the model.</p>}</div></div></section>;
}
function Trend({ history }) { return <section className="panel trend-panel"><PanelHeading icon={<Activity size={17}/>} title="Sensor trends" sub="Recent samples received by the dashboard; chart uses the available sample window."/><div className="chart-grid"><TrendChart data={history} field="temperature" title="Temperature" unit="°C" color="#0A84FF"/><TrendChart data={history} field="pressure" title="Pressure" unit="hPa" color="#32A6C8"/><TrendChart data={history} field="humidity" title="Relative humidity" unit="%" color="#6259C8"/></div></section>; }
function TrendChart({ data, field, title, unit, color }) { const valid = data.filter(d => d[field] !== null && d[field] !== undefined && Number.isFinite(Number(d[field]))); return <div className="chart-card"><div className="chart-heading"><b>{title}</b><span>{valid.length} samples</span></div><div className="chart-area">{valid.length > 1 ? <ResponsiveContainer width="100%" height="100%"><LineChart data={valid}><CartesianGrid stroke="#e9eef4" vertical={false}/><XAxis dataKey="time" hide/><YAxis width={42} tick={{ fontSize: 11, fill: "#8593a5" }} axisLine={false} tickLine={false} domain={["auto", "auto"]}/><Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #e5eaf0", fontSize: 12 }}/><Line dataKey={field} name={title} stroke={color} strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={false}/></LineChart></ResponsiveContainer> : <div className="chart-empty">Waiting for more valid samples</div>}</div><small>{unit} · latest {valid.length} valid samples</small></div>; }
function EventTimeline({ events }) { return <section className="panel"><PanelHeading icon={<Clock3 size={17}/>} title="Recent review events" sub="Unique status transitions observed during this session."/>{events.length ? <div className="timeline-list">{events.slice(0, 5).map((e, i) => <div className="timeline-item" key={`${e.observation?.timestamp || "event"}-${i}`}><i/><div><small>{e.observation?.timestamp ? new Date(e.observation.timestamp).toLocaleTimeString("en-IN") : "Timestamp unavailable"}</small><b>{e.status || "Review event"}</b><p>{asList(e.explanation)[0] || "No explanation supplied."}</p></div></div>)}</div> : <EmptyState text="No review events recorded. Try a scenario from the controls above."/>}</section>; }
function DepartmentMini({ departments }) { return <section className="panel"><PanelHeading icon={<Users size={17}/>} title="Operational context" sub="Short guidance based on current quality-control output."/>{departments ? <div className="department-mini">{Object.entries(departments).map(([key, value]) => <article key={key}><span className={`dept-icon ${key}`}>{key === "agriculture" ? <Leaf size={17}/> : key === "disaster" ? <AlertTriangle size={17}/> : <Plane size={17}/>}</span><div><b>{value.title}</b><small>{value.instruction}</small></div></article>)}</div> : <EmptyState text="Department guidance will appear after the first assessment."/>}</section>; }
function AnalysisTab({ type, current, history, nearby, station }) { const isFault = type === "fault"; const score = isFault ? current?.fault_probability : current?.weather_probability; return <div className="content-stack"><section className={`analysis-hero ${isFault ? "fault" : "weather"}`}><div className="analysis-icon">{isFault ? <ShieldAlert size={25}/> : <CloudRain size={25}/>}</div><div><div className="eyebrow dark">{isFault ? "SENSOR QUALITY REVIEW" : "METEOROLOGICAL CONTEXT"}</div><h2>{isFault ? "Check the measurement chain" : "Review the regional signal"}</h2><p>{current?.recommendation || "Awaiting model output. Preserve the observation and review available evidence."}</p></div><strong>{score == null ? "—" : pct(score)}<small>{isFault ? "fault evidence" : "weather evidence"}</small></strong></section><div className="two-column"><EvidencePanel current={current}/><SpatialPanel nearby={nearby} station={station} o={current?.observation}/></div><Trend history={history}/></div>; }
function Nearby({ nearby, station, o }) { const valid = nearby.filter(x => x.temperature != null); return <section className="panel network-panel"><PanelHeading icon={<Network size={17}/>} title="Nearby station network" sub={`Available same-city reference observations for ${station}.`}/><div className="network-target"><span className="target-node"><MapPin size={17}/></span><div><b>{station} · Selected station</b><small>Temperature: {fmt(o?.temperature)}°C · Target reading</small></div><span className="target-label">TARGET</span></div>{valid.length ? valid.map(r => <div className="network-row" key={r.stationId}><span className="reference-node"><Radio size={16}/></span><div><b>{r.stationName || r.stationId}</b><small>{r.stationId} · {r.distanceKm == null ? "Distance unavailable" : `${fmt(r.distanceKm)} km from target`}</small></div><strong>{fmt(r.temperature)}°C</strong><span className="network-meta">RH {fmt(r.humidity)}%</span></div>) : <EmptyState text="No nearby observations have arrived. The system does not infer spatial agreement from missing stations."/>}</section>; }
function DepartmentPage({ departments }) { return <div className="content-stack"><section className="panel"><PanelHeading icon={<Users size={17}/>} title="Department guidance" sub="Context for authorized teams. This prototype does not issue official advisories or alerts."/>{departments ? <div className="department-list">{Object.entries(departments).map(([key, v]) => <article key={key}><span className={`dept-icon ${key}`}>{key === "agriculture" ? <Leaf/> : key === "disaster" ? <AlertTriangle/> : <Plane/>}</span><div><small>{key.toUpperCase()}</small><h3>{v.title}</h3><p>{v.instruction}</p></div><ChevronRight size={18}/></article>)}</div> : <EmptyState text="Guidance appears when the first assessment arrives."/>}</section></div>; }
function EventPage({ events }) { return <section className="panel event-panel"><PanelHeading icon={<Clock3 size={17}/>} title="Review log" sub="Session-level record of unique assessment changes. Raw readings remain in the stream."/>{events.length ? <div className="event-table"><div className="event-table-head"><span>Assessment</span><span>Explanation</span><span>Confidence</span><span>Observed</span></div>{events.map((e, i) => <div className="event-table-row" key={`${e.observation?.timestamp || "e"}-${i}`}><div><b>{e.status || "Review required"}</b><small>{e.observation?.stationId || "Station"}</small></div><p>{asList(e.explanation).join(" · ") || "No explanation provided."}</p><strong>{e.confidence == null ? "—" : pct(e.confidence)}</strong><time>{e.observation?.timestamp ? new Date(e.observation.timestamp).toLocaleString("en-IN") : "—"}</time></div>)}</div> : <EmptyState text="No review entries yet. Select a scenario to explore how the prototype responds."/>}</section>; }
function PanelHeading({ icon, title, sub }) { return <div className="panel-heading"><span className="panel-heading-icon">{icon}</span><div><h3>{title}</h3><p>{sub}</p></div></div>; }
function EmptyState({ text }) { return <div className="empty-state"><CheckCircle2 size={18}/><span>{text}</span></div>; }
function CityIcon({ i }) { const icons = [<MapPin/>, <Cloud/>, <Gauge/>, <Network/>, <Radio/>, <Wind/>]; return icons[i % icons.length]; }
function WorkflowStep({ n, icon, title, text }) { return <article className="workflow-step"><span className="workflow-number">{n}</span><div className="workflow-icon">{icon}</div><h3>{title}</h3><p>{text}</p></article>; }
function UseCase({ icon, title, text }) { return <article className="usecase-card"><span>{icon}</span><div><b>{title}</b><p>{text}</p></div><ChevronRight size={17}/></article>; }

createRoot(document.getElementById("root")).render(<App/>);
