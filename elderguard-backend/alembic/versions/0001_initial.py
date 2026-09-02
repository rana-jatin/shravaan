"""create elderguard core tables

Revision ID: 0001_initial
Revises:
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0001_initial"
down_revision: Union[str, Sequence[str], None] = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    user_role = sa.Enum("elder", "relative", "admin", name="user_role")
    device_status = sa.Enum("active", "inactive", "revoked", name="device_status")
    motion_state = sa.Enum("still", "walking", "fall", "unknown", name="motion_state")
    alert_type = sa.Enum("sos", "fall", "anomaly", name="alert_type")
    alert_status = sa.Enum("open", "acknowledged", "resolved", name="alert_status")
    for enum in (user_role, device_status, motion_state, alert_type, alert_status): enum.create(op.get_bind(), checkfirst=True)
    op.create_table("users", sa.Column("id", sa.UUID(), primary_key=True), sa.Column("email", sa.String(320), nullable=False), sa.Column("full_name", sa.String(200), nullable=False), sa.Column("role", user_role, nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()), sa.UniqueConstraint("email"))
    op.create_index("ix_users_email", "users", ["email"])
    op.create_table("devices", sa.Column("id", sa.UUID(), primary_key=True), sa.Column("hardware_uid", sa.String(128), nullable=False), sa.Column("qr_token_hash", sa.String(64), nullable=False), sa.Column("owner_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="CASCADE")), sa.Column("status", device_status, nullable=False), sa.Column("last_seen_at", sa.DateTime(timezone=True)), sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()), sa.UniqueConstraint("hardware_uid"), sa.UniqueConstraint("qr_token_hash"))
    op.create_index("ix_devices_hardware_uid", "devices", ["hardware_uid"])
    op.create_index("ix_devices_owner_id", "devices", ["owner_id"])
    op.create_table("telemetry_records", sa.Column("id", sa.UUID(), primary_key=True), sa.Column("device_id", sa.UUID(), sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False), sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False), sa.Column("heart_rate_bpm", sa.Float()), sa.Column("spo2_percent", sa.Float()), sa.Column("temperature_c", sa.Float()), sa.Column("motion_state", motion_state, nullable=False), sa.Column("raw_payload", sa.JSON(), nullable=False))
    op.create_index("ix_telemetry_records_device_id", "telemetry_records", ["device_id"])
    op.create_index("ix_telemetry_records_recorded_at", "telemetry_records", ["recorded_at"])
    op.create_table("alerts", sa.Column("id", sa.UUID(), primary_key=True), sa.Column("device_id", sa.UUID(), sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False), sa.Column("alert_type", alert_type, nullable=False), sa.Column("status", alert_status, nullable=False), sa.Column("source", sa.String(64), nullable=False), sa.Column("details", sa.JSON(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()))


def downgrade() -> None:
    op.drop_table("alerts")
    op.drop_table("telemetry_records")
    op.drop_table("devices")
    op.drop_table("users")
    for name in ("alert_status", "alert_type", "motion_state", "device_status", "user_role"): sa.Enum(name=name).drop(op.get_bind(), checkfirst=True)
