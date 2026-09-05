"""Lớp nền cho mọi model + các mixin dùng chung."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, Integer, func
from sqlalchemy.dialects.mysql import JSON as MySQLJSON
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import JSON

#: MySQL dùng kiểu JSON riêng; SQLite (chạy test) dùng JSON generic.
JSONType = JSON().with_variant(MySQLJSON(), "mysql")

#: Khoá chính tự tăng — BIGINT trên MySQL, INTEGER trên SQLite.
PKType = BigInteger().with_variant(Integer(), "sqlite")


class Base(DeclarativeBase):
    """Base khai báo chung.

    `type_annotation_map` để `dict` map thẳng sang JSON mà không cần khai báo lặp lại.
    """

    type_annotation_map = {dict: JSONType, dict[str, Any]: JSONType, list: JSONType}

    def to_dict(self, exclude: set[str] | None = None) -> dict[str, Any]:
        exclude = exclude or set()
        return {
            c.name: getattr(self, c.name)
            for c in self.__table__.columns
            if c.name not in exclude
        }


class IdMixin:
    id: Mapped[int] = mapped_column(PKType, primary_key=True, autoincrement=True)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )


class CreatedAtMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now(), index=True
    )
