"""
What the companion sends and is sent back.

SEPARATE FROM `schemas/telemetry.py` BECAUSE THE CALLER IS DIFFERENT IN KIND.
Those schemas are a device's contract: a batch of points, an event id, a
motion state. This is a conversation's contract — one reading at a time, said
out loud by a person, with no event id because there is no stream.

⚠ NO FREE TEXT CROSSES THIS BOUNDARY. The companion has a transcript of
somebody's home conversation and this service has a database of their health.
Joining the two would create a record neither side was built to hold and
nobody agreed to. So a reading is numbers and a closed set of tokens; what the
person actually said stays where it was said.
"""

from datetime import datetime
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.telemetry import AlertStatus, AlertType
from app.schemas.telemetry import check_blood_pressure


class GlucoseContext(StrEnum):
    """
    When the sugar reading was taken, which changes what it means.

    A CLOSED SET, NOT A SENTENCE. "Before breakfast" is the one piece of
    context that makes a glucose number readable at all, and it is worth
    carrying — but as a token the companion maps a phrase onto, never as the
    phrase itself.
    """

    FASTING = "fasting"
    AFTER_MEAL = "after_meal"
    UNSPECIFIED = "unspecified"


class SelfReportedVital(BaseModel):
    """
    One reading, as a person said it.

    `recorded_at` is optional and defaults at the service, because somebody
    saying "my sugar was one thirty this morning" has given a number and a
    vagueness, and inventing a precise timestamp for it would be worse than
    recording when they said it.
    """

    # EXTRA FIELDS ARE REFUSED, NOT IGNORED, which is not pydantic's default.
    # A `note` field arriving here and being silently dropped looks identical
    # to one being stored, and the whole point of this boundary is that what
    # somebody said stays on the companion's side of it. A caller sending
    # something this schema does not name should be told so.
    model_config = ConfigDict(extra="forbid")

    recorded_at: datetime | None = None
    heart_rate_bpm: float | None = Field(default=None, ge=20, le=250)
    spo2_percent: float | None = Field(default=None, ge=50, le=100)
    temperature_c: float | None = Field(default=None, ge=25, le=45)
    systolic_mmhg: float | None = Field(default=None, ge=50, le=260)
    diastolic_mmhg: float | None = Field(default=None, ge=30, le=160)
    glucose_mgdl: float | None = Field(default=None, ge=20, le=700)
    glucose_context: GlucoseContext = GlucoseContext.UNSPECIFIED

    @model_validator(mode="after")
    def require_something(self) -> "SelfReportedVital":
        if all(
            getattr(self, field) is None
            for field in (
                "heart_rate_bpm",
                "spo2_percent",
                "temperature_c",
                "systolic_mmhg",
                "diastolic_mmhg",
                "glucose_mgdl",
            )
        ):
            raise ValueError("at least one reading is required")
        # The same rule the stored schema holds, called rather than restated —
        # this model used to be the weaker of the two, so a lone systolic
        # passed here and raised a 500 while building the row.
        check_blood_pressure(self.systolic_mmhg, self.diastolic_mmhg)
        return self


class VitalRead(BaseModel):
    """One stored reading, on the way back out."""

    recorded_at: datetime
    heart_rate_bpm: float | None
    spo2_percent: float | None
    temperature_c: float | None
    systolic_mmhg: float | None
    diastolic_mmhg: float | None
    glucose_mgdl: float | None
    #: "device", "self_reported", "csv_upload". The companion says which when
    #: it reads one back — "you told me" and "your band measured" are not
    #: interchangeable sentences to say to somebody.
    source: str


class VitalsAccepted(BaseModel):
    stored: bool
    device_id: UUID
    #: True when this reading fell outside a band and raised an alert. The
    #: companion does NOT use this to say anything about the reading; it exists
    #: so the caller can stop polling and open its ladder immediately.
    alerted: bool


class CompanionAlert(BaseModel):
    id: UUID
    device_id: UUID
    alert_type: AlertType
    status: AlertStatus
    source: str
    details: dict
    created_at: datetime


class OwnedAlert(CompanionAlert):
    """
    An alert with the person it belongs to attached.

    THE COMPANION HAS NO LIST OF USERS. It learns a uid when a device says
    hello, so a per-uid feed can only ever surface alerts for somebody already
    in a conversation — and the reading that raised the alert came off a band,
    which does not need the companion device to be switched on. Without this,
    an out-of-range reading for somebody whose device is unplugged would sit in
    the table unread, which is the case that most deserves a phone call.
    """

    uid: UUID


class AlertAck(BaseModel):
    """
    What the companion learned by asking.

    `acknowledged` means somebody answered and the ladder is over.
    `resolved` means it is finished with — the ladder ran out, or the family
    was told, and this alert should stop suppressing the next one.
    """

    status: Literal[AlertStatus.ACKNOWLEDGED, AlertStatus.RESOLVED]


class ContextIdentity(BaseModel):
    display_name: str
    timezone: str | None = None


class CompanionContext(BaseModel):
    """
    `JsonContext` from shared/src/domain/types.ts, as much of it as this
    service actually knows.

    ⚠ IT CARRIES NO HEALTH DATA, AND THAT IS THE WHOLE DESIGN OF IT. This
    object is read straight into the model's prompt at the top of a session, so
    anything here is something the companion may bring up unprompted. A
    `history` of "anomaly: heart rate 195" would produce a device that opens
    the conversation by telling an eighty-year-old their pulse was alarming
    yesterday. Vitals are readable only through the tool, only when asked, and
    the alert path speaks its own reviewed copy.

    `entitlements` is empty because this service has no such concept. No tool
    in the companion sets `requires_entitlement` today, so an empty list gates
    nothing; if one ever does, this is where the answer will have to come from.
    """

    uid: str
    fetched_at: datetime
    identity: ContextIdentity
    entitlements: list[dict] = Field(default_factory=list)
