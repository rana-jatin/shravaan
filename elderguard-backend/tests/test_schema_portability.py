"""
The `GUID` column type must stay invisible to Postgres.

The models moved from `postgresql.UUID` to a portable `GUID` so the suite could
run without a database server. That is only an acceptable trade while the
Postgres side is bit-for-bit what it was — otherwise a test convenience has
quietly become a migration nobody wrote.

This is the test that keeps that promise honest.
"""

from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.schema import CreateTable

from app.core.database import GUID
from app.models import Alert, Device, TelemetryRecord, User

TABLES = (User, Device, TelemetryRecord, Alert)

# Column name -> table, for every UUID-typed column in the schema.
UUID_COLUMNS = {
    "users": ["id"],
    "devices": ["id", "owner_id"],
    "telemetry_records": ["id", "event_id", "device_id"],
    "alerts": ["id", "device_id"],
}


def test_postgres_still_gets_a_native_uuid_column() -> None:
    dialect = postgresql.dialect()
    for model in TABLES:
        ddl = str(CreateTable(model.__table__).compile(dialect=dialect))
        for column in UUID_COLUMNS[model.__tablename__]:
            declaration = next(
                line.strip() for line in ddl.splitlines() if line.strip().startswith(f"{column} ")
            )
            # A nullable column ends the line with a comma rather than NOT NULL.
            rendered = declaration.split()[1].rstrip(",")
            assert rendered == "UUID", (
                f"{model.__tablename__}.{column} compiles to "
                f"{declaration!r} — the Postgres schema has changed"
            )


def test_other_backends_get_a_portable_column() -> None:
    """Without this, the suite needs Postgres and therefore does not get run."""
    ddl = str(CreateTable(Device.__table__).compile(dialect=sqlite.dialect()))
    assert "CHAR(36)" in ddl


def test_uuids_survive_the_round_trip_on_both_backends() -> None:
    from uuid import uuid4

    value = uuid4()
    for dialect in (postgresql.dialect(), sqlite.dialect()):
        guid = GUID()
        bound = guid.process_bind_param(value, dialect)
        assert guid.process_result_value(bound, dialect) == value

    assert GUID().process_bind_param(None, sqlite.dialect()) is None
    assert GUID().process_result_value(None, sqlite.dialect()) is None
