"""add a password hash so user identity can be verified

Identity was previously an unverified X-User-ID header. Nullable on purpose:
rows created before this migration keep working as records, and
`verify_password` treats a null hash as a failed login, so none of them can be
signed into until someone sets a password.

Revision ID: 0003_user_password
Revises: 0002_telemetry_event_id
"""
from alembic import op
import sqlalchemy as sa

revision = "0003_user_password"
down_revision = "0002_telemetry_event_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("password_hash", sa.String(128), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "password_hash")
