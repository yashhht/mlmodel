from pathlib import Path
from fastapi import FastAPI
import numpy as np
import joblib

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "data" / "models"

app = FastAPI(title="SkyGuard AI City ML Service")
MODEL_CACHE = {}

FEATURE_NAMES = [
    "dt", "dp", "dr", "temp_z", "pressure_z", "rh_z",
    "flatline", "cross", "neighbor_temp", "neighbor_pressure", "neighbor_rh"
]


def num(v, default=0.0):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except Exception:
        return default


def load_model(city: str):
    if city in MODEL_CACHE:
        return MODEL_CACHE[city]
    path = MODEL_DIR / f"{city}.joblib"
    if not path.exists():
        path = MODEL_DIR / "Pune.joblib"
    model = joblib.load(path)
    MODEL_CACHE[city] = model
    return model


def feature_vector(o, history, neighbors):
    t = num(o.get("temperature"))
    p = num(o.get("pressure"))
    r = num(o.get("humidity"))
    usable = [x for x in history if x.get("temperature") is not None]
    prev = usable[-2] if len(usable) >= 2 else o
    dt = t - num(prev.get("temperature"), t)
    dp = p - num(prev.get("pressure"), p)
    dr = r - num(prev.get("humidity"), r)

    def z(key, value):
        vals = np.array([num(x.get(key), value) for x in usable[-20:]], dtype=float)
        if len(vals) == 0:
            return 0.0
        return float((value - vals.mean()) / (vals.std() + 1e-3))

    recent = usable[-6:]
    temps = [num(x.get("temperature"), t) for x in recent]
    flatline = 1.0 if len(temps) >= 4 and max(temps) - min(temps) < 0.03 else 0.0
    cross = max(0.0, abs(dt) / 5.0 - (abs(dr) / 15.0 + abs(dp) / 5.0))

    if neighbors:
        nt = float(np.mean([num(x.get("temperature"), t) for x in neighbors]))
        np_ = float(np.mean([num(x.get("pressure"), p) for x in neighbors]))
        nr = float(np.mean([num(x.get("humidity"), r) for x in neighbors]))
    else:
        nt, np_, nr = t, p, r

    return np.array([[dt, dp, dr, z("temperature", t), z("pressure", p), z("humidity", r),
                      flatline, cross, t - nt, p - np_, r - nr]], dtype=float)


def weather_evidence(o, history, neighbors):
    t = num(o.get("temperature"))
    p = num(o.get("pressure"))
    r = num(o.get("humidity"))
    usable = [x for x in history if x.get("pressure") is not None]
    prev = usable[-2] if len(usable) >= 2 else o
    dp = p - num(prev.get("pressure"), p)
    score = 0.0
    if t > 34 or t < 10:
        score += 0.22
    if r > 80:
        score += 0.18
    # Station pressure depends on elevation, so use a change-from-local-baseline
    # rather than an absolute 998 hPa threshold.
    if dp < -2.5:
        score += 0.20
    if neighbors:
        nt = float(np.mean([num(x.get("temperature"), t) for x in neighbors]))
        np_ = float(np.mean([num(x.get("pressure"), p) for x in neighbors]))
        nr = float(np.mean([num(x.get("humidity"), r) for x in neighbors]))
        coherent = abs(t - nt) < 4.0 and abs(r - nr) < 18.0 and abs(p - np_) < 5.0
        if coherent and (t > 32 or r > 78 or dp < -2.0):
            score += 0.45
    return min(score, 1.0)


def spatial_evidence(o, neighbors):
    if not neighbors:
        return 0.0
    t = num(o.get("temperature"))
    p = num(o.get("pressure"))
    r = num(o.get("humidity"))
    nt = float(np.mean([num(x.get("temperature"), t) for x in neighbors]))
    np_ = float(np.mean([num(x.get("pressure"), p) for x in neighbors]))
    nr = float(np.mean([num(x.get("humidity"), r) for x in neighbors]))
    return float(min((abs(t - nt) / 6 + abs(p - np_) / 5 + abs(r - nr) / 20) / 3, 1))


