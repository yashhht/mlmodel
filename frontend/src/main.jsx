import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudRain,
  Gauge,
  Info,
  Leaf,
  MapPin,
  Menu,
  Mic,
  Network,
  Plane,
  Radio,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Thermometer,
  Users,
  Volume2,
  Wifi,
  WifiOff,
  CircleDot,
} from "lucide-react";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";

import "./styles.css";

/* =========================================================
   CONFIGURATION
========================================================= */

const API = "http://localhost:8000";
const WS = "ws://localhost:8000/ws";

const MODES = [
  ["normal", "Normal"],
  ["spike", "Sensor Spike"],
  ["drift", "Sensor Drift"],
  ["stuck", "Stuck Sensor"],
  ["dropout", "Communication Gap"],
  ["extreme", "Weather Event"],
];

/* =========================================================
   APP
========================================================= */

function App() {
  const [page, setPage] = useState("home");

  const [city, setCity] = useState("Pune");
  const [station, setStation] = useState("AWS_001");

  const [connected, setConnected] = useState(false);
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
  const [lastUpdate, setLastUpdate] = useState(null);

  const ws = useRef(null);
  const cityStrip = useRef(null);
  const recognition = useRef(null);

  /* =======================================================
     LOAD NETWORK
  ======================================================= */

  useEffect(() => {
    loadNetwork();
  }, []);

  async function loadNetwork() {
    try {
      const [citiesResponse, stationsResponse] = await Promise.all([
        fetch(`${API}/api/cities`),
        fetch(`${API}/api/stations`),
      ]);

      if (!citiesResponse.ok || !stationsResponse.ok) {
        throw new Error("Network API unavailable");
      }

      const citiesData = await citiesResponse.json();
      const stationsData = await stationsResponse.json();

      setCities(citiesData.cities || []);
      setStations(stationsData.stations || []);
    } catch (error) {
      console.error("Network catalogue error:", error);
    }
  }

  /* =======================================================
     WEBSOCKET LIFECYCLE
  ======================================================= */

  useEffect(() => {
    if (page !== "dashboard") {
      return undefined;
    }

    connect();

    return () => {
      if (ws.current) {
        ws.current.close();
      }
    };
  }, [page]);

  function connect() {
    if (ws.current) {
      try {
        ws.current.close();
      } catch (error) {
        console.warn("WebSocket close error:", error);
      }
    }

    const socket = new WebSocket(WS);
    ws.current = socket;

    socket.onopen = () => {
      setConnected(true);

      socket.send(
        JSON.stringify({
          type: "set_station",
          stationId: station,
        })
      );

      socket.send(
        JSON.stringify({
          type: "set_mode",
          mode,
        })
      );
    };

    socket.onclose = () => {
      setConnected(false);
    };

    socket.onerror = () => {
      setConnected(false);
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        /* -----------------------------------------------
           INITIAL CONNECTION
        ------------------------------------------------ */

        if (message.type === "connected") {
          setStations(message.stations || []);
          setCities(message.cityCatalog || []);
          return;
        }

        /* -----------------------------------------------
           MODE CHANGE
        ------------------------------------------------ */

        if (message.type === "mode") {
          setMode(message.mode);
          return;
        }

        /* -----------------------------------------------
           STATION SELECTION
        ------------------------------------------------ */

        if (message.type === "selection") {
          setStation(message.selectedStation);
          setMode(message.mode || "normal");
          return;
        }

        /* -----------------------------------------------
           ONLY PROCESS DECISION MESSAGES
        ------------------------------------------------ */

        if (message.type !== "decision") {
          return;
        }

        if (!message.observation) {
          return;
        }

        const observation = message.observation;
        const id = observation.stationId;

        setLastUpdate(Date.now());

        /* -----------------------------------------------
           LATEST DATA
        ------------------------------------------------ */

        setLatest((previous) => ({
          ...previous,
          [id]: message,
        }));

        /* -----------------------------------------------
           HISTORY
        ------------------------------------------------ */

        setHistory((previous) => {
          const oldHistory = previous[id] || [];

          const point = {
            time: new Date(
              observation.timestamp
            ).toLocaleTimeString("en-IN", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            }),

            temperature: safeNumber(
              observation.temperature
            ),

            pressure: safeNumber(
              observation.pressure
            ),

            humidity: safeNumber(
              observation.humidity
            ),
          };

          return {
            ...previous,
            [id]: [...oldHistory, point].slice(-36),
          };
        });

        /* -----------------------------------------------
           SELECTED STATION DATA
        ------------------------------------------------ */

        if (id === station) {
          setNearby(message.nearby || []);
          setDepartments(message.departments || null);

          const importantStatuses = [
            "FAULT SUSPECTED",
            "REVIEW REQUIRED",
            "WEATHER EVENT LIKELY",
            "COMMUNICATION GAP",
          ];

          const shouldCreateEvent =
            importantStatuses.includes(message.status) ||
            observation.sourceEvent !== "normal" ||
            mode !== "normal";

          if (shouldCreateEvent) {
            setEvents((previous) => ({
              ...previous,
              [id]: [
                message,
                ...(previous[id] || []),
              ].slice(0, 30),
            }));
          }
        }
      } catch (error) {
        console.error(
          "WebSocket message error:",
          error
        );
      }
    };
  }

  /* =======================================================
     CITY SELECTION
  ======================================================= */

  function openCity(cityObject) {
    if (!cityObject) {
      return;
    }

    const id = cityObject.stationId;

    setCity(cityObject.name);
    setStation(id);
    setTab("overview");
    setMode("normal");

    setLatest({});
    setHistory({});
    setEvents({});
    setNearby([]);
    setDepartments(null);

    setPage("dashboard");

    if (
      ws.current &&
      ws.current.readyState === WebSocket.OPEN
    ) {
      ws.current.send(
        JSON.stringify({
          type: "set_station",
          stationId: id,
        })
      );
    }
  }

  /* =======================================================
     STATION SELECTION
  ======================================================= */

  function chooseStation(id) {
    const selected = stations.find(
      (item) => item.id === id
    );

    if (!selected) {
      return;
    }

    setStation(id);
    setCity(selected.city);
    setMode("normal");
    setTab("overview");

    setLatest((previous) => ({
      ...previous,
      [id]: undefined,
    }));

    setHistory((previous) => ({
      ...previous,
      [id]: [],
    }));

    setEvents((previous) => ({
      ...previous,
      [id]: [],
    }));

    setNearby([]);
    setDepartments(null);

    if (
      ws.current &&
      ws.current.readyState === WebSocket.OPEN
    ) {
      ws.current.send(
        JSON.stringify({
          type: "set_station",
          stationId: id,
        })
      );
    }
  }

  /* =======================================================
     SCENARIO SELECTION
  ======================================================= */

  function chooseMode(value) {
    setMode(value);

    if (
      ws.current &&
      ws.current.readyState === WebSocket.OPEN
    ) {
      ws.current.send(
        JSON.stringify({
          type: "set_mode",
          mode: value,
        })
      );
    }
  }

  /* =======================================================
     VOICE SEARCH
  ======================================================= */

  function startVoice() {
    const SpeechRecognition =
      window.SpeechRecognition ||
      window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert(
        "Voice search is not supported in this browser. Please use Chrome or Edge."
      );
      return;
    }

    if (voice) {
      if (recognition.current) {
        recognition.current.stop();
      }

      setVoice(false);
      return;
    }

    const instance = new SpeechRecognition();

    recognition.current = instance;

    instance.lang = "en-IN";
    instance.interimResults = false;
    instance.continuous = false;

    instance.onstart = () => {
      setVoice(true);
    };

    instance.onend = () => {
      setVoice(false);
    };

    instance.onerror = () => {
      setVoice(false);
    };

    instance.onresult = (event) => {
      const spoken =
        event.results?.[0]?.[0]?.transcript?.trim() ||
        "";

      const normalized = spoken.toLowerCase();

      const found = cities.find((item) => {
        const name = item.name.toLowerCase();

        return (
          name.includes(normalized) ||
          normalized.includes(name)
        );
      });

      if (found) {
        setSearch(found.name);
        openCity(found);
      } else {
        setSearch(spoken);
      }
    };

    instance.start();
  }

  /* =======================================================
     CURRENT DATA
  ======================================================= */

  const current = latest[station];

  const currentHistory =
    history[station] || [];

  const currentEvents =
    events[station] || [];

  const cityStations = stations.filter(
    (item) => item.city === city
  );

  /* =======================================================
     HOME
  ======================================================= */

  if (page === "home") {
    return (
      <Home
        search={search}
        setSearch={setSearch}
        cities={cities}
        cityStrip={cityStrip}
        voice={voice}
        startVoice={startVoice}
        openCity={openCity}
      />
    );
  }

  /* =======================================================
     DASHBOARD
  ======================================================= */

  return (
    <Dashboard
      city={city}
      station={station}
      stationList={cityStations}
      connected={connected}
      mode={mode}
      tab={tab}
      setTab={setTab}
      current={current}
      history={currentHistory}
      nearby={nearby}
      departments={departments}
      events={currentEvents}
      chooseMode={chooseMode}
      chooseStation={chooseStation}
      back={() => setPage("home")}
      lastUpdate={lastUpdate}
      reconnect={connect}
    />
  );
}

