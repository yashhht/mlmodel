"""SkyGuard synthetic AWS network generator, v2.  DEMO/SIMULATED data - NOT IMD.

What changed vs v1 (and why it matters for ML):
  * Every station gets its OWN random fault schedule (v1 injected identical faults on
    every station at the same hours, so a "sensor fault" looked like a regional event
    and train/test data leaked into each other).
  * Weather events are REGIONAL: every station in a city moves together.
  * Stations in a city share a common weather process, so neighbours normally agree
    and a single faulty sensor genuinely stands out.
Same CSV schema as v1, so the Node backend and React frontend need no change.
"""
from pathlib import Path
import csv, json, math, zlib
from datetime import datetime, timedelta, timezone
import numpy as np

ROOT = Path(__file__).resolve().parent
PROFILES = json.loads((ROOT / "climate_profiles.json").read_text(encoding="utf-8"))
STATIONS = json.loads((ROOT / "stations.json").read_text(encoding="utf-8"))["stations"]
HOURS, SEED = 24 * 30, 42


def sea_to_station_pressure(p_sl, elev):
    return p_sl * (1 - 2.25577e-5 * elev) ** 5.25588


def ar1(rng, n, sigma, phi=0.97):
    x = np.zeros(n)
    eps = rng.normal(0, sigma * math.sqrt(1 - phi ** 2), n)
    for i in range(1, n):
        x[i] = phi * x[i - 1] + eps[i]
    return x