@app.get("/health")
def health():
    return {"ok": True, "models": len(MODEL_CACHE), "model_type": "city-specific RandomForest development baseline"}


@app.post("/predict")
def predict(payload: dict):
    o = payload.get("observation") or {}
    h = payload.get("history") or []
    n = payload.get("neighbors") or []
    city = o.get("city") or "Pune"

    t = num(o.get("temperature"), np.nan)
    p = num(o.get("pressure"), np.nan)
    r = num(o.get("humidity"), np.nan)

    if not np.isfinite(t) or not np.isfinite(p) or not np.isfinite(r):
        return {
            "status": "COMMUNICATION GAP",
            "fault_probability": 0.99,
            "weather_probability": 0.0,
            "confidence": 0.99,
            "evidence": {"validation": 0, "temporal": 0, "physics": 0, "spatial": 0},
            "explanation": ["One or more T/P/RH observations are missing."],
            "recommendation": "Check telemetry, power and communication path before using this station operationally."
        }

    if not (-60 <= t <= 70 and 850 <= p <= 1100 and 0 <= r <= 100):
        return {
            "status": "REVIEW REQUIRED",
            "fault_probability": 0.99,
            "weather_probability": 0.01,
            "confidence": 0.99,
            "evidence": {"validation": 1, "temporal": 1, "physics": 0.5, "spatial": 0},
            "explanation": ["Value outside configured sensor validity range."],
            "recommendation": "Retain the raw observation and inspect the sensor/telemetry path."
        }

    x = feature_vector(o, h, n)
    model = load_model(city)
    temporal = float(model.predict_proba(x)[0, 1])
    spatial = spatial_evidence(o, n)
    weather = weather_evidence(o, h, n)

    physics = min(
        0.45 * abs(x[0, 0]) / 8 +
        0.30 * abs(x[0, 1]) / 5 +
        0.25 * abs(x[0, 2]) / 25,
        1.0,
    )

    # Conservative fusion: the city model is the main learned evidence;
    # spatial/physics/weather context modifies the operational interpretation.
    fault = float(np.clip(
        0.70 * temporal + 0.25 * spatial + 0.15 * physics - 0.20 * weather,
        0.0, 1.0
    ))

    status = (
        "FAULT SUSPECTED" if fault >= 0.72
        else "REVIEW REQUIRED" if fault >= 0.45
        else "OBSERVATION PLAUSIBLE"
    )

    if weather >= 0.62 and spatial < 0.45 and fault < 0.65:
        status = "WEATHER EVENT LIKELY"

    if status == "FAULT SUSPECTED":
        action = "Flag for maintenance review; preserve the raw observation and compare with nearby stations."
    elif status == "WEATHER EVENT LIKELY":
        action = "Treat as a coherent meteorological signal; retain observations and follow official weather-warning workflows."
    elif status == "REVIEW REQUIRED":
        action = "Continue monitoring and request operator review before applying a quality flag."
    else:
        action = "Retain observation and continue monitoring."

    reasons = []
    if temporal > 0.65:
        reasons.append(f"{city} city model detected a strong fault pattern")
    if abs(x[0, 0]) > 4:
        reasons.append("rapid temperature movement")
    if x[0, 6] > 0.5:
        reasons.append("possible stuck/flatline pattern")
    if spatial > 0.55:
        reasons.append("nearby stations disagree")
    if weather > 0.55:
        reasons.append("coherent meteorological-event evidence")
    if not reasons:
        reasons.append("no strong fault signature detected")

    return {
        "status": status,
        "fault_probability": round(fault, 4),
        "weather_probability": round(weather, 4),
        "confidence": round(max(fault, weather, 1 - max(fault, weather)), 4),
        "model_city": city,
        "evidence": {
            "validation": 1.0,
            "temporal": round(temporal, 4),
            "physics": round(physics, 4),
            "spatial": round(spatial, 4),
        },
        "explanation": reasons,
        "recommendation": action,
    }
