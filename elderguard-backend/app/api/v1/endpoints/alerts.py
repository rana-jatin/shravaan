from fastapi import APIRouter, BackgroundTasks, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, get_device_from_token
from app.models.device import Device
from app.models.telemetry import Alert, AlertType
from app.schemas.telemetry import AlertRead, SosRequest
from app.services.notification_service import dispatch_emergency_alert

router = APIRouter(prefix="/alerts", tags=["Emergency Alerts"])


@router.post("/sos", response_model=AlertRead, status_code=status.HTTP_201_CREATED, summary="Create and escalate an emergency SOS")
async def trigger_sos(
    request: SosRequest,
    background_tasks: BackgroundTasks,
    device: Device = Depends(get_device_from_token),
    db: AsyncSession = Depends(get_db),
) -> Alert:
    alert = Alert(device_id=device.id, alert_type=AlertType.SOS, source=request.source, details=request.details)
    db.add(alert)
    await db.commit()
    await db.refresh(alert)
    background_tasks.add_task(dispatch_emergency_alert, {"alert_id": alert.id, "device_id": device.id, "source": request.source, "details": request.details})
    return alert
