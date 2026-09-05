"""Chiến lược, tín hiệu và hỏi đáp (Phần 13, 14)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
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

from app.core.constants import (
    AnswerType,
    QuestionStatus,
    SignalResult,
    SignalType,
    StrategyKind,
    StrategyOwnerType,
    StrategyStatus,
)
from app.models.base import Base, CreatedAtMixin, IdMixin, PKType, TimestampMixin


class Strategy(Base, IdMixin, TimestampMixin):
    """Mục 13.1 — 'file chiến lược' của bạn."""

    __tablename__ = "strategies"

    code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    school: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text)
    rules_summary: Mapped[str | None] = mapped_column(Text)

    #: Không còn chọn được — mọi chiến lược chạy trên nến ngày. Giữ cột (thay vì bỏ hẳn) vì
    #: `signals.timeframe` vẫn ghi theo nó và toàn bộ lịch sử tín hiệu đang mang giá trị này.
    timeframe: Mapped[str] = mapped_column(String(10), nullable=False, default="D1")

    #: RULE hoặc DOCUMENT — xem `StrategyKind`. Hai loại tách hẳn nhau: loại RULE bắt buộc có
    #: `rules_json` và không đính tài liệu, loại DOCUMENT ngược lại. Ràng buộc được áp ở tầng
    #: service (`strategy_service.validate_kind`) chứ không ở CSDL: dữ liệu cũ có thể mang cả hai.
    kind: Mapped[str] = mapped_column(
        String(10), nullable=False, default=StrategyKind.RULE, index=True
    )

    #: Bộ lọc máy chạy được (YC10–YC12) — xem `app/services/strategy_engine/rules.py`.
    #:
    #: Tách khỏi `rules_summary`: cột kia là văn bản cho người đọc, cột này là dữ liệu cho máy
    #: chạy. Chiến lược thủ công (analyst tự phát tín hiệu) để NULL và vẫn hoạt động bình thường.
    #:
    #: BR-848 — nội dung cột này là chất xám của công ty, **không bao giờ** trả về cho khách hàng
    #: với chiến lược của hệ thống; khách chỉ nhận điểm mua/bán mà nó sinh ra.
    rules_json: Mapped[dict | None] = mapped_column()

    owner_type: Mapped[str] = mapped_column(String(10), nullable=False, default=StrategyOwnerType.SYSTEM)
    owner_id: Mapped[int | None] = mapped_column(PKType, index=True)  # user_id khi là chiến lược cá nhân
    is_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    #: BR-847 — đòn bẩy bán gói dài hạn.
    min_package_id: Mapped[int | None] = mapped_column(PKType, ForeignKey("packages.id"))
    status: Mapped[str] = mapped_column(
        String(15), nullable=False, default=StrategyStatus.DRAFT, index=True
    )
    #: Analyst phụ trách — dùng để tự phân câu hỏi (mục 14.2).
    analyst_id: Mapped[int | None] = mapped_column(PKType)
    created_by: Mapped[int | None] = mapped_column(PKType)

    symbols: Mapped[list["StrategySymbol"]] = relationship(
        back_populates="strategy", cascade="all, delete-orphan"
    )


class StrategySymbol(Base, IdMixin):
    """BR-860c — phạm vi mã của chiến lược."""

    __tablename__ = "strategy_symbols"

    strategy_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("strategies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    symbol: Mapped[str] = mapped_column(String(20), nullable=False, index=True)

    strategy: Mapped[Strategy] = relationship(back_populates="symbols")

    __table_args__ = (UniqueConstraint("strategy_id", "symbol", name="uq_strategy_symbol"),)


class Signal(Base, IdMixin, CreatedAtMixin):
    """BR-840 — **CHỈ ĐỌC sau khi tạo**.

    Việc chặn sửa được thực hiện ở hai tầng:
      1. `app/services/signal_service.py` không cung cấp hàm update;
      2. trigger MySQL `trg_signals_no_update` (xem migration) chặn UPDATE ở tầng CSDL,
         trừ các cột kết quả do job `close_signals` ghi.
    Muốn huỷ tín hiệu thì đặt `result = CANCELLED` kèm `cancel_reason`, giữ nguyên bản ghi gốc.
    """

    __tablename__ = "signals"

    strategy_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("strategies.id"), nullable=False, index=True
    )
    symbol: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    timeframe: Mapped[str] = mapped_column(String(10), nullable=False, default="D1")

    #: BR-841 — LIVE và BACKTEST không bao giờ gộp khi tính thống kê.
    signal_type: Mapped[str] = mapped_column(
        String(10), nullable=False, default=SignalType.LIVE, index=True
    )
    direction: Mapped[str] = mapped_column(String(4), nullable=False)

    entry_time: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    entry_price: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    sl: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    tp: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))

    exit_time: Mapped[datetime | None] = mapped_column(DateTime)
    exit_price: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    exit_reason: Mapped[str | None] = mapped_column(String(10))

    result: Mapped[str] = mapped_column(
        String(10), nullable=False, default=SignalResult.OPEN, index=True
    )
    r_multiple: Mapped[Decimal | None] = mapped_column(Numeric(10, 3))
    reason_text: Mapped[str | None] = mapped_column(Text)
    cancel_reason: Mapped[str | None] = mapped_column(String(255))
    created_by: Mapped[int | None] = mapped_column(PKType)

    strategy: Mapped[Strategy] = relationship()

    __table_args__ = (
        # Truy vấn nóng: lấy tín hiệu của một chiến lược trên một mã để vẽ marker.
        Index("ix_signal_strategy_symbol_time", "strategy_id", "symbol", "entry_time"),
        Index("ix_signal_type_result", "signal_type", "result"),
    )


class StrategyStat(Base, IdMixin):
    """BR-843 — thống kê tính sẵn; mặc định luôn là toàn bộ lịch sử."""

    __tablename__ = "strategy_stats"

    strategy_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("strategies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    symbol: Mapped[str | None] = mapped_column(String(20), index=True)  # NULL = toàn bộ mã
    signal_type: Mapped[str] = mapped_column(String(10), nullable=False)
    period_from: Mapped[date | None] = mapped_column(Date)
    period_to: Mapped[date | None] = mapped_column(Date)
    total_trades: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    win_rate: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))
    avg_r: Mapped[Decimal | None] = mapped_column(Numeric(10, 3))
    max_dd: Mapped[Decimal | None] = mapped_column(Numeric(10, 3))
    profit_factor: Mapped[Decimal | None] = mapped_column(Numeric(10, 3))
    calculated_at: Mapped[datetime | None] = mapped_column(DateTime)

    __table_args__ = (
        UniqueConstraint("strategy_id", "symbol", "signal_type", name="uq_stat_scope"),
    )


class StrategyQuestion(Base, IdMixin, TimestampMixin):
    """Mục 14.4 — BR-850 cách ly dữ liệu giữa các KH."""

    __tablename__ = "strategy_questions"

    strategy_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("strategies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    signal_id: Mapped[int | None] = mapped_column(PKType, ForeignKey("signals.id"))
    user_id: Mapped[int] = mapped_column(PKType, nullable=False, index=True)

    question: Mapped[str] = mapped_column(Text, nullable=False)
    #: BR-850 — mặc định riêng tư, chỉ hiện với chính KH đó.
    is_private: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    answer_type: Mapped[str | None] = mapped_column(String(10))
    answer: Mapped[str | None] = mapped_column(Text)
    answered_by: Mapped[int | None] = mapped_column(PKType)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime)

    #: BR-858 — chỉ thành FAQ công khai sau khi người có quyền content.publish duyệt.
    is_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    approved_by: Mapped[int | None] = mapped_column(PKType)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    helpful_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    status: Mapped[str] = mapped_column(
        String(15), nullable=False, default=QuestionStatus.PENDING, index=True
    )
    #: BR-857 — cam kết trả lời trong 24 giờ làm việc.
    sla_due_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)
    assigned_to: Mapped[int | None] = mapped_column(PKType, index=True)


class StrategyFaq(Base, IdMixin, TimestampMixin):
    __tablename__ = "strategy_faq"

    strategy_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("strategies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    question: Mapped[str] = mapped_column(Text, nullable=False)
    answer: Mapped[str] = mapped_column(Text, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source_question_id: Mapped[int | None] = mapped_column(PKType)
    view_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class StrategyKbDoc(Base, IdMixin, CreatedAtMixin):
    """Mục 14.4 — tài liệu nền cho hỏi đáp AI (mô hình B, v2)."""

    __tablename__ = "strategy_kb_docs"

    strategy_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("strategies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    document_id: Mapped[int] = mapped_column(PKType, ForeignKey("documents.id"), nullable=False)
    indexed_at: Mapped[datetime | None] = mapped_column(DateTime)
    #: PENDING | OK | EMPTY | UNSUPPORTED — xem `app.core.constants.KbIndexStatus`.
    #: Cột này có sẵn từ đầu nhưng chưa ai cập nhật; nó được thiết kế cho đúng việc bóc chữ này.
    index_status: Mapped[str] = mapped_column(String(20), nullable=False, default="PENDING")

    #: Toàn văn đã bóc từ file gốc, cache tại đây. Bóc một lần rồi dùng lại: MCP tool trả về
    #: tức thì và **giống hệt nhau** giữa các lô — cùng bối cảnh thì kết quả mới so sánh được.
    extracted_text: Mapped[str | None] = mapped_column(Text)
    extracted_at: Mapped[datetime | None] = mapped_column(DateTime)

    __table_args__ = (UniqueConstraint("strategy_id", "document_id", name="uq_kb_doc"),)


class StrategyShare(Base, IdMixin, CreatedAtMixin):
    """Chia sẻ chiến lược cá nhân giữa các khách hàng.

    Chiến lược do khách hàng tự tạo mặc định **chỉ mình họ nhìn thấy** (BR-850 — nguyên tắc cách
    ly dữ liệu giữa các khách hàng). Muốn người khác dùng được thì phải chia sẻ tường minh.

    Hai cách chia sẻ:
      * `shared_with_user_id` — chỉ đích danh một khách hàng.
      * `share_token` — sinh link, ai có link và đang đăng nhập thì nhận được chiến lược.

    Luôn giữ `owner_id` ở bảng `strategies` để biết ai là tác giả gốc, kể cả sau khi chia sẻ.
    """

    __tablename__ = "strategy_shares"

    strategy_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("strategies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: Chủ sở hữu thực hiện chia sẻ — dùng để thu hồi và để ghi nhật ký.
    shared_by_user_id: Mapped[int] = mapped_column(PKType, nullable=False, index=True)

    #: NULL khi chia sẻ bằng link thay vì chỉ đích danh người nhận.
    shared_with_user_id: Mapped[int | None] = mapped_column(PKType, index=True)
    share_token: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)

    #: Người nhận chỉ được XEM, không sửa và không chia sẻ tiếp.
    can_view: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    accepted_at: Mapped[datetime | None] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime)
    note: Mapped[str | None] = mapped_column(String(255))

    __table_args__ = (
        UniqueConstraint("strategy_id", "shared_with_user_id", name="uq_share_target"),
        Index("ix_share_active", "shared_with_user_id", "revoked_at"),
    )
