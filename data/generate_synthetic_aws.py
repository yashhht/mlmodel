"""Generate the controlled synthetic AWS demonstration network.

This is DEMO/SIMULATED data, not an official IMD observation feed.
The ten AWS_001..AWS_010 Pune records are preserved from the supplied prototype.
"""
from pathlib import Path
import csv, json, math, random
from datetime import datetime, timedelta, timezone

ROOT = Path(__file__).resolve().parent
PROFILES = json.loads((ROOT / "climate_profiles.json").read_text(encoding="utf-8"))
STATIONS = json.loads((ROOT / "stations.json").read_text(encoding="utf-8"))["stations"]
random.seed(42)


def station_pressure(sea_level_pressure, elevation):
    return sea_level_pressure * (1 - 2.25577e-5 * elevation) ** 5.25588

for station in STATIONS:
    profile = PROFILES[station["city"]]
    city_dir = ROOT / "raw" / station["city"]
    city_dir.mkdir(parents=True, exist_ok=True)
    start = datetime(2026, 8, 1, tzinfo=timezone.utc)
    rows = []
    previous = [profile["temperature"], station_pressure(1011, station["elevation"]), profile["humidity"]]

    for i in range(24 * 30):
        ts = start + timedelta(hours=i)
        daily = math.sin((ts.hour - 6) / 24 * 2 * math.pi)
        t = profile["temperature"] + 4 * daily + math.sin(i / 360) + random.gauss(0, 0.35)
        rh = profile["humidity"] - 8 * daily + random.gauss(0, 1.4)
        p = station_pressure(1011 + 3 * math.sin(i / 30) + random.gauss(0, 0.6), station["elevation"])
        event, label = "normal", 0

        # Genuine coherent weather event.
        if 300 <= i < 312:
            t -= 5; rh += 18; p -= 4; event = "weather_event"
        # Realistic contiguous sensor faults.
        if 420 <= i < 422:
            t += 20; event = "sensor_spike"; label = 1
        if 500 <= i < 540:
            t += (i - 500) * 0.18; event = "sensor_drift"; label = 1
        if 600 <= i < 612:
            t, p, rh = previous; event = "sensor_stuck"; label = 1
        if 680 <= i < 692:
            rh += 25; event = "humidity_offset"; label = 1
        if 750 <= i < 756:
            rows.append({"timestamp": ts.isoformat(), "station_id": station["id"], "city": station["city"],
                         "temperature": "", "pressure": "", "humidity": "", "quality": "MISSING",
                         "event": "communication_dropout", "fault_label": 1})
            continue

        t = round(max(-40, min(60, t)), 2)
        rh = round(max(0, min(100, rh)), 2)
        p = round(max(850, min(1100, p)), 2)
        previous = [t, p, rh]
        rows.append({"timestamp": ts.isoformat(), "station_id": station["id"], "city": station["city"],
                     "temperature": t, "pressure": p, "humidity": rh, "quality": "GOOD",
                     "event": event, "fault_label": label})

    with open(city_dir / f"{station['id']}.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader(); writer.writerows(rows)

print(f"Generated {len(STATIONS)} stations across {len(PROFILES)} Maharashtra cities.")
print("Data status: DEMO/SIMULATED — not an official IMD feed.")
