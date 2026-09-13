"""Forward staff operations to the authenticated Cloud API."""
import os
from urllib.parse import urlsplit

import requests
from flask import g


class AdminApiError(RuntimeError):
    pass


class AdminApiClient:
    def __init__(self, *, transport=requests, access_token=None):
        self.base_url = os.getenv("JOJO_API_URL", "https://reader.jojokanbao.cn/api/v1").strip().rstrip("/")
        parsed = urlsplit(self.base_url)
        if not parsed.hostname or parsed.username or parsed.password or (parsed.scheme != "https" and parsed.hostname not in {"127.0.0.1", "localhost"}):
            raise AdminApiError("管理 API 地址必须使用 HTTPS。")
        self.access_token = access_token if access_token is not None else g.admin_access_token
        if not self.access_token:
            raise AdminApiError("请先登录管理台。")
        self.transport = transport

    def call(self, method, path, *, body=None, params=None):
        try:
            response = self.transport.request(method, f"{self.base_url}/admin/{path}",
                headers={"Authorization": f"Bearer {self.access_token}"}, json=body, params=params, timeout=15)
            payload = response.json()
            if not response.ok:
                raise AdminApiError("管理操作未完成，请检查登录权限后重试。")
            return payload
        except (requests.RequestException, ValueError) as error:
            raise AdminApiError("无法连接管理服务，请稍后重试。") from error
