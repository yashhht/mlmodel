# SkyGuard AI — Reactive Multi-City AWS Quality Control

A SIH prototype for real-time Automatic Weather Station quality control using **Temperature, Pressure and Relative Humidity**.

## Architecture

```text
T / P / RH
    ↓
Data Validation
    ↓
┌──────────────┬────────────────┬─────────────────┐
│ Temporal ML  │ Physics Context│ Spatial Evidence│
└──────────────┴────────────────┴─────────────────┘
                    ↓
              Fusion Model
                    ↓
        ┌───────────┴───────────┐
        ↓                       ↓
 Weather Event             Sensor Fault
        └───────────┬───────────┘
                    ↓
               Confidence
                    ↓
              Explanation
                    ↓
             React Dashboard
```

## What's included in this version

- React operator dashboard.
- Node.js + WebSocket continuous stream.
- Python FastAPI ML service.
- 35 Maharashtra city profiles.
- 114 synthetic AWS station streams.
- The 10 `AWS_001`–`AWS_010` Pune records from the supplied prototype are preserved and marked `originalPrototype: true`.
- Three city-specific reference stations for most cities.
- City-specific development ML models stored in `data/models/`.
- T/P/RH historical CSV data in `data/raw/`.
- Normal stream, sensor spike, drift, stuck sensor, communication gap and regional weather-event simulations.
- Real nearby-station comparison using the network stream instead of random values.
- Event timeline, event log and department insight generation.
- Station selector inside the dashboard.

## Important data note

The included observations are **controlled synthetic demonstration data**. They are not live IMD observations and should not be presented as official IMD measurements. Replace the ingestion layer with verified AWS observations before claiming operational real-world performance.

## Run

### 1. Python ML

```powershell
cd ml_model
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn service:app --host 127.0.0.1 --port 8100
```

### 2. Node backend

Open a second terminal:

```powershell
cd backend
npm install
npm start
```

Backend: `http://localhost:8000`  
WebSocket: `ws://localhost:8000/ws`

### 3. React frontend

Open a third terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open the Vite URL, normally `http://localhost:5173`.

## Regenerate data

The repository already contains generated data and trained models. To regenerate the synthetic CSV streams:

```powershell
cd data
python generate_synthetic_aws.py
```

Then retrain city models:

```powershell
cd ..\ml_model
python train_city_models.py
```

The training script creates one development model per city under `data/models/`.

## Demo flow

1. Open a city from the landing page.
2. Choose a station from the dashboard selector.
3. Watch T/P/RH update every two seconds.
4. Inspect nearby stations — these are other stations in the same city stream.
5. Toggle **Sensor Spike**, **Sensor Drift**, **Stuck Sensor**, **Communication Gap** or **Weather Event**.
6. Watch the evidence, decision, timeline, event log and department instructions change.

## Scientific positioning

The city-specific models are a **development baseline trained on synthetic data**. Their outputs are not operational accuracy claims. For a defensible SIH evaluation, benchmark against a documented QC baseline and test separately on realistic sensor faults and genuine meteorological events. Preserve raw observations and let operators decide whether a record is retained, flagged or excluded.


## Operator UI update
- Added a compact observation lifecycle strip (received, validated, compared, decision, operator review).
- Added nearby AWS temperature-coherence comparison with explicit unavailable-data handling.
- Spatial coherence is contextual evidence only; it does not by itself prove a weather event or sensor fault.
- Raw observations remain preserved; the interface does not claim automatic correction or alert dispatch.
- The included station data is synthetic/demo data unless separately documented as an original source.

## Frontend UX refresh (September 2026)
- Reworked `frontend/src/main.jsx` and `frontend/src/styles.css` with a responsive landing page and operator console.
- Added a clear synthetic-data banner, searchable city cards, keyboard-visible focus states, mobile navigation, connection status and reconnect control.
- Consolidated scenario controls and surfaced assessment, T/P/RH readings, observation lifecycle, spatial evidence, evidence breakdown, trends and review log.
- Improved unavailable-data messaging so missing neighboring observations are not described as spatial agreement.
- Added guarded WebSocket callbacks, station/mode refs, duplicate review-event suppression and safer display handling for missing readings/explanations.
- Backend, ML service, trained development models and synthetic station data are retained in this archive.

The frontend build was not verified in this environment because dependency installation did not complete before timeout. Run `npm install` followed by `npm run build` in `frontend/` locally to verify against your environment.
