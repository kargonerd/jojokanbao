from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class ApiError(Exception):
    status_code: int
    code: str
    message: str
    authenticate: bool = False

    def __str__(self) -> str:
        return self.message


class AuthenticationError(ApiError):
    def __init__(self, message: str = "Authentication required") -> None:
        super().__init__(401, "unauthorized", message, authenticate=True)


class AuthServiceError(ApiError):
    def __init__(self, message: str = "Authentication service is unavailable") -> None:
        super().__init__(502, "auth_service_unavailable", message)


class ConfigurationError(ApiError):
    def __init__(self, message: str = "Service authentication is not configured") -> None:
        super().__init__(503, "service_not_configured", message)


class FeatureEvaluationError(ApiError):
    def __init__(self, message: str = "Feature evaluation service is unavailable") -> None:
        super().__init__(503, "feature_evaluation_unavailable", message)


class FeatureNotAvailableError(ApiError):
    def __init__(self, message: str = "This feature is not available") -> None:
        super().__init__(403, "feature_not_available", message)
