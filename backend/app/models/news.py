"""Tin tức dẫn nguồn — bản ghi trỏ sang bài gốc ở trang khác.

Hai đường vào, cùng đổ về một bảng:

* **Nhập tay** — dán đường dẫn một bài ở màn quản trị.
* **Kéo tự động** — `NewsSource` giữ đường dẫn trang chuyên mục (hoặc feed) của báo, job
  `sync_news` chạy theo giờ đặt trong cấu hình, dò bài mới rồi tự thêm vào.

Kéo tự động dừng ở **phần mô tả**: tiêu đề, tóm tắt, ảnh đại diện, ngày đăng — đúng những gì
trang nguồn tự khai trong thẻ Open Graph để được chia sẻ lại. Không lấy và không lưu toàn văn
bài: lưu toàn văn nghĩa là đăng lại nội dung của người khác trên tên miền của mình, đó là chuyện
bản quyền chứ không phải chuyện kỹ thuật. Khách bấm vào tin là sang thẳng trang gốc.

Điểm yếu đã biết của cách này là bộ dò liên kết: mỗi trang chuyên mục có cấu trúc HTML riêng và
đổi giao diện bất cứ lúc nào, khi đó bộ dò không "báo lỗi" mà chỉ lặng lẽ không tìm thấy bài nào.
Vì vậy `NewsSource` giữ kết quả lượt chạy gần nhất và một lượt **không ra bài nào** bị ghi là
lỗi chứ không phải thành công — xem `services/news_sync_service.py`.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, IdMixin, PKType, TimestampMixin


class NewsSource(Base, IdMixin, TimestampMixin):
    """Một trang nguồn được theo dõi: trang chuyên mục của báo, hoặc feed RSS/Atom nếu có.

    Cùng một ô nhập cho cả hai: job tự nhận ra mình đang đọc XML hay HTML. Feed thì chắc chắn
    hơn vì chính trang nguồn phát ra và tự giữ đúng định dạng, nên nếu báo có feed thì nên dán
    feed — nhưng không bắt buộc, vì phần lớn báo trong nước không công bố feed cho từng chuyên mục.
    """

    __tablename__ = "news_sources"

    #: Tên hiện dưới tiêu đề tin ở site khách ("CafeF", "VnEconomy"…).
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    #: Trang chuyên mục hoặc feed. Job đọc trang này để **tìm** bài, không để lấy nội dung bài.
    url: Mapped[str] = mapped_column(String(1000), nullable=False)

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    #: Trần số bài **mở ra xem** mỗi lượt, không phải số tin sẽ lấy: bộ lọc thật là "đăng
    #: trong ngày hôm nay". Đây chỉ là chốt chặn để một trang chuyên mục dài không kéo theo
    #: hàng trăm lượt tải về phía trang nguồn.
    max_items: Mapped[int] = mapped_column(Integer, nullable=False, default=15)

    #: Kết quả lượt chạy gần nhất — để màn quản trị nói được nguồn nào đang hỏng.
    #:
    #: `PENDING` → `RUNNING` → `SUCCESS` / `PARTIAL` / `FAILED`. Hai trạng thái đầu được ghi
    #: **trong lúc** lượt chạy diễn ra, đó là thứ màn quản trị đọc để vẽ tiến trình; không có
    #: chúng thì một lượt kéo mười nguồn im lặng suốt vài phút rồi mới đổi trạng thái cùng lúc.
    last_status: Mapped[str | None] = mapped_column(String(20))
    last_error: Mapped[str | None] = mapped_column(String(500))

    #: Mốc **bắt đầu** lượt gần nhất. Cả các nguồn trong cùng một lượt được đóng đúng một mốc,
    #: nên giao diện nhận ra đâu là một mẻ để đếm "xong mấy trên tổng số mấy".
    last_started_at: Mapped[datetime | None] = mapped_column(DateTime)
    #: Mốc **kết thúc** lượt gần nhất.
    last_fetched_at: Mapped[datetime | None] = mapped_column(DateTime)

    #: Số tin thêm được riêng ở lượt gần nhất.
    last_added: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    #: Tổng số tin đã đưa về từ nguồn này, cộng dồn qua các lượt.
    item_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_by: Mapped[int | None] = mapped_column(PKType)


class NewsItem(Base, IdMixin, TimestampMixin):
    __tablename__ = "news_items"

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    #: Mô tả ngắn hiển thị trên thẻ tin. Văn bản thuần — không render bằng HTML.
    summary: Mapped[str | None] = mapped_column(Text)

    #: Đường dẫn bài gốc. Là thứ khách được đưa tới khi bấm vào tin.
    url: Mapped[str] = mapped_column(String(1000), nullable=False)
    #: Ảnh đại diện lấy từ thẻ `og:image` của bài. Chỉ giữ đường dẫn, ảnh vẫn nằm bên trang nguồn.
    image_url: Mapped[str | None] = mapped_column(String(1000))
    #: Tên trang nguồn hiện dưới tiêu đề ("CafeF", "VnEconomy"…). Suy ra từ tên miền nếu bỏ trống.
    source_name: Mapped[str | None] = mapped_column(String(120), index=True)

    #: Ngày đăng của bài **gốc**, không phải lúc nhân viên nhập vào hệ thống.
    published_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    #: Gỡ khỏi site khách mà vẫn giữ bản ghi — link hỏng hoặc bài bị gỡ bên nguồn.
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    #: Ghim lên đầu. Số lớn hơn đứng trước, mặc định 0 thì sắp theo ngày đăng.
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    click_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_by: Mapped[int | None] = mapped_column(PKType)

    #: Nguồn đã kéo tin này về. NULL = nhân viên nhập tay.
    source_id: Mapped[int | None] = mapped_column(
        PKType, ForeignKey("news_sources.id", ondelete="SET NULL"), index=True
    )
    #: SHA-256 của đường dẫn đã chuẩn hoá — khoá chống trùng, xem `news_sync_service.url_hash`.
    #:
    #: Băm thay vì đánh chỉ mục thẳng lên `url` vì InnoDB không đánh chỉ mục duy nhất được cho
    #: cột 1000 ký tự utf8mb4. Tin nhập tay cũng có băm, nên job sẽ không thêm lại bài mà nhân
    #: viên đã tự dán vào trước đó.
    url_hash: Mapped[str | None] = mapped_column(String(64))

    __table_args__ = (
        # Truy vấn nóng phía khách: tin đang bật, ghim trước rồi tới mới nhất.
        Index("ix_news_active_order", "is_active", "sort_order", "published_at"),
        # Chốt chặn chống trùng nằm ở CSDL chứ không ở mã: job có thể chạy chồng lượt (bấm chạy
        # tay đúng lúc lịch nổ), và "kiểm tra đã có chưa rồi mới chèn" để lọt đúng khe đó.
        # NULL không tính vào ràng buộc unique nên các bản ghi cũ chưa có băm không bị ảnh hưởng.
        Index("uq_news_url_hash", "url_hash", unique=True),
    )
