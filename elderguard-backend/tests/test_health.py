"""The app boots, routes are mounted, and the harness itself works."""

from httpx import AsyncClient

from app.main import create_app


async def test_health_reports_ok(client: AsyncClient) -> None:
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_every_v1_router_is_mounted(client: AsyncClient) -> None:
    """
    A router silently dropped from `api_router` is a whole capability going
    missing with no error anywhere. Cheap to assert, expensive to discover.
    """
    paths = {route.path for route in create_app().routes if hasattr(route, "path")}
    for expected in (
        "/api/v1/auth/me",
        "/api/v1/devices/register",
        "/api/v1/devices/pair",
        "/api/v1/telemetry/stream",
        "/api/v1/alerts/sos",
    ):
        assert expected in paths, f"{expected} is not mounted"


async def test_unknown_route_is_a_404_not_a_500(client: AsyncClient) -> None:
    response = await client.get("/api/v1/nope")
    assert response.status_code == 404
