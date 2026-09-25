SkyGuard ML service.

Run:
  pip install -r requirements.txt
  uvicorn service:app --host 0.0.0.0 --port 8100

This is a calibrated development baseline trained on synthetic patterns. It is not an IMD/WMO-certified operational model and the demo station stream is simulated.
