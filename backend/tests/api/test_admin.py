from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.application import create_app
from app.core.auth import get_current_user
from app.core.models import CurrentUser


@pytest.mark.parametrize("roles,allowed", [([], False), (["librarian"], False), (["moderator"], True), (["admin"], True), ("admin", False)])
def test_moderation_requires_a_server_managed_role(roles, allowed, monkeypatch):
    app = create_app()
    user = CurrentUser(id="00000000-0000-4000-8000-000000000001", app_metadata={"jojo_roles":roles}, user_metadata={"jojo_roles":["admin"]})
    app.dependency_overrides[get_current_user] = lambda: user
    rpc = AsyncMock(return_value=[])
    monkeypatch.setattr("app.account.admin.service_rpc", rpc)
    with TestClient(app) as client:
        response = client.get("/v1/admin/moderation/comments")
        assert response.status_code == (200 if allowed else 403)
    assert rpc.await_count == int(allowed)


def test_moderation_records_the_authenticated_actor_and_validates_input(monkeypatch):
    app = create_app()
    user = CurrentUser(id="00000000-0000-4000-8000-000000000001", app_metadata={"jojo_roles":["moderator"]})
    app.dependency_overrides[get_current_user] = lambda: user
    rpc = AsyncMock(return_value={"success":True})
    monkeypatch.setattr("app.account.admin.service_rpc", rpc)
    with TestClient(app) as client:
        path = "/v1/admin/moderation/comments/00000000-0000-4000-8000-000000000002"
        assert client.post(path,json={"action":"hide","reason":"垃圾广告","actor_id":"forged"}).status_code == 422
        assert client.post(path,json={"action":"hide","reason":"  "}).status_code == 422
        assert client.post(path,json={"action":"hide","reason":"垃圾广告"}).status_code == 200
        assert rpc.call_args.args[2]["p_actor_id"] == user.id
        assert rpc.call_args.args[2]["p_reason"] == "垃圾广告"


def test_admin_route_rejects_missing_session():
    with TestClient(create_app()) as client:
        assert client.get("/v1/admin/moderation/comments").status_code == 401
