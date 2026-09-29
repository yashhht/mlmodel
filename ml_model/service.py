"""SkyGuard ML service (FastAPI).  Same /predict contract the Node backend already uses.
Run:  uvicorn service:app --host 127.0.0.1 --port 8100
Channel 1 = Random Forest (known fault patterns)   Channel 2 = Autoencoder (novelty alarm)
Rule layer (missing data, validity ranges) always runs.  Trained on SYNTHETIC data - demo baseline."""
import json
from pathlib import Path
import joblib
import numpy as np
from fastapi import FastAPI
from features import CH, FEATURES, build_features, num, split_history, triple

ROOT = Path(__file__).resolve().parents[1]
BUNDLE_PATH = ROOT / "data" / "models" / "skyguard.joblib"
METRICS_PATH = ROOT / "data" / "models" / "metrics.json"
app = FastAPI(title="SkyGuard AI ML Service")
_state = {}
NAMES = {"temperature": "Temperature", "pressure": "Pressure", "humidity": "Humidity"}


def bundle():
    if "b" not in _state:
        if not BUNDLE_PATH.exists():
            raise RuntimeError("Model not found - run `python train.py` in ml_model/ first.")
        _state["b"] = joblib.load(BUNDLE_PATH)
    return _state["b"]


def shap_explainer():
    if "shap" not in _state:
        try:
            import shap
            _state["shap"] = shap.TreeExplainer(bundle()["rf"])
        except Exception:                      # shap optional: service still works without it
            _state["shap"] = None
    return _state["shap"]


def shap_drivers(x, cls_idx, k=3):
    ex = shap_explainer()
    if ex is None:
        return None
    sv = ex.shap_values(x.reshape(1, -1))
    contrib = sv[cls_idx][0] if isinstance(sv, list) else np.asarray(sv)[0, :, cls_idx]
    order = np.argsort(-np.abs(contrib))[:k]
    return [(FEATURES[i], float(contrib[i])) for i in order]


def reasons_from(x, meta):
    f = dict(zip(FEATURES, x))
    r = []
    if meta["spatial_available"] and (abs(f["nbT"]) > 3 or abs(f["nbRH"]) > 12 or abs(f["nbP"]) > 4):
        r.append(f"station disagrees with {meta['n_neighbors']} nearby station(s): "
                 f"dT {f['nbT']:+.1f} C, dRH {f['nbRH']:+.0f} %, dP {f['nbP']:+.1f} hPa")
    if abs(f["dT"]) > 5:
        r.append(f"abrupt temperature change of {f['dT']:+.1f} C since the previous reading")
    if f["stuck_run"] >= 3:
        r.append(f"readings unchanged for {int(f['stuck_run'])} consecutive steps (possible frozen sensor)")
    if abs(f["rh_resid"]) > 15 or abs(f["td_jump"]) > 4:
        r.append("temperature and humidity are physically inconsistent (dew point jumped)")
    return r


def neutral(status, fault, msg, action, missing=None):
    return {"status": status, "fault_probability": fault, "weather_probability": 0.0, "confidence": fault,
            "evidence": {"validation": 0, "temporal": 0, "physics": 0, "spatial": 0},
            "explanation": [msg], "recommendation": action, "missing_channels": missing or [],
            "meta_alerts": [], "degraded": False}


@app.get("/health")
def health():
    b = bundle()
    return {"ok": True, "model_type": "RandomForest (known faults) + Autoencoder (novelty)", "sklearn_trained_with": b["sklearn"],
            "trained_on": b["trained_on"], "shap": shap_explainer() is not None}


@app.get("/metrics")
def metrics():
    return json.loads(METRICS_PATH.read_text(encoding="utf-8")) if METRICS_PATH.exists() else {}


