from io import BytesIO
from urllib.error import HTTPError
from urllib.request import Request

import pytest

from tools import verify_b2_private_bucket as tool


def test_request_json_retries_transient_disconnect(monkeypatch: pytest.MonkeyPatch):
    calls = 0
    sleeps: list[float] = []

    def fake_urlopen(_request: Request, *, timeout: int):
        nonlocal calls
        assert timeout == 30
        calls += 1
        if calls == 1:
            from http.client import RemoteDisconnected

            raise RemoteDisconnected("transient")
        return BytesIO(b'{"ok": true}')

    monkeypatch.setattr(tool, "urlopen", fake_urlopen)
    monkeypatch.setattr(tool.time, "sleep", sleeps.append)

    assert tool.request_json(Request("https://example.test"), attempts=2) == {
        "ok": True
    }
    assert calls == 2
    assert sleeps == [1.0]


def test_request_json_does_not_retry_authentication_error(
    monkeypatch: pytest.MonkeyPatch,
):
    calls = 0

    def fake_urlopen(_request: Request, *, timeout: int):
        nonlocal calls
        calls += 1
        raise HTTPError(
            "https://example.test",
            401,
            "unauthorized",
            hdrs=None,
            fp=None,
        )

    monkeypatch.setattr(tool, "urlopen", fake_urlopen)

    with pytest.raises(HTTPError):
        tool.request_json(Request("https://example.test"), attempts=4)
    assert calls == 1
