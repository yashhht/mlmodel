"""Train + honestly evaluate the SkyGuard QC models.     Run:  python train.py
Pipeline: CSV streams -> shared features -> split BY CITY (train/val/test) ->
   channel 1  Random Forest  : probability of KNOWN fault patterns (supervised, uses spatial+physics features)
   channel 2  Autoencoder    : NOVELTY alarm for patterns never seen (unsupervised, trained on healthy data only)
   thresholds chosen on validation cities by false-alarm budget -> metrics on unseen TEST cities."""
import csv, json, math, time, warnings
from pathlib import Path
import joblib, numpy as np, sklearn
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, precision_recall_curve
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler
from features import FEATURES, SPATIAL, CH, build_features, triple

ROOT = Path(__file__).resolve().parents[1]
DATA, RAW, MODELS = ROOT / "data", ROOT / "data" / "raw", ROOT / "data" / "models"
CLASSES = ["normal", "weather_event", "sensor_spike", "sensor_drift", "sensor_stuck", "humidity_offset"]
CID = {c: i for i, c in enumerate(CLASSES)}
FAULT4 = set(CLASSES[2:])
SP_IDX = [FEATURES.index(f) for f in SPATIAL]
NS_IDX = [i for i in range(len(FEATURES)) if i not in SP_IDX]
rng = np.random.default_rng(42)
warnings.filterwarnings('ignore', category=Warning)   # keep beginner-friendly output clean
FPR_REVIEW, FPR_FAULT, FPR_NOVEL = 0.006, 0.002, 0.004   # false-alarm budgets on healthy readings (union ~1% = ~0.24/station-day)


# ------------------------------------------------------------------ data
def load_network():
    stations = json.loads((DATA / "stations.json").read_text(encoding="utf-8"))["stations"]
    rows = {}
    for s in stations:
        fp = RAW / s["city"] / f"{s['id']}.csv"
        rr = []
        for r in csv.DictReader(open(fp, encoding="utf-8")):
            rr.append({"temperature": r["temperature"] or None, "pressure": r["pressure"] or None,
                       "humidity": r["humidity"] or None, "elevation": s["elevation"], "event": r["event"]})
        rows[s["id"]] = rr
    return stations, rows


def haversine(a, b):
    p = math.pi / 180
    x = math.sin((b["lat"] - a["lat"]) * p / 2) ** 2 + math.cos(a["lat"] * p) * math.cos(b["lat"] * p) * \
        math.sin((b["lon"] - a["lon"]) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(x))


def nearest(stations):     # same rule as backend nearbyFor(): same city, 5 nearest
    return {s["id"]: [o["id"] for o in sorted((o for o in stations if o["city"] == s["city"] and o["id"] != s["id"]),
                                              key=lambda o: haversine(s, o))[:5]] for s in stations}


def build(stations, rows, nbrs, augment):
    X, y, meta = [], [], []
    for s in stations:
        R = rows[s["id"]]
        for i, r in enumerate(R):
            tr = triple(r)
            if tr is None or r["event"] not in CID:        # dropout rows are handled by a rule, not the model
                continue
            past = [t for t in (triple(q) for q in R[max(0, i - 29):i]) if t is not None]
            nb = [rows[n][i] for n in nbrs[s["id"]]]
            if augment:                                     # teach the model about missing context
                if rng.random() < 0.08: nb = []
                if rng.random() < 0.05: past = past[len(past) - int(rng.integers(0, 6)):] if past else past
            x, _ = build_features(r, past, nb)
            X.append(x); y.append(CID[r["event"]]); meta.append((s["id"], i, r["event"], *tr))
    return np.array(X), np.array(y), meta


# ------------------------------------------------------------------ metrics
def ecdf(sorted_ref):
    return lambda v: np.searchsorted(sorted_ref, v) / len(sorted_ref)


def thr_at_fpr(score_val, y_val, fpr):
    """Threshold that lets through at most `fpr` of healthy readings (normal + weather) on validation cities."""
    return float(np.quantile(score_val[y_val < 2], 1 - fpr))


def evaluate(flag, y, meta):
    pos, neg = y >= 2, y < 2
    tp, fp = int((flag & pos).sum()), int((flag & neg).sum())
    prec, rec = tp / max(tp + fp, 1), tp / max(pos.sum(), 1)
    out = {"precision": round(prec, 3), "recall": round(rec, 3), "f1": round(2 * prec * rec / max(prec + rec, 1e-9), 3),
           "false_alarms_per_station_day": round(fp / max(neg.sum(), 1) * 24, 2),
           "weather_event_false_alarm_rate": round(float(flag[y == 1].mean()), 3),
           "recall_by_type": {c: round(float(flag[y == CID[c]].mean()), 3) for c in CLASSES[2:]}}
    lat = {c: [] for c in CLASSES[2:]}; count = {c: 0 for c in CLASSES[2:]}; k, n = 0, len(meta)
    while k < n:                                       # episode-level view: was each fault episode caught, and how fast?
        st, ev = meta[k][0], meta[k][2]
        if ev in FAULT4:
            j = k
            while j + 1 < n and meta[j + 1][0] == st and meta[j + 1][1] == meta[j][1] + 1 and meta[j + 1][2] == ev: j += 1
            hit = np.flatnonzero(flag[k:j + 1]); count[ev] += 1
            if len(hit): lat[ev].append(int(hit[0]))
            k = j + 1
        else:
            k += 1
    tot = sum(count.values()); det = sum(len(v) for v in lat.values()); allv = [x for v in lat.values() for x in v]
    out["episodes"] = {"total": tot, "detected_pct": round(100 * det / max(tot, 1), 1),
                       "median_latency_readings": float(np.median(allv)) if allv else None,
                       "detected_pct_by_type": {c: round(100 * len(lat[c]) / max(count[c], 1), 1) for c in count},
                       "median_latency_by_type": {c: (float(np.median(lat[c])) if lat[c] else None) for c in count}}
    return out


