from collections.abc import AsyncGenerator
from uuid import UUID as PyUUID

from sqlalchemy import CHAR, TypeDecorator
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings


class Base(DeclarativeBase):
    pass


class GUID(TypeDecorator):
    """
    A UUID column that is native on Postgres and portable everywhere else.

    THE DDL ON POSTGRES IS UNCHANGED. `load_dialect_impl` hands back the same
    `postgresql.UUID(as_uuid=True)` the models declared directly before, so the
    live schema, the two Alembic migrations and every existing row are
    untouched. What changes is that the models no longer *hard-code* the
    Postgres dialect, which is what made them impossible to open on anything
    else — and therefore impossible to test without a database server.

    That mattered more than it looks: this service shipped a dead SOS path and
    an unauthenticated identity check, and neither could be caught because no
    test could construct a Device to exercise them. The rest of this repo holds
    the line that `npm test` needs no credentials and no network (see
    CLAUDE.md); this is what it takes to say the same here.

    Values cross the boundary as `uuid.UUID` in both directions regardless of
    backend, so nothing above this line has to know which one it is talking to.
    """

    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PGUUID(as_uuid=True))
        return dialect.type_descriptor(CHAR(36))

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        parsed = value if isinstance(value, PyUUID) else PyUUID(str(value))
        # Postgres takes the object; everything else gets the canonical dashed
        # string, so ordering and equality behave the same on both.
        return parsed if dialect.name == "postgresql" else str(parsed)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return value if isinstance(value, PyUUID) else PyUUID(str(value))


def _engine_options() -> dict[str, object]:
    """
    Pool sizing is a server-database concern, not a universal one.

    `pool_size` and `max_overflow` belong to QueuePool. SQLite does not use it,
    and `create_async_engine` raises a TypeError rather than ignoring them — so
    hard-coding them meant the app could not be opened against any other
    backend, including the in-memory database the tests need. Postgres keeps
    exactly the numbers it had.
    """
    if settings.database_url.startswith("sqlite"):
        return {}
    return {"pool_pre_ping": True, "pool_size": 10, "max_overflow": 20}


engine = create_async_engine(settings.database_url, echo=settings.debug, **_engine_options())

AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session


async def close_database() -> None:
    await engine.dispose()