@app.post("/predict")
def predict(payload: dict):
    o = payload.get("observation") or {}
    city = o.get("city") or "Unknown"
    vals = {k: num(o.get(k)) for k in CH}
    missing = [k for k, v in vals.items() if v is None]
    if missing:                                              # typed missing-value flag: never guess/impute
        got = [NAMES[k] for k in CH if k not in missing]
        msg = ("Full telemetry dropout: temperature, pressure and humidity all missing." if len(missing) == 3 else
               f"Partial dropout: {', '.join(NAMES[k].lower() for k in missing)} missing ({', '.join(got).lower()} received).")
        return neutral("COMMUNICATION GAP", 0.99, msg,
                       "Check telemetry, power and communication path before using this station operationally.", missing)

    t, p, r = vals["temperature"], vals["pressure"], vals["humidity"]
    bad = [n for n, ok in (("temperature", -60 <= t <= 70), ("pressure", 850 <= p <= 1100), ("humidity", 0 <= r <= 100)) if not ok]
    if bad:
        out = neutral("REVIEW REQUIRED", 0.99, f"Value outside configured sensor validity range: {', '.join(bad)}.",
                      "Retain the raw observation and inspect the sensor/telemetry path.")
        out["evidence"] = {"validation": 1, "temporal": 1, "physics": 0.5, "spatial": 0}
        out["weather_probability"] = 0.01
        return out

    alerts = []
    past = split_history(o, payload.get("history"))
    x, meta = build_features(o, past, payload.get("neighbors"))
    B = bundle()
    known, weather, ftype, probs = 0.0, 0.0, None, None
    try:                                                     # channel 1
        pr = B["rf"].predict_proba(x.reshape(1, -1))[0]
        known, weather = float(pr[2:].sum()), float(pr[1])
        probs = pr
        if known >= 0.3:
            ftype = B["classes"][2 + int(np.argmax(pr[2:]))]
    except Exception as e:                                   # neutral default + meta-alert, never silent
        alerts.append(f"Known-fault classifier failed ({type(e).__name__}); its vote was set to neutral.")
    nov = 0.0
    try:                                                     # channel 2
        sx = B["scaler"].transform(x.reshape(1, -1))
        err = float(((B["ae"].predict(sx) - sx) ** 2).mean())
        nov = float(np.searchsorted(B["cal_ae"], err) / len(B["cal_ae"]))
    except Exception as e:
        alerts.append(f"Novelty detector failed ({type(e).__name__}); its vote was set to neutral.")

    novel_hit = nov >= B["nov_t"]
    if known >= B["fault_t"]:
        status = "FAULT SUSPECTED"
    elif known >= B["review_t"] or novel_hit:
        status = "REVIEW REQUIRED"
    elif weather >= B.get("weather_t", 0.5):
        status = "WEATHER EVENT LIKELY"
    else:
        status = "OBSERVATION PLAUSIBLE"
    fault = known if not (novel_hit and known < B["review_t"]) else max(known, 0.5)

    f = dict(zip(FEATURES, x))
    evidence = {"validation": 1.0,
                "temporal": round(min(1.0, max(max(abs(f["zT"]), abs(f["zP"]), abs(f["zRH"])) / 6, abs(f["dT"]) / 12, f["stuck_run"] / 8)), 4),
                "physics": round(min(1.0, max(abs(f["rh_resid"]) / 25, abs(f["td_jump"]) / 6)), 4),
                "spatial": round(min(1.0, max(abs(f["nbT"]) / 6, abs(f["nbP"]) / 5, abs(f["nbRH"]) / 20)), 4) if meta["spatial_available"] else 0.0}

    why = []
    if status in ("FAULT SUSPECTED", "REVIEW REQUIRED"):
        if ftype:
            why.append(f"pattern matches known fault type: {ftype.replace('sensor_', '').replace('_', ' ')} (evidence builds as more readings arrive)")
        if novel_hit and known < B["review_t"]:
            why.append("unfamiliar pattern: does not match any known fault signature but is unlike healthy behaviour")
        why += reasons_from(x, meta)
        try:
            d = shap_drivers(x, 2 + int(np.argmax(probs[2:]))) if probs is not None else None
            if d:
                why.append("top model drivers (SHAP): " + ", ".join(f"{n} ({v:+.2f})" for n, v in d))
        except Exception:
            pass
    elif status == "WEATHER EVENT LIKELY":
        why.append("large change shared with nearby stations - consistent with a real meteorological event")
        why += [s for s in reasons_from(x, meta) if "disagrees" not in s]
    if not meta["baseline_available"]:
        why.append(f"baseline unavailable: only {meta['n_past']} past valid readings, so history-based checks are neutral")
    if not meta["spatial_available"]:
        why.append("spatial comparison unavailable: no valid nearby stations, so it was not used as evidence")
    if not why:
        why.append("no strong fault signature detected")

    action = {"FAULT SUSPECTED": "Flag for maintenance review; preserve the raw observation and compare with nearby stations.",
              "WEATHER EVENT LIKELY": "Treat as a coherent meteorological signal; retain observations and follow official weather-warning workflows.",
              "REVIEW REQUIRED": "Continue monitoring and request operator review before applying a quality flag.",
              "OBSERVATION PLAUSIBLE": "Retain observation and continue monitoring."}[status]
    conf = {"FAULT SUSPECTED": fault, "REVIEW REQUIRED": max(fault, nov if novel_hit else 0.0),
            "WEATHER EVENT LIKELY": weather, "OBSERVATION PLAUSIBLE": 1 - max(fault, weather)}[status]
    return {"status": status, "fault_probability": round(fault, 4), "weather_probability": round(weather, 4),
            "confidence": round(float(conf), 4), "model_city": city, "fault_type": ftype, "novelty_score": round(nov, 4),
            "evidence": evidence, "evidence_available": {"baseline": meta["baseline_available"], "spatial": meta["spatial_available"]},
            "explanation": why, "recommendation": action, "missing_channels": [], "meta_alerts": alerts, "degraded": bool(alerts)}
