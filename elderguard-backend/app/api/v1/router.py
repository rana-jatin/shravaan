from fastapi import APIRouter

from app.api.v1.endpoints import alerts, auth, companion, devices, telemetry

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(devices.router)
api_router.include_router(telemetry.router)
api_router.include_router(alerts.router)
# Mounted unconditionally, unlike the companion capabilities on the Node side,
# where unconfigured means unregistered. An HTTP route that vanishes when a
# variable is unset is a 404 the caller has to guess about; `require_companion`
# answers 503 and names the variable instead. The routes are never open — see
# api/deps.py.
api_router.include_router(companion.router)
