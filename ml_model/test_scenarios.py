"""Replays the Node backend's demo scenarios through the ML service. Run: python test_scenarios.py
(no servers needed).  Mimics backend/server.js: nearest-5 same-city neighbours, 30-reading history INCLUDING the current one."""
import csv
from pathlib import Path
from collections import Counter
from service import predict
from train import load_network, nearest

stations, rows = load_network()
byid = {s["id"]: s for s in stations}
nb = nearest(stations)


def clean_start(sid, n):
    """First window where the target station AND its neighbours are all healthy (label 'normal') for n readings."""
    group = [sid] + nb[sid]
    for st in range(30, len(rows[sid]) - n):
        if all(rows[g][j]["event"] == "normal" for g in group for j in range(st, st + n)):
            return st
    return 30


def reading(sid, i, seq):
    r, s = rows[sid][i], byid[sid]
    return {"stationId": sid, "city": s["city"], "elevation": s["elevation"], "sequence": seq,
            "temperature": float(r["temperature"]) if r["temperature"] else None,
            "pressure": float(r["pressure"]) if r["pressure"] else None,
            "humidity": float(r["humidity"]) if r["humidity"] else None, "quality": "GOOD"}


def run(sid, mode, n=45, onset=15, start=None):
    START = clean_start(sid, n) if start is None else start
    city = byid[sid]["city"]
    hist, latest, seq, out = {}, {}, 0, []
    for k in range(n):
        for s in stations:
            if s["city"] != city:
                continue
            seq += 1
            rd = reading(s["id"], START + k, seq)
            h = hist.setdefault(s["id"], [])
            if k >= onset and mode != "normal":
                if s["id"] == sid:
                    if mode == "spike" and rd["temperature"] is not None: rd["temperature"] += 24
                    if mode == "drift": rd["temperature"] += min(12, len(h) * 0.18)
                    if mode == "stuck" and h: rd.update({c: h[-1][c] for c in ("temperature", "pressure", "humidity")})
                    if mode == "dropout": rd.update(temperature=None, pressure=None, humidity=None, quality="MISSING")
                if mode == "extreme" and rd["temperature"] is not None:
                    rd["temperature"] += 6.5; rd["pressure"] -= 5.0; rd["humidity"] = min(100, rd["humidity"] + 18)
            latest[s["id"]] = rd
            h.append(rd)
            if len(h) > 50: h.pop(0)
        cur = latest[sid]
        neigh = [latest[n_] for n_ in nb[sid] if n_ in latest]
        res = predict({"observation": cur, "history": hist[sid][-30:], "neighbors": neigh})
        out.append(res)
    return out


def short(res):
    return {"FAULT SUSPECTED": "F", "REVIEW REQUIRED": "R", "OBSERVATION PLAUSIBLE": ".", "WEATHER EVENT LIKELY": "W",
            "COMMUNICATION GAP": "G"}[res["status"]]


if __name__ == "__main__":
    for city_sid in ("AWS_001", "AWS-N-001" if "AWS-N-001" in byid else next(s["id"] for s in stations if s["city"] == "Nagpur")):
        print(f"\n=== station {city_sid} ({byid[city_sid]['city']}, {len(nb[city_sid])} neighbours) ===")
        print("legend: . plausible  R review  F fault  W weather-event  G comm-gap   | scenario switches on at tick 15")
        for mode in ("normal", "spike", "drift", "stuck", "dropout", "extreme"):
            res = run(city_sid, mode)
            print(f"{mode:8s}", "".join(short(r) for r in res))
    print("\nfalse-alarm / miss check on the FULL raw streams of 8 stations (uses the CSV labels; includes contaminated neighbours):")
    fa = Counter(); miss = Counter()
    for sid in [s["id"] for s in stations][::14][:8]:
        res = run(sid, "normal", n=len(rows[sid]) - 40, onset=10**9, start=30)
        for k, r in enumerate(res):
            ev = rows[sid][30 + k]["event"]
            flagged = r["status"] in ("FAULT SUSPECTED", "REVIEW REQUIRED")
            if ev in ("normal", "weather_event"):
                fa[ev, "n"] += 1; fa[ev, "flagged"] += flagged
            elif ev != "communication_dropout":
                miss[ev, "n"] += 1; miss[ev, "caught"] += flagged
            else:
                miss[ev, "n"] += 1; miss[ev, "caught"] += r["status"] == "COMMUNICATION GAP"
    for ev in ("normal", "weather_event"):
        print(f"  healthy '{ev}' rows flagged as fault/review: {fa[ev,'flagged']}/{fa[ev,'n']} = {fa[ev,'flagged']/max(fa[ev,'n'],1):.1%}")
    for ev in sorted({k[0] for k in miss}):
        print(f"  {ev:22s} caught: {miss[ev,'caught']}/{miss[ev,'n']} = {miss[ev,'caught']/max(miss[ev,'n'],1):.0%}")
    sample = run("AWS_001", "spike")[20]
    print("\nsample response (spike, tick 20):")
    for k in ("status", "fault_probability", "weather_probability", "confidence", "fault_type", "novelty_score", "evidence", "explanation", "degraded"):
        print(f"  {k}: {sample[k]}")