def smooth_envelope(n, ramp):
    """0 -> 1 over `ramp` hours, hold, 1 -> 0 over `ramp` hours."""
    ramp = max(1, min(ramp, n // 2))
    e = np.ones(n)
    up = np.linspace(0, 1, ramp + 1)[1:]
    e[:ramp], e[-ramp:] = up, up[::-1]
    return e


def city_weather_events(rng):
    """2-4 regional events per city. Returns list of (start, dur, dT, dP, dRH)."""
    events, busy = [], np.zeros(HOURS, bool)
    for _ in range(int(rng.integers(2, 5))):
        dur, start = int(rng.integers(6, 19)), int(rng.integers(40, HOURS - 40))
        if busy[max(0, start - 6):start + dur + 6].any():
            continue
        busy[start:start + dur] = True
        if rng.random() < 0.5:   # storm / rain: cooler, wetter, pressure drop
            ev = (start, dur, -rng.uniform(3, 7), -rng.uniform(3, 7), rng.uniform(12, 24))
        else:                    # heat / dry spell
            ev = (start, dur, rng.uniform(4, 7.5), -rng.uniform(1, 3), -rng.uniform(10, 18))
        events.append(ev)
    return events


def place_faults(rng, busy):
    """Independent random fault episodes for ONE station. Returns list of (type, start, dur)."""
    plan = (["sensor_spike", "sensor_drift", "sensor_stuck", "humidity_offset", "communication_dropout"] +
            [k for k in ("sensor_spike", "sensor_stuck") if rng.random() < 0.5])   # ~10% faulty rows
    faults = []
    for kind in plan:
        dur = {"sensor_spike": int(rng.choice([1, 2, 3, 6, 12])),
               "sensor_drift": int(rng.integers(24, 61)),
               "sensor_stuck": int(rng.integers(8, 25)),
               "humidity_offset": int(rng.integers(8, 25)),
               "communication_dropout": int(rng.integers(3, 13))}[kind]
        for _ in range(60):
            start = int(rng.integers(30, HOURS - dur - 5))
            if not busy[max(0, start - 3):start + dur + 3].any():
                busy[start:start + dur] = True
                faults.append((kind, start, dur))
                break
    return faults


for city in sorted({s["city"] for s in STATIONS}):
    city_st = [s for s in STATIONS if s["city"] == city]
    prof = PROFILES[city]
    crng = np.random.default_rng([SEED, zlib.crc32(city.encode())])
    c_t, c_p, c_rh = ar1(crng, HOURS, 1.2), ar1(crng, HOURS, 2.0), ar1(crng, HOURS, 5.0)
    phase = crng.uniform(0, 6.28)
    events = city_weather_events(crng)
    mean_elev = float(np.mean([s["elevation"] for s in city_st]))
    ev_busy = np.zeros(HOURS, bool)
    for st, du, *_ in events:
        ev_busy[st:st + du] = True

    for s in city_st:
        rng = np.random.default_rng([SEED, zlib.crc32(s["id"].encode())])
        h = np.arange(HOURS)
        daily = np.sin((h % 24 - 6) / 24 * 2 * math.pi)
        T = (prof["temperature"] + 4 * daily + c_t - 0.0065 * (s["elevation"] - mean_elev)
             + rng.normal(0, 0.3, HOURS) + rng.uniform(-0.3, 0.3))
        RH = prof["humidity"] - 8 * daily + c_rh + rng.normal(0, 1.2, HOURS) + rng.uniform(-1.5, 1.5)
        Psl = 1011 + 3 * np.sin(h / 30 + phase) + c_p + rng.normal(0, 0.25, HOURS)
        event = np.array(["normal"] * HOURS, dtype=object)
        label = np.zeros(HOURS, int)

        for st, du, dT, dP, dRH in events:                       # regional weather (label 0)
            env = smooth_envelope(du, int(rng.integers(1, 5))) * rng.uniform(0.8, 1.2)
            T[st:st + du] += dT * env; Psl[st:st + du] += dP * env; RH[st:st + du] += dRH * env
            event[st:st + du] = "weather_event"

        P = sea_to_station_pressure(Psl, s["elevation"])
        RH = np.clip(RH, 1, 100)
        missing = np.zeros(HOURS, bool)
        for kind, st, du in place_faults(rng, ev_busy.copy()):   # independent per-station faults
            sl = slice(st, st + du)
            if kind == "sensor_spike":
                r = rng.random()
                sign = rng.choice([-1, 1])
                if r < 0.70:   T[sl] += sign * rng.uniform(12, 30)
                elif r < 0.85: RH[sl] = np.clip(RH[sl] + sign * rng.uniform(30, 50), 0, 100)
                else:          P[sl] += sign * rng.uniform(15, 40)
            elif kind == "sensor_drift":
                if rng.random() < 0.8: T[sl] += np.linspace(0, rng.uniform(0.1, 0.3) * du, du)
                else:                  RH[sl] = np.clip(RH[sl] + np.linspace(0, rng.uniform(0.3, 0.8) * du, du), 0, 100)
            elif kind == "sensor_stuck":
                T[sl], P[sl], RH[sl] = T[st - 1], P[st - 1], RH[st - 1]
            elif kind == "humidity_offset":
                RH[sl] = np.clip(RH[sl] + rng.choice([-1, 1]) * rng.uniform(18, 30), 0, 100)
            else:
                missing[sl] = True
            event[sl], label[sl] = kind, 1

        T, P, RH = np.clip(T, -40, 60).round(2), np.clip(P, 850, 1100).round(2), np.clip(RH, 0, 100).round(2)
        out = ROOT / "raw" / city
        out.mkdir(parents=True, exist_ok=True)
        t0 = datetime(2026, 8, 1, tzinfo=timezone.utc)
        with open(out / f"{s['id']}.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["timestamp", "station_id", "city", "temperature", "pressure", "humidity",
                        "quality", "event", "fault_label"])
            for i in range(HOURS):
                ts = (t0 + timedelta(hours=i)).isoformat()
                if missing[i]:
                    w.writerow([ts, s["id"], city, "", "", "", "MISSING", "communication_dropout", 1])
                else:
                    w.writerow([ts, s["id"], city, T[i], P[i], RH[i], "GOOD", event[i], label[i]])

print(f"Generated {len(STATIONS)} stations across {len({s['city'] for s in STATIONS})} cities (v2).")
print("Data status: DEMO/SIMULATED - not an official IMD feed.")
