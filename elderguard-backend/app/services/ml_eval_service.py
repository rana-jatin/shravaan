"""
Deciding that a reading is worth someone looking at.

─────────────────────────────────────────────────────────────────────────────
THIS MODULE WAS DEAD CODE. `evaluate_anomaly` was four lines returning a bool
and nothing in the service called it, so every reading this system has ever
stored was stored and forgotten. The band on somebody's wrist could report a
pulse of 190 for an hour and the only record would be a row.

WHAT IT IS NOT. It is not a diagnosis, a triage, or a clinical threshold, and
the file name — `ml_eval_service` — flatters it. There is no model here and
there should not be one: it is a range check, and it is written as a range
check so that nobody downstream mistakes it for a judgement about a person.

THE BANDS ARE DELIBERATELY WIDE, and that is the whole design. Firing means an
elderly person is spoken to about their health by a device, and then their
family is telephoned in the middle of whatever they were doing. A band tight
enough to catch every real event would fire on ordinary variation, on a
loose strap, on a cold finger — and the cost of that is not a wasted email. It
is a person learning that the thing on their wrist cries wolf, and taking it
off. So these are "staying quiet would be wrong" bounds, not "worth
mentioning" ones.

WHAT THE FINDING CARRIES, AND WHAT IT MUST NEVER CARRY. A finding names the
metric, the value, and which side of which bound it fell. It does not name a
condition, a cause, or a severity, because this file knows none of those and
a string like "possible hypoxia" would be read by somebody as if it did.
─────────────────────────────────────────────────────────────────────────────
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from app.models.telemetry import AlertType, MotionState


@dataclass(frozen=True)
class Finding:
    """One reading, outside one bound. Data, not a conclusion."""

    metric: str
    value: float
    direction: Literal["low", "high"]
    threshold: float

    def describe(self) -> dict[str, Any]:
        """For an alert's `details`, which is JSON and read by people."""
        return {
            "metric": self.metric,
            "value": self.value,
            "direction": self.direction,
            "threshold": self.threshold,
        }


#: metric -> (low bound, high bound). `None` means unbounded on that side.
#:
#: Every number here is a round one, and none of them is ours: they are the
#: outer edges that consumer pulse oximeters and blood pressure monitors
#: already use for their own warnings, so a family seeing one of these is
#: seeing what their own equipment would have told them.
BANDS: dict[str, tuple[float | None, float | None]] = {
    # Kept exactly as the original four-line version had them. Below 40 and
    # above 180 are both far outside what a resting adult sustains, and the
    # gap between them covers a brisk walk up a staircase.
    "heart_rate_bpm": (40, 180),
    "spo2_percent": (90, None),
    # 35 is the hypothermia line; 39 is a fever nobody argues about. Room
    # temperature readings from a sensor that has fallen off the skin come in
    # far below 35 and are caught by the schema's own 25 °C floor first.
    "temperature_c": (35.0, 39.0),
    # The two a person recites out loud rather than a wristband measuring.
    "systolic_mmhg": (90, 180),
    "diastolic_mmhg": (50, 120),
    "glucose_mgdl": (60, 300),
}


def evaluate_anomaly(metrics: Mapping[str, Any]) -> tuple[Finding, ...]:
    """
    Every band this reading falls outside.

    RETURNS THE FINDINGS RATHER THAN A BOOL, which the original did. An empty
    tuple is falsy, so `if evaluate_anomaly(...)` still reads the way it did —
    but the caller now has something to put in the alert, and "a reading was
    out of range" stops being the whole of what anybody is told.

    Missing metrics are not findings. A wristband that reports only a pulse is
    not silently failing its SpO2 check; it is a wristband without that sensor.
    """
    findings: list[Finding] = []

    for metric, (low, high) in BANDS.items():
        value = metrics.get(metric)
        if value is None:
            continue
        try:
            reading = float(value)
        except (TypeError, ValueError):
            # A non-numeric reading is sensor damage, not a health event. The
            # schema rejects these on the ingest path; this is the guard for
            # anything that reaches here another way.
            continue

        if low is not None and reading < low:
            findings.append(Finding(metric, reading, "low", low))
        elif high is not None and reading > high:
            findings.append(Finding(metric, reading, "high", high))

    return tuple(findings)


def alert_type_for(metrics: Mapping[str, Any]) -> AlertType | None:
    """
    Which kind of alert this reading deserves, if any.

    A FALL IS ITS OWN TYPE AND OUTRANKS EVERYTHING ELSE. `AlertType.FALL` has
    existed in the enum since the first migration with nothing ever creating
    one, and a device that reports a fall and is answered with silence is the
    single worst outcome available here. It is checked first so that a fall
    that also spiked a pulse is filed as a fall.

    ⚠ IT IS STILL ASKED ABOUT BEFORE ANYONE IS TOLD. Consumer fall detection
    is wrong often enough that treating this as a confirmed emergency would
    have the family called every time somebody set the band down heavily. The
    escalation ladder on the companion side asks first, faster than it asks
    about anything else, and calls only if nobody answers.
    """
    if str(metrics.get("motion_state") or "") == MotionState.FALL.value:
        return AlertType.FALL
    return AlertType.ANOMALY if evaluate_anomaly(metrics) else None
