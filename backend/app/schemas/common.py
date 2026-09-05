"""Schema dùng chung."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, PlainSerializer

T = TypeVar("T")

#: Kiểu tiền/giá trả về JSON dạng **số**, không phải chuỗi.
#:
#: Mặc định Pydantic serialize `Decimal` thành chuỗi ("92000.0000") để giữ nguyên độ chính xác.
#: Nhưng frontend cần số thật để tính toán — thư viện biểu đồ từ chối thẳng giá trị chuỗi
#: ("Candlestick series item data value of open must be a number, got=string").
#: Vẫn dùng Decimal ở tầng model và tính toán; chỉ đổi cách biểu diễn khi xuất JSON.
Money = Annotated[
    Decimal,
    PlainSerializer(
        lambda v: float(v) if v is not None else None,
        return_type=float | None,
        when_used="json",
    ),
]


class ORMModel(BaseModel):
    """Base cho mọi schema đọc từ SQLAlchemy model."""

    model_config = ConfigDict(from_attributes=True)


class Message(BaseModel):
    message: str
    code: str | None = None


class ErrorBody(BaseModel):
    code: str
    message: str
    details: dict[str, Any] = {}


class PageResponse(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    size: int
    pages: int


class IdResponse(BaseModel):
    id: int
    message: str = "Thành công"


class BannerInfo(BaseModel):
    """Banner cảnh báo GRACE / WARNING hiển thị trên toàn site (BR-134, BR-302)."""

    level: str
    code: str
    message: str
    days_left: int | None = None
    action: dict[str, Any] | None = None


class AccessInfo(BaseModel):
    """Kết quả áp BR-001, trả kèm mọi phản hồi đăng nhập/lấy hồ sơ."""

    allowed: bool
    reason: str
    message: str = ""
    action: dict[str, Any] = {}
    banner: BannerInfo | None = None


class AuditableRequest(BaseModel):
    """Body cho các hành động bắt buộc nhập lý do (mục 3.4, 3.6)."""

    reason: str


class TimestampedResponse(ORMModel):
    created_at: datetime
    updated_at: datetime | None = None
