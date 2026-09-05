"""add the readings a person recites, and where a reading came from

Blood pressure and blood sugar are the two numbers an elderly person actually
keeps track of and says out loud, and no consumer wristband measures either.
Without columns for them the companion could hear "my sugar was one thirty this
morning" and had nowhere to put it.

`source` separates a number a sensor took from a number somebody remembered.
They are not the same kind of fact and anyone reading this table later has to be
able to tell them apart. Defaulted to "device" so every row that predates this
migration keeps the meaning it already had.

Revision ID: 0004_self_reported_vitals
Revises: 0003_user_password
"""
from alembic import op
import sqlalchemy as sa

revision = "0004_self_reported_vitals"
down_revision = "0003_user_password"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("telemetry_records", sa.Column("systolic_mmhg", sa.Float(), nullable=True))
    op.add_column("telemetry_records", sa.Column("diastolic_mmhg", sa.Float(), nullable=True))
    op.add_column("telemetry_records", sa.Column("glucose_mgdl", sa.Float(), nullable=True))
    # NOT NULL with a server default, so the backfill and the constraint land in
    # one statement — the table is append-only telemetry and can be large.
    op.add_column(
        "telemetry_records",
        sa.Column("source", sa.String(32), nullable=False, server_default="device"),
    )


def downgrade() -> None:
    op.drop_column("telemetry_records", "source")
    op.drop_column("telemetry_records", "glucose_mgdl")
    op.drop_column("telemetry_records", "diastolic_mmhg")
    op.drop_column("telemetry_records", "systolic_mmhg")
