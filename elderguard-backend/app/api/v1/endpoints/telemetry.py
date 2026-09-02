from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import enforce_rate_limit, get_db, get_device_from_token, get_redis
from app.models.device import Device
from app.schemas.telemetry import TelemetryAccepted, TelemetryBatch
from app.services.telemetry_service import parse_csv_points, save_telemetry_batch

router = APIRouter(prefix="/telemetry", tags=["Telemetry"])


@router.post("/stream", response_model=TelemetryAccepted, status_code=status.HTTP_202_ACCEPTED, summary="Ingest a bounded telemetry batch")
async def ingest_telemetry(
    batch: TelemetryBatch,
    device: Device = Depends(get_device_from_token),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> TelemetryAccepted:
    await enforce_rate_limit(redis, f"rate:telemetry:{device.id}")
    accepted = await save_telemetry_batch(db, device, batch.points)
    return TelemetryAccepted(accepted=accepted, device_id=device.id)


@router.post("/upload-csv", response_model=TelemetryAccepted, status_code=status.HTTP_202_ACCEPTED, summary="Ingest telemetry from a CSV file")
async def ingest_telemetry_csv(
    file: UploadFile = File(...),
    device: Device = Depends(get_device_from_token),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> TelemetryAccepted:
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="CSV file required")

    max_bytes = 1024 * 1024
    csv_bytes = await file.read(max_bytes + 1)
    if len(csv_bytes) > max_bytes:
        raise HTTPException(status_code=413, detail="CSV file exceeds the 1 MiB limit")
    try:
        text = csv_bytes.decode("utf-8-sig")
        points = parse_csv_points(text, max_points=100)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="CSV file must be UTF-8 encoded") from exc

    await enforce_rate_limit(redis, f"rate:telemetry:{device.id}")
    accepted = await save_telemetry_batch(db, device, points)
    return TelemetryAccepted(accepted=accepted, device_id=device.id)
