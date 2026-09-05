"""Phân trang dùng chung cho mọi endpoint danh sách."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

T = TypeVar("T")

MAX_PAGE_SIZE = 200


@dataclass(slots=True)
class PageParams:
    page: int = 1
    size: int = 20

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.size


def page_params(
    page: int = Query(1, ge=1, description="Trang, bắt đầu từ 1"),
    size: int = Query(20, ge=1, le=MAX_PAGE_SIZE, description="Số bản ghi mỗi trang"),
) -> PageParams:
    return PageParams(page=page, size=size)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    size: int
    pages: int

    @property
    def has_next(self) -> bool:
        return self.page < self.pages


def count_of(db: Session, stmt: Select) -> int:
    """Đếm tổng số bản ghi khớp `stmt`.

    Dùng subquery cho COUNT để không phải viết lại điều kiện WHERE hai lần, và bỏ ORDER BY
    vì MySQL từ chối sắp xếp bên trong truy vấn đếm khi có DISTINCT/GROUP BY.
    """
    return int(db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0)


def slice_rows(db: Session, stmt: Select, params: PageParams) -> list[Any]:
    """Lấy đúng các dòng của trang hiện tại. Trả về Row (nhiều cột) — không unwrap."""
    return list(db.execute(stmt.limit(params.size).offset(params.offset)).all())


def paginate(db: Session, stmt: Select, params: PageParams) -> tuple[list[Any], int]:
    """Trả về (danh sách **entity** trang hiện tại, tổng số bản ghi)."""
    total = count_of(db, stmt)
    items = db.execute(stmt.limit(params.size).offset(params.offset)).scalars().all()
    return list(items), total


def paginate_page(
    db: Session,
    stmt: Select,
    params: PageParams,
    item: Callable[[Any], Any] | None = None,
) -> dict:
    """Đếm + cắt trang + đóng gói thân phản hồi, trong **một** lời gọi. Dùng cho `select(Entity)`.

    Đây là hình dạng mà gần như mọi endpoint danh sách cần. Trước đây mỗi endpoint tự viết lại
    ba dòng `select(func.count()).select_from(stmt.order_by(None).subquery())` — lặp hơn ba mươi
    chỗ, và mỗi chỗ là một cơ hội quên `.order_by(None)` (MySQL báo lỗi) hoặc quên `or 0`.

    `item` chuyển từng entity sang dạng trả về (schema Pydantic, dict…).
    """
    total = count_of(db, stmt)
    rows = list(db.execute(stmt.limit(params.size).offset(params.offset)).scalars().all())
    return build_page([item(r) for r in rows] if item else rows, total, params)


def paginate_rows(
    db: Session,
    stmt: Select,
    params: PageParams,
    item: Callable[..., Any],
) -> dict:
    """Như `paginate_page` nhưng cho truy vấn **nhiều cột** — `select(User, Subscription, Package)`.

    `item` được gọi với từng cột đã bung ra (`item(user, sub, package)`), không phải với Row,
    để lời gọi đọc như một chữ ký hàm bình thường.
    """
    total = count_of(db, stmt)
    rows = db.execute(stmt.limit(params.size).offset(params.offset)).all()
    return build_page([item(*row) for row in rows], total, params)


def build_page(items: list[Any], total: int, params: PageParams) -> dict:
    pages = (total + params.size - 1) // params.size if total else 0
    return {
        "items": items,
        "total": total,
        "page": params.page,
        "size": params.size,
        "pages": pages,
    }
