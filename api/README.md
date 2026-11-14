# MNIST prediction service

FastAPI serves the checked-in PyTorch checkpoint. The website sends a PNG to `POST /predict`; accepted results contain a digit and scores, while rejected inputs receive a cheeky response. Training is separate from serving.

## Run locally

From the repository root:

```sh
python -m pip install -r api/requirements.txt
python -m uvicorn main:app --app-dir api --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/docs` for the API reference. For local frontend testing, set `ALLOWED_ORIGINS` to include the exact frontend origin, for example `http://127.0.0.1:3000`, in addition to the production origin. Do not include URL paths in origins. CORS governs browser access; it is not API authentication.

## Contract

`POST /predict` accepts JSON with exactly one field:

```json
{"image": "data:image/png;base64,..."}
```

The PNG must have white strokes on a black background and dimensions between 8 and 1024 pixels per side. Requests are capped at 700,000 bytes before image decoding. Invalid encodings or dimensions return HTTP 422; oversized requests return HTTP 413. Invalid drawings are a successful inference response (HTTP 200) with `accepted: false`, not an infrastructure failure.

Other endpoints:

- `GET /health`: readiness after weights load and integrity verification.
- `GET /model-info`: measured evaluation results, training summary, and limitations.
- `GET /docs`: generated OpenAPI interface.

## Render deployment

The root `render.yaml` defines a free Python web service rooted at `api/`, using one Uvicorn worker and one PyTorch thread. The tested local process used about 240 MB peak resident memory; actual platform usage may differ. Weights are part of the build, so restarts do not require training or a persistent disk.

| Setting | Value |
| --- | --- |
| Repository | `https://github.com/csw314/cameron-webster-profile` |
| Branch | `main` |
| Root directory | `api` |
| Runtime | Python |
| Build | `pip install -r requirements.txt` |
| Start | `uvicorn main:app --host 0.0.0.0 --port $PORT --workers 1` |
| Health path | `/health` |
| Python version | `3.12.11` |
| Allowed origin | `https://csw314.github.io` |

After Render reports the deploy live, verify `/health` and an actual `/predict` request. Put the exact returned service URL into `projects/mnist/config.js`. A public Git URL deploy may require manual redeployment; automatic commits require a connected Git provider. Free services can sleep after inactivity. The frontend preserves the drawing and explains a delayed or failed request without mislabeling it as a rejected drawing.

The service intentionally uses no database and stores no drawings. Request payloads are not logged by application code. Never put API keys in frontend JavaScript; this public inference demo does not need a secret key.
