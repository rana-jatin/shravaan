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
