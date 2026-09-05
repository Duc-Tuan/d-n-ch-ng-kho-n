"""Phân tích theo yêu cầu — khách hàng bấm nút, kết quả dùng chung cho cả ngày.

Thay cho cơ chế phân tích hằng ngày cũ (job 16:15 quét mọi chiến lược × mọi mã rồi để analyst
duyệt). Ba khác biệt đáng nói:

**Chạy khi có người cần, không quét sẵn.** Job cũ phân tích 400+ cặp mỗi phiên trong khi phần lớn
không ai mở ra xem — mỗi cặp là một lượt gọi mô hình. Giờ chỉ chạy đúng cặp có người bấm.

**Kết quả dùng chung theo ngày.** Khoá là `(analysis_date, strategy_id, symbol)` chứ không theo
người bấm: nến của một phiên là cố định, hai người hỏi cùng câu hỏi phải nhận cùng câu trả lời.
Người thứ hai đọc lại bản đã có, không tốn thêm lượt nào.

**Nhiều chiều lệnh trên một bản.** Bản phân tích cũ chỉ chứa được một điểm vào, nên một mã vừa có
kịch bản mua vừa có kịch bản bán thì phải chọn bỏ một. Điểm vào giờ nằm ở bảng con
`symbol_analysis_setups`, một bản chứa bao nhiêu chiều cũng được.

Bảng `analysis_runs` / `daily_analyses` của cơ chế cũ **không bị xoá** khỏi cơ sở dữ liệu — dữ
liệu lịch sử còn nguyên ở đó — nhưng không còn dòng mã nào đọc chúng nữa.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.constants import SymbolAnalysisStatus
from app.models.base import Base, CreatedAtMixin, IdMixin, PKType, TimestampMixin


class SymbolAnalysis(Base, IdMixin, TimestampMixin):
    """Một lượt phân tích. Hai loại, phân biệt bằng `strategy_id`:

    * **Theo chiến lược** (`strategy_id` có giá trị) — nút Phân tích ở màn chiến lược. Khoá
      `(analysis_date, strategy_id, symbol)`: mỗi ngày một bản, dùng chung cho mọi khách.
    * **Theo biểu đồ** (`strategy_id` để trống) — nút Phân tích ở màn bảng giá. Căn cứ không
      phải tài liệu chiến lược mà là **bộ chỉ báo người dùng đang bật trên biểu đồ**, chụp lại
      trong `context`. Hai người bật hai bộ chỉ báo khác nhau trên cùng một mã phải nhận hai
      nhận định khác nhau, nên loại này **không** dùng chung theo ngày: mỗi bộ chỉ báo là một
      bản riêng, nhận diện bằng `context_key`.

    Ràng buộc `uq_symbol_analysis_day` chỉ chặn được loại thứ nhất — SQL coi mọi `NULL` là khác
    nhau nên loại thứ hai đi lọt qua nó, và đó đúng là điều ta muốn. Phần chống chạy trùng của
    loại thứ hai nằm ở `market_ai.request_analysis`.
    """

    __tablename__ = "symbol_analyses"

    analysis_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    #: Để trống nghĩa là phân tích theo biểu đồ, không gắn với chiến lược nào.
    strategy_id: Mapped[int | None] = mapped_column(
        PKType, ForeignKey("strategies.id", ondelete="CASCADE"), nullable=True, index=True
    )
    symbol: Mapped[str] = mapped_column(String(20), nullable=False, index=True)

    #: ENGINE (bộ điều kiện chạy tại chỗ) hoặc AI (Claude đọc tài liệu) — theo `strategy.kind`.
    source: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    status: Mapped[str] = mapped_column(
        String(10), nullable=False, default=SymbolAnalysisStatus.QUEUED, index=True
    )

    #: Người bấm đầu tiên — người duy nhất bị trừ lượt cho bản này.
    requested_by: Mapped[int | None] = mapped_column(PKType, index=True)
    #: Tổng số lượt mở bản này, kể cả người đọc lại. Chỉ để thống kê, không dùng để chặn.
    view_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    duration_seconds: Mapped[int | None] = mapped_column(Integer)

    #: Tiêu đề ngắn cho khách, ví dụ "HPG: có điểm mua và điểm bán".
    title: Mapped[str | None] = mapped_column(String(255))
    #: Bản tin cho khách. HTML đã qua `html_sanitizer.sanitize_html()` **lúc lưu**.
    summary: Mapped[str | None] = mapped_column(Text)
    #: Lý do phân tích — văn bản thuần, KHÔNG phải HTML. Khách đọc được.
    rationale: Mapped[str | None] = mapped_column(Text)

    #: Số liệu thô và tên quy tắc bộ lọc — chất xám công ty, **không** ra khỏi vùng admin.
    evidence: Mapped[dict | None] = mapped_column(nullable=True)

    #: Căn cứ đầu vào của lượt phân tích theo biểu đồ: bộ chỉ báo đang bật kèm giá trị gần nhất
    #: của chúng. Chính người dùng chọn bộ này, nên nó **không** phải bí mật như `evidence` —
    #: giao diện hiện lại tên các chỉ báo để họ biết nhận định dựa trên cái gì.
    context: Mapped[dict | None] = mapped_column(nullable=True)
    #: Vân tay của `context` (mã, tham số các chỉ báo). Bấm lại cùng một bộ trong ngày thì đọc
    #: lại bản cũ thay vì tiêu thêm một lượt — xem `market_ai.fingerprint`.
    context_key: Mapped[str | None] = mapped_column(String(64), index=True)

    error_message: Mapped[str | None] = mapped_column(Text)

    setups: Mapped[list["SymbolAnalysisSetup"]] = relationship(
        back_populates="analysis", cascade="all, delete-orphan", order_by="SymbolAnalysisSetup.id"
    )

    __table_args__ = (
        # Khoá chống chạy trùng. Hai người bấm cùng lúc thì đúng một `INSERT` thắng, người còn
        # lại nhận IntegrityError rồi đọc chính dòng vừa được tạo — xem `ondemand.request_analysis`.
        UniqueConstraint("analysis_date", "strategy_id", "symbol", name="uq_symbol_analysis_day"),
        Index("ix_symbol_analysis_lookup", "strategy_id", "symbol", "analysis_date"),
        Index("ix_symbol_analysis_status", "status", "created_at"),
    )


class SymbolAnalysisSetup(Base, IdMixin):
    """Một kịch bản vào lệnh trong bản phân tích.

    Một bản có thể chứa **cả chiều mua lẫn chiều bán**: mã đang trong biên độ thường có kịch bản
    mua ở cạnh dưới và kịch bản bán ở cạnh trên, và người đọc cần thấy cả hai để tự chọn.
    Không có kịch bản nào cũng là kết quả hợp lệ — bản phân tích khi đó không có dòng con nào.
    """

    __tablename__ = "symbol_analysis_setups"

    analysis_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("symbol_analyses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    direction: Mapped[str] = mapped_column(String(4), nullable=False)
    entry_price: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    sl: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    tp: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    confidence: Mapped[str | None] = mapped_column(String(10))
    #: Điều kiện kích hoạt / ghi chú riêng cho kịch bản này. Văn bản thuần.
    note: Mapped[str | None] = mapped_column(Text)

    analysis: Mapped[SymbolAnalysis] = relationship(back_populates="setups")


class AnalysisQuotaUsage(Base, IdMixin, CreatedAtMixin):
    """Một dòng cho mỗi lượt **thực sự tốn** một lần chạy AI.

    Đếm bằng bảng nhật ký chứ không bằng một cột đếm: cột đếm chỉ trả lời được "còn mấy lượt",
    còn bảng này trả lời được cả "đã tiêu vào những mã nào" khi khách thắc mắc — và nó không bị
    sai khi hai yêu cầu ghi cùng lúc.

    Chỉ ghi khi lượt bấm khởi động một mẻ AI mới. Đọc lại bản đã có, hoặc chiến lược loại RULE
    (bộ điều kiện chạy tại chỗ, miễn phí), đều **không** ghi dòng nào.
    """

    __tablename__ = "analysis_quota_usage"

    user_id: Mapped[int] = mapped_column(PKType, nullable=False, index=True)
    usage_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    analysis_id: Mapped[int | None] = mapped_column(PKType, index=True)

    __table_args__ = (Index("ix_quota_user_date", "user_id", "usage_date"),)
