import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from redis.asyncio import Redis
from pythonjsonlogger.json import JsonFormatter

from app.api.v1.router import api_router
from app.core.config import settings
from app.core.database import close_database
from app.core.redis import set_client
from app.mqtt.consumer import consumer


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logging.basicConfig(level=settings.log_level, handlers=[handler], force=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    client = Redis.from_url(settings.redis_url, decode_responses=True)
    await client.ping()
    set_client(client)
    if consumer is not None:
        consumer.connect()
    yield
    if consumer is not None:
        consumer.disconnect()
    set_client(None)
    await client.aclose()
    await close_database()


def create_app() -> FastAPI:
    configure_logging()
    application = FastAPI(
        title=settings.app_name,
        version="1.0.0",
        description="Async elder safety, telemetry ingestion, and emergency escalation API.",
        openapi_tags=[
            {"name": "Authentication", "description": "Profile identity and authentication."},
            {"name": "Devices", "description": "Hardware pairing and heartbeat management."},
            {"name": "Telemetry", "description": "High-frequency vital telemetry ingestion."},
            {"name": "Emergency Alerts", "description": "SOS creation and escalation."},
        ],
        lifespan=lifespan,
    )
    application.add_middleware(CORSMiddleware, allow_origins=settings.cors_origin_list, allow_methods=["*"], allow_headers=["*"], allow_credentials=True)
    application.include_router(api_router, prefix=settings.api_v1_prefix)

    @application.exception_handler(Exception)
    async def unhandled_exception(_: Request, exc: Exception) -> JSONResponse:
        logging.getLogger(__name__).exception("unhandled_request_error", exc_info=exc)
        return JSONResponse(status_code=500, content={"detail": "Internal server error"})

    @application.get("/health", tags=["System"], summary="Check service health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return application


app = create_app()
