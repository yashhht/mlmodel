# SkyGuard AI — ML Pipeline

Detects faulty AWS sensor readings in real time and tells the difference between
"the sensor is lying" and "the weather is actually doing this."

## What's here

| File | What it does |
|---|---|
| `features.py` | Turns a raw reading + history + neighbour readings into the 13 numbers the models actually look at. Shared by training and serving so they never drift apart. |
| `train.py` | Trains the two model channels, evaluates them honestly (unseen test cities, baseline comparisons, ablations), saves `data/models/skyguard.joblib`. |
| `service.py` | FastAPI service. Same `/predict` contract the Node backend already calls — nothing on the backend/frontend needs to change. |
| `test_scenarios.py` | Replays the backend's own demo scenarios (spike/drift/stuck/dropout/extreme weather) through the trained model, no servers needed. |

## How detection works

**Channel 1 — Random Forest (known faults).** Trained on 5 fault types your teammate's
synthetic generator injects: spike, drift, stuck sensor, humidity offset, dropout.
Uses spatial (nearby-station comparison) and physics (dew-point consistency) features,
not just raw thresholds.

**Channel 2 — Autoencoder (novelty).** Trained ONLY on healthy readings. Flags anything
that doesn't look like "normal," even fault patterns it's never been shown. This is what
catches real-world faults that don't match your five synthetic categories.

**Rule layer** (missing data, physically impossible values) always runs first and never
goes through the ML models — no model should ever "impute" a missing sensor reading.

## Run it

```bash
pip install -r requirements.txt

# 1. Regenerate the synthetic data (independent faults per station, ~10% fault rate)
python ../data/generate_synthetic_aws.py

# 2. Train + evaluate (prints honest metrics against test cities never seen in training)
python train.py

# 3. Check it against the backend's actual demo scenarios
python test_scenarios.py

# 4. Run the service the Node backend talks to
uvicorn service:app --host 127.0.0.1 --port 8100
```

## Honest numbers (synthetic data — read as relative comparisons, not real-world accuracy)

See `data/models/metrics.json` after training for the full breakdown, including:
- Comparison against a rule-based QC baseline and a naive z-score rule
- Ablation: Random Forest with vs. without spatial (nearby-station) features
- Episode-level detection rate and latency per fault type
- Recall on a fault type withheld entirely from training (tests real generalization,
  not just memorization of the synthetic categories)
- Full precision/recall operating curve so you can justify whichever threshold you pick

Current headline numbers on held-out test cities: ~85% recall / ~92% precision on
known fault types at a false-alarm rate of roughly 1 flag per 8 station-days;
100% detection on spikes, stuck sensors, and dropouts; ~70% on gradual drift
(genuinely harder — it looks like real weather until it's built up).
