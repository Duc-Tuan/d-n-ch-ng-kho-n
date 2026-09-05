"""Ảnh nhúng trong bài viết (YC14).

Tách khỏi bảng `documents` vì hai thứ khác hẳn nhau về nghiệp vụ, dù cùng là "file tải lên":

* **Tài liệu** (`documents`) — sản phẩm bán kèm gói. Có kiểm tra quyền theo gói, có đóng dấu chìm
  theo từng khách, có ghi nhật ký từng lượt tải (BR-511, 512, 513).
* **Ảnh minh hoạ** (`media_assets`) — một phần của bài viết. Ai đọc được bài thì phải xem được
  ảnh; đóng dấu chìm hay ghi nhật ký từng lượt xem đều vô nghĩa với ảnh nằm giữa đoạn văn.

Gộp chung một bảng sẽ buộc phải cài cờ "loại này thì bỏ qua kiểm tra quyền" — chính là kiểu ngoại
lệ về sau sẽ bị dùng nhầm chỗ và làm rò rỉ tài liệu bán tiền.
"""

from __future__ import annotations

from sqlalchemy import BigInteger, Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, CreatedAtMixin, IdMixin, PKType


class MediaAsset(Base, IdMixin, CreatedAtMixin):
    __tablename__ = "media_assets"

    #: Tên đã đổi khi lưu (BR-510) — cũng chính là phần cuối của đường dẫn xem ảnh.
    stored_name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    file_size: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer(), "sqlite"), nullable=False
    )
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)

    #: Văn bản thay thế — biên tập nhập lúc chèn, dùng lại khi ảnh không tải được.
    alt_text: Mapped[str | None] = mapped_column(String(255))

    uploaded_by: Mapped[int] = mapped_column(PKType, nullable=False, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