/* =========================================================
   HOME PAGE
========================================================= */

function Home({
  search,
  setSearch,
  cities,
  cityStrip,
  voice,
  startVoice,
  openCity,
}) {
  const filteredCities = cities.filter((item) =>
    item.name
      .toLowerCase()
      .includes(search.toLowerCase())
  );

  const totalStations = cities.reduce(
    (total, item) =>
      total + Number(item.stationCount || 0),
    0
  );

  function scroll(amount) {
    if (!cityStrip.current) {
      return;
    }

    cityStrip.current.scrollBy({
      left: amount,
      behavior: "smooth",
    });
  }

  return (
    <div className="home-shell">
      {/* HERO */}

      <section className="home-hero">
        <div className="hero-topbar">
          <div className="brand-lockup">
            <div className="brand-mark">
              <Cloud size={19} />
            </div>

            <div>
              <strong>SKYGUARD</strong>
              <span>AI QUALITY CONTROL</span>
            </div>
          </div>

          <div className="hero-status">
            <span className="pulse-dot" />
            DEMO NETWORK
          </div>
        </div>

        <div className="hero-content">
          <div className="hero-kicker">
            REAL-TIME AWS QUALITY INTELLIGENCE
          </div>

          <h1>
            Weather data,
            <br />
            <span>made actionable.</span>
          </h1>

          <p>
            Continuous T / P / RH monitoring with
            temporal ML, physics context and
            nearby-station evidence.
          </p>

          {/* SEARCH */}

          <div className="hero-search">
            <Search size={21} />

            <input
              value={search}
              onChange={(event) =>
                setSearch(event.target.value)
              }
              placeholder="Search Maharashtra city or AWS station..."
            />

            {search && (
              <button
                className="clear-search"
                onClick={() => setSearch("")}
              >
                ×
              </button>
            )}

            <button
              className={
                voice
                  ? "voice-button listening"
                  : "voice-button"
              }
              onClick={startVoice}
              title="Voice search"
            >
              <Mic size={20} />
            </button>
          </div>

          {voice && (
            <div className="voice-status">
              <Volume2 size={14} />
              Listening… say a Maharashtra city
            </div>
          )}
        </div>
      </section>

      {/* MAIN */}

      <main className="home-content">
        {/* CITY NETWORK */}

        <section className="network-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">
                STATION NETWORK
              </span>

              <h2>Choose a station.</h2>

              <p>
                Open a live operator workspace for
                any simulated AWS node.
              </p>
            </div>

            <div className="network-summary">
              <strong>{cities.length}</strong>
              <span>Cities</span>

              <i />

              <strong>{totalStations}</strong>
              <span>AWS nodes</span>
            </div>
          </div>

          <div className="city-carousel">
            <button
              className="carousel-arrow"
              onClick={() => scroll(-430)}
              aria-label="Previous cities"
            >
              <ArrowLeft size={19} />
            </button>

            <div
              className="city-strip"
              ref={cityStrip}
            >
              {filteredCities.map(
                (cityItem, index) => (
                  <button
                    className="city-card"
                    key={cityItem.name}
                    onClick={() =>
                      openCity(cityItem)
                    }
                  >
                    <div className="city-card-top">
                      <div className="city-icon">
                        <CityIcon index={index} />
                      </div>

                      <span>
                        {cityItem.stationCount ||
                          0}{" "}
                        nodes
                      </span>
                    </div>

                    <strong>
                      {cityItem.name}
                    </strong>

                    <small>
                      {cityItem.prototypeStations
                        ? `${cityItem.prototypeStations} prototype nodes`
                        : "Synthetic AWS network"}
                    </small>

                    <div className="city-open">
                      Open station
                      <ChevronRight size={14} />
                    </div>
                  </button>
                )
              )}

              {filteredCities.length === 0 && (
                <div className="no-results">
                  No Maharashtra city matches "
                  {search}".
                </div>
              )}
            </div>

            <button
              className="carousel-arrow"
              onClick={() => scroll(430)}
              aria-label="Next cities"
            >
              <ArrowRight size={19} />
            </button>
          </div>
        </section>

        {/* PIPELINE */}

        <section className="how-section">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">
                DECISION PIPELINE
              </span>

              <h2>
                From observation to decision.
              </h2>
            </div>
          </div>

          <div className="pipeline">
            <PipelineStep
              number="01"
              icon={<Radio />}
              title="Collect"
              text="AWS continuously streams T / P / RH."
            />

            <PipelineConnector />

            <PipelineStep
              number="02"
              icon={<BrainCircuit />}
              title="Analyze"
              text="Temporal, physics and spatial evidence are evaluated."
            />

            <PipelineConnector />

            <PipelineStep
              number="03"
              icon={<ShieldCheck />}
              title="Classify"
              text="Weather event and sensor-fault evidence are separated."
            />

            <PipelineConnector />

            <PipelineStep
              number="04"
              icon={<Users />}
              title="Act"
              text="Operators receive an explainable next step."
            />
          </div>
        </section>

        {/* IMPACT */}

        <section className="hero-impact">
          <div>
            <span>SKYGUARD AI</span>

            <h2>
              See the signal.
              <br />
              Understand the reason.
            </h2>

            <p>
              Designed for operator review — not
              black-box automation.
            </p>
          </div>

          <div className="impact-orbit">
            <div>
              <Activity />
            </div>

            <span />
            <span />
            <span />
          </div>
        </section>

        {/* DOMAINS */}

        <section className="domain-section">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">
                DECISION CONTEXT
              </span>

              <h2>
                One quality engine. Different users.
              </h2>
            </div>
          </div>

          <div className="domain-grid">
            <DomainCard
              icon={<Leaf />}
              title="Agriculture"
              text="Protect advisories from questionable station data."
              tone="green"
            />

            <DomainCard
              icon={<AlertTriangle />}
              title="Disaster Management"
              text="Separate regional weather signals from sensor faults."
              tone="orange"
            />

            <DomainCard
              icon={<Plane />}
              title="Aviation"
              text="Surface station-quality context for operational review."
              tone="purple"
            />
          </div>
        </section>

        <footer className="home-footer">
          <span>
            SKYGUARD AI · SIH PROTOTYPE
          </span>

          <span>
            Synthetic demonstration network ·
            Operator decision support
          </span>
        </footer>
      </main>
    </div>
  );
}

