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