# ------------------------------------------------------------------ main
if __name__ == "__main__":
    t0 = time.time()
    stations, rows = load_network()
    nbrs = nearest(stations)
    cities = sorted({s["city"] for s in stations}); rng.shuffle(cities)
    split = {"test": set(cities[:7]), "val": set(cities[7:14]), "train": set(cities[14:])}
    sub = lambda k: [s for s in stations if s["city"] in split[k]]
    print(f"cities  train={len(split['train'])} val={len(split['val'])} test={len(split['test'])}  (test cities are NEVER seen in training)")
    Xtr, ytr, _ = build(sub("train"), rows, nbrs, augment=True)
    Xva, yva, mva = build(sub("val"), rows, nbrs, augment=False)
    Xte, yte, mte = build(sub("test"), rows, nbrs, augment=False)
    print(f"rows    train={len(ytr)} val={len(yva)} test={len(yte)}  fault rate={np.mean(yte>=2):.1%}  [{time.time()-t0:.0f}s]")

    RF = lambda n: RandomForestClassifier(n_estimators=n, max_depth=12, min_samples_leaf=5, class_weight="balanced_subsample",
                                          n_jobs=-1, random_state=42)
    rf = RF(150).fit(Xtr, ytr)
    rf_ns = RF(150).fit(Xtr[:, NS_IDX], ytr)                                    # ablation: no spatial features
    norm = ytr < 2                                                             # unsupervised models learn "healthy" only
    sc = StandardScaler().fit(Xtr[norm])
    ae = MLPRegressor(hidden_layer_sizes=(10, 4, 10), activation="tanh", max_iter=400, early_stopping=True,
                      random_state=42).fit(sc.transform(Xtr[norm]), sc.transform(Xtr[norm]))
    iso = IsolationForest(n_estimators=200, max_samples=512, random_state=42).fit(Xtr[norm])   # tested for comparison only
    ae_raw = lambda X: ((ae.predict(sc.transform(X)) - sc.transform(X)) ** 2).mean(1)
    cal_ae = np.sort(ae_raw(Xva[yva < 2])); cal = ecdf(cal_ae)
    iso_cal = ecdf(np.sort(-iso.decision_function(Xva[yva < 2])))
    known = lambda X: rf.predict_proba(X)[:, 2:].sum(1)                        # P(any known fault)
    kva, kte = known(Xva), known(Xte)
    nva, nte = cal(ae_raw(Xva)), cal(ae_raw(Xte))                              # novelty score in [0,1]
    wva, wte = rf.predict_proba(Xva)[:, 1], rf.predict_proba(Xte)[:, 1]        # P(regional weather event)
    weather_t = float(np.quantile(wva[yva == 0], 0.995))
    print(f"weather-event threshold {weather_t:.3f}: on TEST it labels {np.mean(wte[yte == 0] >= weather_t):.2%} of normal rows 'weather' "
          f"and recognises {np.mean(wte[yte == 1] >= weather_t):.0%} of real weather-event rows")
    ova, ote = iso_cal(-iso.decision_function(Xva)), iso_cal(-iso.decision_function(Xte))
    review_t, fault_t, nov_t = thr_at_fpr(kva, yva, FPR_REVIEW), thr_at_fpr(kva, yva, FPR_FAULT), thr_at_fpr(nva, yva, FPR_NOVEL)
    flag = lambda k, n, m=1.0: (k >= thr_at_fpr(kva, yva, FPR_REVIEW * m)) | (n >= thr_at_fpr(nva, yva, FPR_NOVEL * m))
    print(f"val false-alarm rate of the combined review flag: {np.mean(flag(kva, nva)[yva < 2]):.2%}")

    Tt = np.array([q[3] for q in mte])
    rules = {"Rule-based QC (range+step+persistence)": (Tt < -10) | (Tt > 50) | (np.abs(Xte[:, 0]) > 6) | (np.abs(Xte[:, 2]) > 30)
                                                        | (np.abs(Xte[:, 1]) > 6) | (Xte[:, 6] >= 6),
             "Rolling z-score rule (>3.5 sigma)": np.abs(Xte[:, 3:6]).max(1) > 3.5}
    nsva, nste = rf_ns.predict_proba(Xva[:, NS_IDX])[:, 2:].sum(1), rf_ns.predict_proba(Xte[:, NS_IDX])[:, 2:].sum(1)
    one = lambda sv, st: st >= thr_at_fpr(sv, yva, 0.01)                        # single scorers compared at a 1% budget
    methods = {**rules,
               "Isolation Forest only (tested, not used)": one(ova, ote), "Autoencoder only": one(nva, nte),
               "Random Forest, NO spatial features": one(nsva, nste), "Random Forest only (known faults)": one(kva, kte),
               "SkyGuard = RF + novelty autoencoder": flag(kte, nte)}
    results = {k: evaluate(v, yte, mte) for k, v in methods.items()}
    for k, (sv, st) in {"Isolation Forest only (tested, not used)": (ova, ote), "Autoencoder only": (nva, nte),
                        "Random Forest, NO spatial features": (nsva, nste), "Random Forest only (known faults)": (kva, kte)}.items():
        results[k]["average_precision"] = round(float(average_precision_score(yte >= 2, st)), 3)

    print(f"\nTEST cities, {len(yte)} readings -- SYNTHETIC data: read as a RELATIVE comparison, not real-world accuracy")
    print(f"{'method':42s}{'prec':>6s}{'recall':>8s}{'FA/day':>8s}{'wx-FA':>7s}{'episodes':>10s}{'latency':>9s}{'AP':>6s}")
    for k, v in results.items():
        e = v["episodes"]
        print(f"{k:42s}{v['precision']:6.2f}{v['recall']:8.2f}{v['false_alarms_per_station_day']:8.2f}"
              f"{v['weather_event_false_alarm_rate']:7.2f}{str(e['detected_pct'])+'%':>10s}{str(e['median_latency_readings']):>9s}{v.get('average_precision', float('nan')):6.2f}")
    fin = results["SkyGuard = RF + novelty autoencoder"]
    print("\nSkyGuard recall by type     ", fin["recall_by_type"])
    print("SkyGuard episodes caught (%)", fin["episodes"]["detected_pct_by_type"])
    print("SkyGuard median latency     ", fin["episodes"]["median_latency_by_type"], "(readings after onset)")
    print("operating curve (SkyGuard, test) -- pick the trade-off operators can live with:")
    curve = {}
    for m in (0.33, 0.5, 1, 2, 5):
        r = evaluate(flag(kte, nte, m), yte, mte)
        curve[str(m)] = {"recall": r["recall"], "precision": r["precision"], "episodes_detected_pct": r["episodes"]["detected_pct"],
                         "false_alarms_per_station_day": r["false_alarms_per_station_day"]}
        print(f"   budget x{m:<4}: recall {r['recall']:.2f}  precision {r['precision']:.2f}  episodes caught {r['episodes']['detected_pct']:.0f}%  FA/station-day {r['false_alarms_per_station_day']:.2f}")
    results["_operating_curve"] = curve

    print("\nNOVEL-FAULT TEST -- recall on a fault type withheld from ALL training (same false-alarm budget):")
    nov = {}
    for f in CLASSES[2:]:
        ktr = ytr != CID[f]
        r2 = RF(60).fit(Xtr[ktr], ytr[ktr]); fc = [i for i, c in enumerate(r2.classes_) if c >= 2]
        k2v, k2t = r2.predict_proba(Xva)[:, fc].sum(1), r2.predict_proba(Xte)[:, fc].sum(1)
        m = yte == CID[f]
        rf_only = k2t >= thr_at_fpr(k2v, yva, FPR_REVIEW)
        both = rf_only | (nte >= nov_t)
        nov[f] = {"RF alone": round(float(rf_only[m].mean()), 3), "Autoencoder alone": round(float((nte >= nov_t)[m].mean()), 3),
                  "RF + novelty AE": round(float(both[m].mean()), 3)}
        print(f"   unseen {f:16s}", nov[f])
    results["_novel_fault_recall"] = nov

    MODELS.mkdir(exist_ok=True)
    for old in MODELS.glob("*.joblib"): old.unlink()                           # remove obsolete per-city models
    joblib.dump({"rf": rf, "ae": ae, "scaler": sc, "cal_ae": cal_ae, "review_t": review_t, "fault_t": fault_t, "nov_t": nov_t, "weather_t": weather_t,
                 "features": FEATURES, "classes": CLASSES, "sklearn": sklearn.__version__,
                 "trained_on": "synthetic v2 (demo data)"}, MODELS / "skyguard.joblib")
    (MODELS / "metrics.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    import os
    imp = sorted(zip(FEATURES, rf.feature_importances_), key=lambda z: -z[1])
    print("\nRandom-Forest feature importance:", ", ".join(f"{n} {v:.2f}" for n, v in imp))
    print(f"model file: {os.path.getsize(MODELS / 'skyguard.joblib') / 1e6:.1f} MB")
    print(f"\nthresholds: REVIEW>={review_t:.3f}  FAULT>={fault_t:.3f}  NOVELTY>={nov_t:.3f}")
    print(f"saved data/models/skyguard.joblib + metrics.json   [{time.time()-t0:.0f}s total]")