/* =========================================================
   DASHBOARD
========================================================= */

function Dashboard({
  city,
  station,
  stationList,
  connected,
  mode,
  tab,
  setTab,
  current,
  history,
  nearby,
  departments,
  events,
  chooseMode,
  chooseStation,
  back,
  lastUpdate,
  reconnect,
}) {
  const observation =
    current?.observation;

  const fault = Number(
    current?.fault_probability || 0
  );

  const weather = Number(
    current?.weather_probability || 0
  );

  const confidence = Number(
    current?.confidence || 0
  );

  const freshness = lastUpdate
    ? Math.max(
        0,
        Math.floor(
          (Date.now() - lastUpdate) /
            1000
        )
      )
    : null;

  return (
    <div className="dashboard-shell">
      {/* HEADER */}

      <header className="operator-header">
        <div className="operator-left">
          <button
            className="back-button"
            onClick={back}
            aria-label="Back"
          >
            <ArrowLeft size={18} />
          </button>

          <div className="operator-brand">
            <div className="mini-logo">
              <Cloud size={16} />
            </div>

            <div>
              <strong>SKYGUARD</strong>
              <span>QUALITY CONTROL</span>
            </div>
          </div>

          <div className="header-divider" />

          <div className="station-identity">
            <strong>{city}</strong>
            <span>{station}</span>
          </div>
        </div>

        <div className="operator-right">
          <div
            className={
              connected
                ? "connection-status connected"
                : "connection-status"
            }
          >
            {connected ? (
              <Wifi size={15} />
            ) : (
              <WifiOff size={15} />
            )}

            <span>
              {connected
                ? "LIVE STREAM"
                : "CONNECTING"}
            </span>
          </div>

          {connected && (
            <div className="freshness">
              <CircleDot size={13} />

              {freshness === null
                ? "Waiting"
                : freshness <= 2
                ? "Updated just now"
                : `${freshness}s ago`}
            </div>
          )}

          <div className="operator-date">
            <span>
              {new Date().toLocaleDateString(
                "en-IN",
                {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                }
              )}
            </span>

            <strong>
              {new Date().toLocaleTimeString(
                "en-IN",
                {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                }
              )}{" "}
              IST
            </strong>
          </div>

          <button
            className="refresh-button"
            onClick={reconnect}
            title="Reconnect"
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </header>

      {/* WORKSPACE */}

      <div className="workspace">
        {/* SIDEBAR */}

        <aside className="workspace-sidebar">
          <div className="sidebar-label">
            STATION
          </div>

          <div className="station-picker">
            <div className="station-picker-icon">
              <Radio size={17} />
            </div>

            <div>
              <span>{city}</span>
              <strong>{station}</strong>
            </div>

            <ChevronDown size={15} />
          </div>

          <div className="sidebar-label">
            WORKSPACE
          </div>

          <nav className="workspace-nav">
            <NavButton
              active={tab === "overview"}
              onClick={() =>
                setTab("overview")
              }
              icon={<Activity />}
              label="Overview"
            />

            <NavButton
              active={tab === "fault"}
              onClick={() => setTab("fault")}
              icon={<ShieldAlert />}
              label="Sensor fault"
              value={fault > 0.45 ? "!" : ""}
              danger={fault > 0.45}
            />

            <NavButton
              active={tab === "weather"}
              onClick={() =>
                setTab("weather")
              }
              icon={<CloudRain />}
              label="Weather event"
              value={weather > 0.45 ? "!" : ""}
            />

            <NavButton
              active={tab === "nearby"}
              onClick={() =>
                setTab("nearby")
              }
              icon={<Network />}
              label="Station network"
            />

            <NavButton
              active={tab === "departments"}
              onClick={() =>
                setTab("departments")
              }
              icon={<Users />}
              label="Department insights"
            />

            <NavButton
              active={tab === "events"}
              onClick={() =>
                setTab("events")
              }
              icon={<Activity />}
              label="Event log"
              value={events.length || ""}
            />
          </nav>

          <div className="sidebar-bottom">
            <div className="demo-card">
              <div className="demo-card-head">
                <CircleDot size={14} />
                DEMO STREAM
              </div>

              <p>
                Current observations are
                synthetic AWS data for
                demonstration.
              </p>
            </div>

            <div className="operator-note">
              <ShieldCheck size={15} />

              <span>
                AI recommends.
                <br />
                Operator decides.
              </span>
            </div>
          </div>
        </aside>

        {/* MAIN */}

        <main className="workspace-main">
          <div className="workspace-titlebar">
            <div>
              <div className="breadcrumb">
                Operations
                <ChevronRight size={12} />
                {city}
              </div>

              <h1>
                Live station quality
              </h1>

              <p>
                Continuous observation and
                explainable quality assessment.
              </p>
            </div>

            <div className="scenario-control">
              <span>DEMO SCENARIO</span>

              <select
                value={mode}
                onChange={(event) =>
                  chooseMode(
                    event.target.value
                  )
                }
              >
                {MODES.map(
                  ([value, label]) => (
                    <option
                      value={value}
                      key={value}
                    >
                      {label}
                    </option>
                  )
                )}
              </select>
            </div>
          </div>

          {/* STATION CONTROL */}

          <div className="station-control-row">
            <div className="station-control">
              <MapPin size={16} />

              <span>Active AWS</span>

              <select
                value={station}
                onChange={(event) =>
                  chooseStation(
                    event.target.value
                  )
                }
              >
                {stationList.map((item) => (
                  <option
                    key={item.id}
                    value={item.id}
                  >
                    {item.id} — {item.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="scenario-pills">
              {MODES.slice(0, 5).map(
                ([value, label]) => (
                  <button
                    key={value}
                    className={
                      mode === value
                        ? "scenario-pill active"
                        : "scenario-pill"
                    }
                    onClick={() =>
                      chooseMode(value)
                    }
                  >
                    {label}
                  </button>
                )
              )}
            </div>
          </div>

          {/* TABS */}

          {tab === "overview" && (
            <Overview
              city={city}
              station={station}
              observation={observation}
              fault={fault}
              weather={weather}
              confidence={confidence}
              current={current}
              history={history}
              nearby={nearby}
              events={events}
              departments={departments}
            />
          )}

          {tab === "fault" && (
            <AnalysisTab
              type="fault"
              observation={observation}
              current={current}
              history={history}
              nearby={nearby}
            />
          )}

          {tab === "weather" && (
            <AnalysisTab
              type="weather"
              observation={observation}
              current={current}
              history={history}
              nearby={nearby}
            />
          )}

          {tab === "nearby" && (
            <Nearby
              nearby={nearby}
              station={station}
              observation={observation}
            />
          )}

          {tab === "departments" && (
            <DepartmentPage
              departments={departments}
            />
          )}

          {tab === "events" && (
            <EventPage events={events} />
          )}
        </main>
      </div>
    </div>
  );
}

/* =========================================================
   OVERVIEW
========================================================= */

function Overview({
  city,
  station,
  observation,
  fault,
  weather,
  confidence,
  current,
  history,
  nearby,
  events,
  departments,
}) {
  const weatherWins = weather >= fault;

  return (
    <>
      {/* AI DECISION */}

      <section
        className={
          weatherWins
            ? "decision-card weather"
            : "decision-card fault"
        }
      >
        <div className="decision-main">
          <div className="decision-icon">
            {weatherWins ? (
              <CloudRain />
            ) : (
              <ShieldAlert />
            )}
          </div>

          <div>
            <span className="decision-kicker">
              SKYGUARD AI DECISION
            </span>

            <h2>
              {weatherWins
                ? "Weather signal is stronger"
                : "Sensor anomaly is stronger"}
            </h2>

            <p>
              {current?.explanation?.[0] ||
                "Waiting for enough observations from the live stream."}
            </p>
          </div>
        </div>

        <div className="decision-scores">
          <Probability
            label="Weather event"
            value={weather}
            tone="weather"
          />

          <Probability
            label="Sensor fault"
            value={fault}
            tone="fault"
          />

          <div className="confidence-block">
            <span>AI confidence</span>

            <strong>
              {Math.round(
                confidence * 100
              )}
              %
            </strong>

            <div className="confidence-track">
              <i
                style={{
                  width: `${Math.min(
                    100,
                    confidence * 100
                  )}%`,
                }}
              />
            </div>
          </div>
        </div>

        <div className="decision-action">
          <span>
            Recommended next step
          </span>

          <strong>
            {current?.recommendation ||
              "Continue monitoring the station."}
          </strong>
        </div>
      </section>

      {/* CURRENT READINGS */}

      <section className="live-readings">
        <div className="section-inline-title">
          <div>
            <span className="eyebrow">
              CURRENT OBSERVATION
            </span>

            <h2>
              {city} · {station}
            </h2>
          </div>

          <span className="timestamp">
            {observation?.timestamp
              ? new Date(
                  observation.timestamp
                ).toLocaleTimeString(
                  "en-IN"
                )
              : "Waiting for stream"}
          </span>
        </div>

        <div className="reading-grid">
          <ReadingCard
            icon={<Thermometer />}
            label="Temperature"
            value={
              observation?.temperature
            }
            unit="°C"
            accent="blue"
          />

          <ReadingCard
            icon={<CloudRain />}
            label="Relative humidity"
            value={
              observation?.humidity
            }
            unit="%"
            accent="cyan"
          />

          <ReadingCard
            icon={<Gauge />}
            label="Pressure"
            value={
              observation?.pressure
            }
            unit="hPa"
            accent="purple"
          />

          <ReadingCard
            icon={<Radio />}
            label="Stream status"
            value={
              observation
                ? "LIVE"
                : "—"
            }
            unit=""
            accent="green"
            textValue
          />
        </div>
      </section>

      {/* SPATIAL + EVIDENCE */}

      <div className="primary-grid">
        <Comparison
          nearby={nearby}
          station={station}
          observation={observation}
        />

        <Evidence current={current} />
      </div>

      {/* TREND */}

      <Trend history={history} />

      {/* TIMELINE + DEPARTMENT */}

      <div className="secondary-grid">
        <Timeline events={events} />

        <DepartmentMini
          departments={departments}
        />
      </div>
    </>
  );
}

/* =========================================================
   PROBABILITY
========================================================= */

function Probability({
  label,
  value,
  tone,
}) {
  return (
    <div
      className={`probability ${tone}`}
    >
      <span>{label}</span>

      <strong>
        {Math.round(value * 100)}%
      </strong>

      <div className="probability-track">
        <i
          style={{
            width: `${Math.min(
              100,
              value * 100
            )}%`,
          }}
        />
      </div>
    </div>
  );
}

/* =========================================================
   READING CARD
========================================================= */

function ReadingCard({
  icon,
  label,
  value,
  unit,
  accent,
  textValue = false,
}) {
  const numeric =
    typeof value === "number" &&
    Number.isFinite(value);

  const display = textValue
    ? value
    : numeric
    ? value.toFixed(1)
    : "—";

  return (
    <div
      className={`reading-card ${accent}`}
    >
      <div className="reading-top">
        <div className="reading-icon">
          {icon}
        </div>

        <span>{label}</span>
      </div>

      <div className="reading-value">
        <strong>{display}</strong>

        {unit && (
          <small>{unit}</small>
        )}
      </div>

      <div className="reading-live">
        <span />

        {numeric || textValue
          ? "Live observation"
          : "Waiting for data"}
      </div>
    </div>
  );
}

/* =========================================================
   SPATIAL COMPARISON
========================================================= */

function Comparison({
  nearby,
  station,
  observation,
}) {
  const currentTemperature =
    safeNumber(
      observation?.temperature
    );

  const rows = [
    {
      stationId: station,
      stationName: "Selected station",
      temperature: currentTemperature,
      distanceKm: 0,
      selected: true,
    },
    ...(nearby || []),
  ].slice(0, 6);

  const numericRows = rows.filter(
    (row) =>
      safeNumber(row.temperature) !==
      null
  );

  const nearbyRows = numericRows.slice(
    1
  );

  const mean =
    nearbyRows.length > 0
      ? nearbyRows.reduce(
          (sum, row) =>
            sum +
            Number(row.temperature),
          0
        ) / nearbyRows.length
      : null;

  const deviation =
    mean !== null &&
    currentTemperature !== null
      ? Math.abs(
          currentTemperature - mean
        )
      : 0;

  const spatialFail =
    nearbyRows.length >= 2 &&
    deviation >= 5;

  return (
    <section className="panel comparison-panel">
      <PanelTitle
        eyebrow="SPATIAL EVIDENCE"
        title="Nearby station comparison"
        sub="Does the surrounding network see the same signal?"
      />

      <div className="network-visual">
        <div className="network-center">
          <div className="network-center-dot">
            <Radio size={18} />
          </div>

          <strong>{station}</strong>

          <span>
            {currentTemperature !== null
              ? `${currentTemperature.toFixed(
                  1
                )}°C`
              : "Waiting"}
          </span>
        </div>

        <div className="network-lines">
          {nearby
            .slice(0, 4)
            .map((item, index) => (
              <div
                className={`network-node node-${index}`}
                key={item.stationId}
              >
                <span />

                <div>
                  <strong>
                    {item.stationId}
                  </strong>

                  <small>
                    {safeNumber(
                      item.temperature
                    ) !== null
                      ? `${Number(
                          item.temperature
                        ).toFixed(
                          1
                        )}°C`
                      : "—"}
                  </small>
                </div>
              </div>
            ))}
        </div>
      </div>

      <div
        className={
          spatialFail
            ? "spatial-result fail"
            : "spatial-result pass"
        }
      >
        {spatialFail ? (
          <AlertTriangle size={17} />
        ) : (
          <CheckCircle2 size={17} />
        )}

        <div>
          <strong>
            {spatialFail
              ? "Spatial disagreement detected"
              : "Spatial pattern is currently coherent"}
          </strong>

          <span>
            {nearby.length
              ? `${nearby.length} nearby observations available for comparison.`
              : "Waiting for nearby station observations."}
          </span>
        </div>
      </div>
    </section>
  );
}

/* =========================================================
   EVIDENCE
========================================================= */

function Evidence({ current }) {
  const evidence =
    current?.evidence || {};

  return (
    <section className="panel evidence-panel">
      <PanelTitle
        eyebrow="FUSION ENGINE"
        title="Why the system decided"
        sub="Evidence is combined before the final classification."
      />

      <EvidenceRow
        label="Temporal ML"
        value={evidence.temporal || 0}
        icon={<Activity />}
      />

      <EvidenceRow
        label="Physics context"
        value={evidence.physics || 0}
        icon={<Gauge />}
      />

      <EvidenceRow
        label="Spatial evidence"
        value={evidence.spatial || 0}
        icon={<Network />}
      />

      <EvidenceRow
        label="Data validation"
        value={
          evidence.validation || 0
        }
        icon={<CheckCircle2 />}
      />

      <div className="explanation-box">
        <div>
          <BrainCircuit size={17} />
        </div>

        <div>
          <strong>
            AI explanation
          </strong>

          <p>
            {current?.explanation?.join(
              " "
            ) ||
              "Waiting for enough evidence to generate an explanation."}
          </p>
        </div>
      </div>
    </section>
  );
}

/* =========================================================
   EVIDENCE ROW
========================================================= */

function EvidenceRow({
  label,
  value,
  icon,
}) {
  const safeValue = Number(value) || 0;

  return (
    <div className="evidence-row">
      <div className="evidence-label">
        <span>{icon}</span>

        <strong>{label}</strong>

        <b>
          {Math.round(
            safeValue * 100
          )}
          %
        </b>
      </div>

      <div className="evidence-track">
        <i
          style={{
            width: `${Math.min(
              100,
              safeValue * 100
            )}%`,
          }}
        />
      </div>
    </div>
  );
}

/* =========================================================
   TREND
========================================================= */

function Trend({ history }) {
  const [metric, setMetric] =
    useState("temperature");

  const config = {
    temperature: {
      label: "Temperature",
      unit: "°C",
    },

    pressure: {
      label: "Pressure",
      unit: "hPa",
    },

    humidity: {
      label: "Relative humidity",
      unit: "%",
    },
  };

  const active =
    config[metric];

  const latestValue =
    history.length > 0
      ? safeNumber(
          history[
            history.length - 1
          ]?.[metric]
        )
      : null;

  return (
    <section className="panel trend-panel">
      <div className="trend-header">
        <PanelTitle
          eyebrow="TEMPORAL SIGNAL"
          title="Observation trend"
          sub="Recent station history — inspect one meteorological variable at a time."
        />

        <div className="metric-tabs">
          {Object.entries(config).map(
            ([key, item]) => (
              <button
                key={key}
                className={
                  metric === key
                    ? "active"
                    : ""
                }
                onClick={() =>
                  setMetric(key)
                }
              >
                {item.label}
              </button>
            )
          )}
        </div>
      </div>

      <div className="trend-summary">
        <div>
          <span>Current</span>

          <strong>
            {latestValue !== null
              ? latestValue.toFixed(1)
              : "—"}

            <small>
              {active.unit}
            </small>
          </strong>
        </div>

        <div>
          <span>Samples</span>
          <strong>
            {history.length}
          </strong>
        </div>

        <div>
          <span>Window</span>
          <strong>
            ~72 min
          </strong>
        </div>
      </div>

      <div className="trend-chart">
        {history.length > 0 ? (
          <ResponsiveContainer
            width="100%"
            height="100%"
          >
            <LineChart data={history}>
              <CartesianGrid
                stroke="#e7edf4"
                vertical={false}
              />

              <XAxis
                dataKey="time"
                tick={{
                  fontSize: 10,
                  fill: "#8491a2",
                }}
                axisLine={false}
                tickLine={false}
                minTickGap={35}
              />

              <YAxis
                width={46}
                tick={{
                  fontSize: 10,
                  fill: "#8491a2",
                }}
                axisLine={false}
                tickLine={false}
              />

              <Tooltip
                contentStyle={{
                  borderRadius: 12,
                  border:
                    "1px solid #e5eaf0",
                  boxShadow:
                    "0 10px 30px rgba(15,35,60,.10)",
                }}
              />

              <Line
                type="monotone"
                dataKey={metric}
                stroke="#1677ff"
                strokeWidth={3}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <Empty
            text="Waiting for the live observation stream."
          />
        )}
      </div>
    </section>
  );
}

/* =========================================================
   TIMELINE
========================================================= */

function Timeline({ events }) {
  return (
    <section className="panel timeline-panel">
      <PanelTitle
        eyebrow="AUDIT TRAIL"
        title="Event timeline"
        sub="Recent changes in the station's quality state."
      />

      {events.length > 0 ? (
        <div className="timeline">
          {events
            .slice(0, 6)
            .map((event, index) => (
              <div
                className="timeline-item"
                key={`${event.observation?.timestamp}-${index}`}
              >
                <div className="timeline-marker">
                  <span />
                </div>

                <div className="timeline-time">
                  {event.observation
                    ?.timestamp
                    ? new Date(
                        event.observation.timestamp
                      ).toLocaleTimeString(
                        "en-IN"
                      )
                    : "—"}
                </div>

                <div className="timeline-content">
                  <strong>
                    {event.status}
                  </strong>

                  <p>
                    {event.explanation?.[0] ||
                      "Quality state updated."}
                  </p>
                </div>
              </div>
            ))}
        </div>
      ) : (
        <Empty
          text="No quality event has been recorded yet."
        />
      )}
    </section>
  );
}

/* =========================================================
   DEPARTMENT MINI
========================================================= */

function DepartmentMini({
  departments,
}) {
  return (
    <section className="panel department-mini-panel">
      <PanelTitle
        eyebrow="DECISION CONTEXT"
        title="Department view"
        sub="Context changes with the current QC decision."
      />

      <div className="department-mini-list">
        {departments &&
          Object.entries(
            departments
          ).map(([key, item]) => (
            <div
              className={`department-mini ${key}`}
              key={key}
            >
              <div className="department-mini-icon">
                <DeptIcon k={key} />
              </div>

              <div>
                <span>
                  {key.toUpperCase()}
                </span>

                <strong>
                  {item.title}
                </strong>

                <p>
                  {item.instruction}
                </p>
              </div>
            </div>
          ))}

        {!departments && (
          <Empty
            text="Waiting for AI-generated department context."
          />
        )}
      </div>
    </section>
  );
}

/* =========================================================
   ANALYSIS TAB
========================================================= */

function AnalysisTab({
  type,
  observation,
  current,
  history,
  nearby,
}) {
  const fault = Number(
    current?.fault_probability || 0
  );

  const weather = Number(
    current?.weather_probability || 0
  );

  const value =
    type === "fault"
      ? fault
      : weather;

  return (
    <>
      <section
        className={
          type === "fault"
            ? "analysis-hero fault"
            : "analysis-hero weather"
        }
      >
        <div className="analysis-icon">
          {type === "fault" ? (
            <ShieldAlert />
          ) : (
            <CloudRain />
          )}
        </div>

        <div>
          <span>
            {type === "fault"
              ? "SENSOR QUALITY"
              : "METEOROLOGICAL EVENT"}
          </span>

          <h2>
            {type === "fault"
              ? "Sensor fault assessment"
              : "Weather event assessment"}
          </h2>

          <p>
            {current?.explanation?.join(
              " "
            ) ||
              "Waiting for evidence from the live stream."}
          </p>
        </div>

        <div className="analysis-score">
          <strong>
            {Math.round(
              value * 100
            )}
            %
          </strong>

          <span>
            {type === "fault"
              ? "fault likelihood"
              : "weather likelihood"}
          </span>
        </div>
      </section>

      <section className="live-readings">
        <div className="section-inline-title">
          <div>
            <span className="eyebrow">
              CURRENT OBSERVATION
            </span>

            <h2>
              Live station readings
            </h2>
          </div>
        </div>

        <div className="reading-grid">
          <ReadingCard
            icon={<Thermometer />}
            label="Temperature"
            value={
              observation?.temperature
            }
            unit="°C"
            accent="blue"
          />

          <ReadingCard
            icon={<CloudRain />}
            label="Relative humidity"
            value={
              observation?.humidity
            }
            unit="%"
            accent="cyan"
          />

          <ReadingCard
            icon={<Gauge />}
            label="Pressure"
            value={
              observation?.pressure
            }
            unit="hPa"
            accent="purple"
          />

          <ReadingCard
            icon={<Radio />}
            label="Data quality"
            value={
              observation?.quality ||
              "WAIT"
            }
            unit=""
            accent="green"
            textValue
          />
        </div>
      </section>

      <div className="primary-grid">
        <Evidence current={current} />

        <Comparison
          nearby={nearby}
          station={
            observation?.stationId ||
            "Selected"
          }
          observation={observation}
        />
      </div>

      <Trend history={history} />
    </>
  );
}

/* =========================================================
   NEARBY STATIONS
========================================================= */

function Nearby({
  nearby,
  station,
  observation,
}) {
  return (
    <section className="panel full-panel">
      <PanelTitle
        eyebrow="STATION NETWORK"
        title="Nearby observations"
        sub="The spatial layer gives the selected station regional context."
      />

      <div className="nearby-hero">
        <div>
          <span>
            SELECTED STATION
          </span>

          <strong>{station}</strong>

          <p>
            Current temperature:{" "}
            {safeNumber(
              observation?.temperature
            ) !== null
              ? `${Number(
                  observation.temperature
                ).toFixed(1)}°C`
              : "—"}
          </p>
        </div>

        <div className="nearby-count">
          <strong>
            {nearby.length}
          </strong>

          <span>
            nearby nodes
          </span>
        </div>
      </div>

      {nearby.length > 0 ? (
        <div className="nearby-grid">
          {nearby.map((item) => (
            <div
              className="nearby-card"
              key={item.stationId}
            >
              <div className="nearby-card-top">
                <div className="nearby-station-icon">
                  <Radio size={17} />
                </div>

                <span>
                  {item.distanceKm
                    ? `${Number(
                        item.distanceKm
                      ).toFixed(1)} km`
                    : "Reference"}
                </span>
              </div>

              <strong>
                {item.stationId}
              </strong>

              <small>
                {item.stationName ||
                  "Reference AWS"}
              </small>

              <div className="nearby-reading">
                <b>
                  {safeNumber(
                    item.temperature
                  ) !== null
                    ? Number(
                        item.temperature
                      ).toFixed(1)
                    : "—"}
                </b>

                <span>°C</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty
          text="Waiting for nearby station observations."
        />
      )}
    </section>
  );
}

/* =========================================================
   DEPARTMENT PAGE
========================================================= */

function DepartmentPage({
  departments,
}) {
  return (
    <section className="panel full-panel">
      <PanelTitle
        eyebrow="OPERATIONAL CONTEXT"
        title="Department insights"
        sub="Human-readable guidance derived from the current station-quality state."
      />

      {departments ? (
        <div className="department-page-grid">
          {Object.entries(
            departments
          ).map(([key, item]) => (
            <div
              className={`department-page-card ${key}`}
              key={key}
            >
              <div className="department-page-icon">
                <DeptIcon k={key} />
              </div>

              <span>
                {key.toUpperCase()}
              </span>

              <h3>
                {item.title}
              </h3>

              <p>
                {item.instruction}
              </p>

              <div className="department-status">
                <CheckCircle2 size={14} />
                Operator review context
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty
          text="Waiting for the AI decision before generating department context."
        />
      )}
    </section>
  );
}

/* =========================================================
   EVENT PAGE
========================================================= */

function EventPage({ events }) {
  return (
    <section className="panel full-panel">
      <PanelTitle
        eyebrow="AUDIT TRAIL"
        title="Event log"
        sub="Quality-control events generated by the selected station."
      />

      {events.length > 0 ? (
        <div className="event-table">
          <div className="event-table-head">
            <span>STATUS</span>
            <span>TIME</span>
            <span>EXPLANATION</span>
            <span>CONFIDENCE</span>
          </div>

          {events.map(
            (event, index) => (
              <div
                className="event-row"
                key={`${event.observation?.timestamp}-${index}`}
              >
                <span
                  className={
                    event.status ===
                    "FAULT SUSPECTED"
                      ? "event-status danger"
                      : "event-status"
                  }
                >
                  {event.status}
                </span>

                <span>
                  {event.observation
                    ?.timestamp
                    ? new Date(
                        event.observation.timestamp
                      ).toLocaleTimeString(
                        "en-IN"
                      )
                    : "—"}
                </span>

                <p>
                  {event.explanation?.join(
                    " "
                  ) || "—"}
                </p>

                <strong>
                  {Math.round(
                    Number(
                      event.confidence || 0
                    ) * 100
                  )}
                  %
                </strong>
              </div>
            )
          )}
        </div>
      ) : (
        <Empty
          text="No quality-control events yet. Activate a demonstration scenario to create one."
        />
      )}
    </section>
  );
}

/* =========================================================
   PANEL TITLE
========================================================= */

function PanelTitle({
  eyebrow,
  title,
  sub,
}) {
  return (
    <div className="panel-title">
      {eyebrow && (
        <span className="eyebrow">
          {eyebrow}
        </span>
      )}

      <h2>{title}</h2>

      {sub && <p>{sub}</p>}
    </div>
  );
}

/* =========================================================
   NAV BUTTON
========================================================= */

function NavButton({
  active,
  onClick,
  icon,
  label,
  value,
  danger,
}) {
  return (
    <button
      className={
        active
          ? "nav-button active"
          : "nav-button"
      }
      onClick={onClick}
    >
      <span className="nav-icon">
        {icon}
      </span>

      <span>{label}</span>

      {value && (
        <b
          className={
            danger
              ? "nav-value danger"
              : "nav-value"
          }
        >
          {value}
        </b>
      )}
    </button>
  );
}

/* =========================================================
   PIPELINE STEP
========================================================= */

function PipelineStep({
  number,
  icon,
  title,
  text,
}) {
  return (
    <div className="pipeline-step">
      <div className="pipeline-icon">
        {icon}
      </div>

      <span>{number}</span>

      <strong>{title}</strong>

      <p>{text}</p>
    </div>
  );
}

/* =========================================================
   PIPELINE CONNECTOR
========================================================= */

function PipelineConnector() {
  return (
    <div className="pipeline-connector">
      <ArrowRight size={17} />
    </div>
  );
}

/* =========================================================
   DOMAIN CARD
========================================================= */

function DomainCard({
  icon,
  title,
  text,
  tone,
}) {
  return (
    <div
      className={`domain-card ${tone}`}
    >
      <div className="domain-icon">
        {icon}
      </div>

      <div>
        <strong>{title}</strong>

        <p>{text}</p>
      </div>

      <ChevronRight size={17} />
    </div>
  );
}

/* =========================================================
   CITY ICON
========================================================= */

function CityIcon({ index }) {
  const icons = [
    <MapPin key="map" />,
    <Cloud key="cloud" />,
    <Gauge key="gauge" />,
    <Network key="network" />,
    <Radio key="radio" />,
    <Activity key="activity" />,
  ];

  return icons[
    index % icons.length
  ];
}

/* =========================================================
   DEPARTMENT ICON
========================================================= */

function DeptIcon({ k }) {
  if (k === "agriculture") {
    return <Leaf />;
  }

  if (k === "disaster") {
    return <AlertTriangle />;
  }

  return <Plane />;
}

/* =========================================================
   EMPTY STATE
========================================================= */

function Empty({ text }) {
  return (
    <div className="empty-state">
      <Info size={18} />

      <span>{text}</span>
    </div>
  );
}

/* =========================================================
   NUMBER HELPER
========================================================= */

function safeNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return number;
}

/* =========================================================
   ROOT
========================================================= */

const rootElement =
  document.getElementById("root");

if (!rootElement) {
  throw new Error(
    "Root element #root was not found."
  );
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);