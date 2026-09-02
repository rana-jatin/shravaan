from fastapi import APIRouter

from app.api.v1.endpoints import alerts, auth, devices, telemetry

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(devices.router)
api_router.include_router(telemetry.router)
api_router.include_router(alerts.router)
