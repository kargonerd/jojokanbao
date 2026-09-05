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


class SpeechServiceError(ApiError):
    def __init__(self, message: str = "Speech synthesis is temporarily unavailable") -> None:
        super().__init__(502, "speech_service_unavailable", message)


class SpeechUnavailableError(ApiError):
    def __init__(self, message: str = "Speech synthesis is not enabled") -> None:
        super().__init__(503, "speech_not_enabled", message)
