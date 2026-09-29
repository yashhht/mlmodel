"""Shared feature engineering: used by BOTH train.py and service.py (no train/serve skew)."""
import math
import numpy as np

FEATURES = ["dT", "dP", "dRH",                      # change since previous valid reading
            "zT", "zP", "zRH",                      # deviation from station's own last-24h baseline
            "stuck_run",                            # consecutive unchanged readings (frozen sensor)
            "td_jump", "rh_resid",                  # physics: moisture continuity (dew point / RH)
            "nbT", "nbP", "nbRH", "nb_spread"]      # spatial: station minus nearby-station mean
SPATIAL = ["nbT", "nbP", "nbRH", "nb_spread"]
CH = ("temperature", "pressure", "humidity")
Z_FLOOR = (0.5, 0.5, 1.5)                            # std floors ~ normal sensor noise
MIN_BASELINE = 6                                     # fewer valid past points -> baseline "unavailable"


def num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def triple(o):
    v = [num(o.get(k)) for k in CH]
    return tuple(v) if all(x is not None for x in v) else None


def t_sea(t, elev):  return t + 0.0065 * elev                       # lapse-rate reduction
def p_sea(p, elev):  return p / (1 - 2.25577e-5 * elev) ** 5.25588   # standard-atmosphere reduction
def _e(t):           return 6.112 * math.exp(17.62 * t / (243.12 + t))


def dewpoint(t, rh):
    g = math.log(max(rh, 1.0) / 100.0) + 17.62 * t / (243.12 + t)
    return 243.12 * g / (17.62 - g)


def split_history(obs, history):
    """Backend sends history INCLUDING the current reading -> drop it. Returns valid past triples."""
    past = []
    for h in history or []:
        if h.get("sequence") is not None and h.get("sequence") == obs.get("sequence") \
           and h.get("stationId") == obs.get("stationId"):
            continue
        tr = triple(h)
        if tr is not None:
            past.append(tr)
    return past


def build_features(obs, past, neighbors):
    """obs: dict with T/P/RH (all valid). past: list of valid (T,P,RH) triples, oldest->newest.
    neighbors: list of dicts (latest readings, may contain nulls). Returns (vector, meta)."""
    T, P, RH = triple(obs)
    elev = num(obs.get("elevation")) or 0.0
    prev = past[-1] if past else None
    dT, dP, dRH = ((T - prev[0]), (P - prev[1]), (RH - prev[2])) if prev else (0.0, 0.0, 0.0)

    win = past[-24:]
    base_ok = len(win) >= MIN_BASELINE
    if base_ok:
        a = np.asarray(win)
        z = [(v - a[:, k].mean()) / max(a[:, k].std(), Z_FLOOR[k]) for k, v in enumerate((T, P, RH))]
    else:
        z = [0.0, 0.0, 0.0]

    seq, run = list(past) + [(T, P, RH)], 0
    for k in range(len(seq) - 1, 0, -1):
        if all(abs(seq[k][j] - seq[k - 1][j]) < 0.005 for j in range(3)):
            run += 1
        else:
            break
    run = min(run, 12)

    td_jump = rh_resid = 0.0
    if prev:
        td_prev, td_now = dewpoint(prev[0], prev[2]), dewpoint(T, RH)
        td_jump = td_now - td_prev
        rh_resid = RH - min(100.0, max(0.0, 100.0 * _e(td_prev) / _e(T)))

    nb = []
    for n in neighbors or []:
        tr = triple(n)
        if tr is not None:
            e = num(n.get("elevation")) or 0.0
            nb.append((t_sea(tr[0], e), p_sea(tr[1], e), tr[2]))
    if nb:
        b = np.asarray(nb)
        nbT, nbP, nbRH = t_sea(T, elev) - b[:, 0].mean(), p_sea(P, elev) - b[:, 1].mean(), RH - b[:, 2].mean()
        spread = float(b[:, 0].std()) if len(nb) > 1 else 0.0
    else:
        nbT = nbP = nbRH = spread = 0.0

    x = np.array([dT, dP, dRH, z[0], z[1], z[2], run, td_jump, rh_resid, nbT, nbP, nbRH, spread], float)
    return x, {"baseline_available": base_ok, "n_past": len(past), "spatial_available": bool(nb), "n_neighbors": len(nb)}
