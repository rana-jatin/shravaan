"""
The Redis client, held where a test can reach it.

WHY THIS MODULE EXISTS. `api/deps.get_redis` used to do `from app.main import
redis_client` *inside the function body* — a runtime import to dodge the import
cycle between `main` (which builds the app) and `deps` (which the app's routes
import). It worked, and it made the dependency impossible to override: there is
no seam to hand a fake through, which is part of why this service had no tests.

The client now lives here, in a module neither `main` nor `deps` has to import
the other for. `main`'s lifespan sets it and clears it; `deps` reads it.
"""

from redis.asyncio import Redis

_client: Redis | None = None


def set_client(client: Redis | None) -> None:
    """Called by the app lifespan on startup, and with None on shutdown."""
    global _client
    _client = client


def get_client() -> Redis | None:
    """None before startup and after shutdown. Callers must handle that."""
    return _client
