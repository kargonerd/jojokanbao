import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from flask import g
from flask.testing import FlaskClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def authenticated_business_route_fixtures(request):
    # Authentication itself is exercised without these business-test fixtures.
    if request.node.path.name == "test_admin_auth.py":
        yield
        return
    def authorized():
        g.admin_user = {"id":"fixture-admin", "app_metadata":{"jojo_roles":["admin"]}}
        g.admin_access_token = "fixture-admin-session"
    original = FlaskClient.open
    def same_origin(client, *args, **kwargs):
        kwargs["headers"] = {"Origin":"http://localhost:5000", **kwargs.get("headers", {})}
        return original(client, *args, **kwargs)
    with patch("admin_auth.validate_admin_session", authorized), patch.object(FlaskClient, "open", same_origin):
        yield
