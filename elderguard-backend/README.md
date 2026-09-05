# Shravaan Safety API

Async FastAPI backend for elder profiles, device pairing, sensor telemetry, and emergency escalation.

## Run locally

```powershell
Copy-Item .env.example .env
cd ..
.\.venv\Scripts\Activate.ps1
pip install -r elderguard-backend\requirements-dev.txt
cd elderguard-backend
alembic upgrade head
uvicorn app.main:app --reload
```

Interactive API documentation is available at `http://localhost:8000/docs`; OpenAPI JSON is at `/openapi.json`.

## Run with Docker

```powershell
Copy-Item .env.example .env
docker compose up --build
```

The device provisioning workflow expects a pre-created `devices` row whose `qr_token_hash` is `sha256(qr_token)`. Device telemetry uses the JWT returned by `/api/v1/devices/pair` as a Bearer token.

## The companion seam

The voice companion (`ai/` + `backend/` in the parent repo) reaches this
service over `/api/v1/companion/*`, authenticating with a shared secret in
`X-Companion-Key`. Set `COMPANION_API_KEY` here and to the same value on the
companion side; leave it unset and those routes answer 503 naming the
variable, rather than falling open.

| Route | What it is for |
|---|---|
| `POST /companion/vitals/{uid}` | A reading the person said out loud. Stored as `source="self_reported"`. |
| `GET /companion/vitals/{uid}` | The last few readings, newest first, across their devices. |
| `GET /companion/alerts/{uid}` | Alerts nobody has dealt with, oldest first. |
| `POST /companion/alerts/{uid}/{alert_id}/ack` | Settle one, once the companion has asked. |
| `GET /companion/context/{uid}` | Who the device is talking to. Carries no health data. |

**The arrow points one way.** The companion calls this service and this service
never calls back — no inbound authentication to build on the Node side, no
webhook to retry, and a companion that simply says it cannot store a reading
when this service is down. The cost is that an alert raised here is seen on the
companion's next poll rather than instantly, which is the right trade for an
out-of-range reading and the wrong one for an SOS. That is why `POST
/alerts/sos` still emails immediately and the companion's ladder is the second,
slower thing that also happens.

**`uid` is assumed to be this service's user id.** It arrives on a device
`hello` frame and nothing yet guarantees it names a row here; an unknown one is
a 404 and the companion degrades to saying it cannot keep the reading. Pairing
should establish that mapping, and does not — the same open work as the
caregiver dashboard.
