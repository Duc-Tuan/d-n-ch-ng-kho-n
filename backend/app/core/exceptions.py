"""Lỗi nghiệp vụ có mã — FE dựa vào `code` để hiển thị đúng thông báo (BR-112)."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status


class AppError(HTTPException):
    """Lỗi nghiệp vụ chuẩn hoá.

    Body trả về:  {"code": "...", "message": "...", "details": {...}}
    """

    def __init__(
        self,
        message: str,
        code: str = "BAD_REQUEST",
        status_code: int = status.HTTP_400_BAD_REQUEST,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            status_code=status_code,
            detail={"code": code, "message": message, "details": details or {}},
        )
        self.code = code
        self.message = message


class ValidationError(AppError):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message, "VALIDATION_ERROR", status.HTTP_422_UNPROCESSABLE_ENTITY, details)


class Unauthorized(AppError):
    def __init__(self, message: str = "Chưa đăng nhập hoặc phiên đã hết hạn", code: str = "UNAUTHORIZED") -> None:
        super().__init__(message, code, status.HTTP_401_UNAUTHORIZED)


class Forbidden(AppError):
    def __init__(self, message: str = "Bạn không có quyền thực hiện thao tác này", code: str = "FORBIDDEN",
                 details: dict[str, Any] | None = None) -> None:
        super().__init__(message, code, status.HTTP_403_FORBIDDEN, details)


class NotFound(AppError):
    def __init__(self, message: str = "Không tìm thấy dữ liệu", code: str = "NOT_FOUND") -> None:
        super().__init__(message, code, status.HTTP_404_NOT_FOUND)


class Conflict(AppError):
    def __init__(self, message: str, code: str = "CONFLICT") -> None:
        super().__init__(message, code, status.HTTP_409_CONFLICT)


class TooManyRequests(AppError):
    def __init__(self, message: str = "Bạn thao tác quá nhanh, vui lòng thử lại sau",
                 code: str = "TOO_MANY_REQUESTS", details: dict[str, Any] | None = None) -> None:
        super().__init__(message, code, status.HTTP_429_TOO_MANY_REQUESTS, details)


class AccessBlocked(Forbidden):
    """BR-001/BR-112 — bị chặn truy cập, kèm lý do và hành động tiếp theo."""

    def __init__(self, message: str, reason: str, action: dict[str, Any] | None = None) -> None:
        super().__init__(message, "ACCESS_BLOCKED", {"reason": reason, "action": action or {}})
