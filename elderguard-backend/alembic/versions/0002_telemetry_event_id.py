"""add telemetry event id for replay protection"""
from alembic import op
import sqlalchemy as sa

revision = "0002_telemetry_event_id"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("telemetry_records", sa.Column("event_id", sa.UUID(), nullable=True))
    op.execute(sa.text("UPDATE telemetry_records SET event_id = gen_random_uuid() WHERE event_id IS NULL"))
    op.alter_column("telemetry_records", "event_id", nullable=False)
    op.create_unique_constraint("uq_telemetry_records_event_id", "telemetry_records", ["event_id"])
    op.create_index("ix_telemetry_records_event_id", "telemetry_records", ["event_id"])


def downgrade() -> None:
    op.drop_index("ix_telemetry_records_event_id", table_name="telemetry_records")
    op.drop_constraint("uq_telemetry_records_event_id", "telemetry_records", type_="unique")
    op.drop_column("telemetry_records", "event_id")