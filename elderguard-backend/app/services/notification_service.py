import logging
import asyncio
import smtplib
from email.message import EmailMessage
from typing import Any

from app.core.config import settings

logger = logging.getLogger(__name__)


async def dispatch_emergency_alert(payload: dict[str, Any]) -> None:
    recipients = settings.relative_email_list
    if not recipients:
        logger.error("emergency_alert_not_sent", extra={"reason": "no relative recipients"})
        return
    if not settings.smtp_host or not settings.smtp_from:
        logger.error("emergency_alert_not_sent", extra={"reason": "SMTP is not configured"})
        return

    message = EmailMessage()
    message["Subject"] = "Shravaan emergency alert"
    message["From"] = settings.smtp_from
    message["To"] = ", ".join(recipients)
    message.set_content(
        "An emergency alert was raised by a Shravaan device.\n\n"
        f"Alert ID: {payload.get('alert_id')}\n"
        f"Device ID: {payload.get('device_id')}\n"
        f"Source: {payload.get('source')}\n"
        f"Details: {payload.get('details', {})}\n"
    )

    await asyncio.to_thread(_send_email, message)
    logger.warning("emergency_alert_sent", extra={"alert_id": str(payload.get("alert_id")), "recipients": recipients})


def _send_email(message: EmailMessage) -> None:
    if settings.smtp_port == 465:
        with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=15) as server:
            if settings.smtp_username and settings.smtp_password:
                server.login(settings.smtp_username, settings.smtp_password)
            server.send_message(message)
        return

    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as server:
        server.starttls()
        if settings.smtp_username and settings.smtp_password:
            server.login(settings.smtp_username, settings.smtp_password)
        server.send_message(message)
