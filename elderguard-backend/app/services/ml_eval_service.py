from typing import Any


def evaluate_anomaly(metrics: dict[str, Any]) -> bool:
    heart_rate = metrics.get("heart_rate_bpm")
    spo2 = metrics.get("spo2_percent")
    return (heart_rate is not None and (heart_rate < 40 or heart_rate > 180)) or (spo2 is not None and spo2 < 90)
