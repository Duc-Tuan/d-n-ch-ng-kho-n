"""Schema cho các thực thể nghiệp vụ: gói, nội dung, chiến lược, thông báo, quản trị."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.core.constants import (
    DISCLAIMER_TEXT,
    AlertType,
    ArticleStatus,
    SignalDirection,
    SignalType,
    StrategyKind,
    StrategySchool,
)
from app.schemas.common import Money, ORMModel


# ======================================================================
# GÓI DỊCH VỤ
# ======================================================================
class PackageOut(ORMModel):
    id: int
    code: str
    name: str
    duration_months: int
    duration_days: int
    price: Money
    is_trial: bool
    tier: int
    description: str | None = None
    max_telegram_alerts: int
    max_ai_questions_per_day: int


class PurchaseRequest(BaseModel):
    package_id: int
    #: BR-200 — bắt buộc với tuyến IB.
    securities_account_no: str | None = Field(default=None, max_length=50)
    payment_method: Literal["BANK_TRANSFER", "VNPAY", "MOMO", "MANUAL"] = "BANK_TRANSFER"
    #: BR-800 — tick đồng ý chính sách thanh toán & hoàn tiền trước khi thanh toán.
    accept_refund_policy: bool = False


class IbLinkRequest(BaseModel):
    securities_account_no: str = Field(min_length=4, max_length=50)


class SubscriptionHistoryItem(ORMModel):
    id: int
    package_name: str
    starts_at: datetime
    expires_at: datetime
    amount: Money
    payment_status: str
    frozen_days: int
    created_by_type: str
    note: str | None = None
    created_at: datetime


# ======================================================================
# NỘI DUNG
# ======================================================================
class CategoryOut(ORMModel):
    id: int
    code: str
    name: str
    type: str
    sort_order: int


class ArticleListItem(ORMModel):
    id: int
    title: str
    slug: str
    excerpt: str | None = None
    thumbnail: str | None = None
    category_id: int
    category_name: str | None = None
    status: str
    published_at: datetime | None = None
    view_count: int
    min_package_id: int | None = None
    #: Tính theo gói hiện tại của KH (BR-502) — FE dùng để hiện khoá và nút nâng cấp.
    locked: bool = False


class ArticleDetail(ArticleListItem):
    content: str | None = None
    tags: str | None = None
    author_id: int
    updated_at: datetime | None = None


class ArticleCreateRequest(BaseModel):
    category_id: int
    title: str = Field(min_length=3, max_length=255)
    slug: str | None = Field(default=None, max_length=255)
    excerpt: str | None = None
    content: str = Field(min_length=1)
    thumbnail: str | None = None
    tags: str | None = None
    min_package_id: int | None = None
    #: BR-501 — cho phép đặt lịch xuất bản trong tương lai.
    published_at: datetime | None = None


class ArticleUpdateRequest(ArticleCreateRequest):
    change_note: str | None = Field(default=None, max_length=255)


class ArticleStatusRequest(BaseModel):
    status: Literal[
        ArticleStatus.DRAFT, ArticleStatus.PENDING_REVIEW,
        ArticleStatus.PUBLISHED, ArticleStatus.ARCHIVED,
    ]
    published_at: datetime | None = None


class DocumentListItem(ORMModel):
    id: int
    title: str
    description: str | None = None
    category_id: int
    category_name: str | None = None
    original_name: str
    file_size: int
    mime_type: str
    download_count: int
    min_package_id: int | None = None
    locked: bool = False
    created_at: datetime


class DownloadTicket(BaseModel):
    """BR-511 — signed URL TTL ngắn thay cho link tĩnh."""

    url: str
    expires_at: datetime
    ttl_seconds: int
    watermarked: bool


# ======================================================================
# CHIẾN LƯỢC & TÍN HIỆU
# ======================================================================
class StrategyListItem(ORMModel):
    id: int
    code: str
    name: str
    school: str
    #: RULE (bộ điều kiện) hoặc DOCUMENT (tài liệu). Giao diện dựa vào đây để biết nút Phân tích
    #: sẽ chạy bộ điều kiện tại chỗ hay gọi AI — hai đường có thời gian chờ khác hẳn nhau.
    kind: str = "RULE"
    #: Luôn là "D1". Giữ trong phản hồi vì giao diện biểu đồ và `signals` vẫn hiển thị nó.
    timeframe: str
    description: str | None = None
    status: str
    min_package_id: int | None = None
    locked: bool = False
    symbols: list[str] = []

    @field_validator("symbols", mode="before")
    @classmethod
    def _symbols_to_str(cls, v):
        """`Strategy.symbols` là quan hệ tới StrategySymbol — quy về danh sách mã."""
        if not v:
            return []
        return [item if isinstance(item, str) else item.symbol for item in v]

    #: BR-843 — thống kê LIVE và BACKTEST luôn tách riêng.
    stats_live: dict[str, Any] | None = None
    stats_backtest: dict[str, Any] | None = None


class StrategyDetail(StrategyListItem):
    rules_summary: str | None = None
    analyst_id: int | None = None
    created_at: datetime


class SignalOut(ORMModel):
    id: int
    strategy_id: int
    symbol: str
    timeframe: str
    signal_type: str
    direction: str
    entry_time: datetime
    entry_price: Money
    sl: Money | None = None
    tp: Money | None = None
    exit_time: datetime | None = None
    exit_price: Money | None = None
    exit_reason: str | None = None
    result: str
    r_multiple: Money | None = None
    reason_text: str | None = None
    cancel_reason: str | None = None


class MarkerResponse(BaseModel):
    """Dữ liệu vẽ marker lên biểu đồ (mục 13.2)."""

    total: int
    returned: int
    #: BR-845 — FE hiển thị cảnh báo và gợi ý thu hẹp khoảng thời gian.
    truncated: bool
    max_markers: int
    signals: list[SignalOut]
    #: BR-841 — chú thích phân biệt LIVE/BACKTEST hiển thị cố định trên biểu đồ.
    legend: dict[str, str] = {
        "LIVE": "Tín hiệu thực — đã phát ra tại thời điểm thực",
        "BACKTEST": "Mô phỏng — tính lại trên dữ liệu lịch sử, chưa từng phát ra thực tế",
    }
    disclaimer: str


class SignalCreateRequest(BaseModel):
    strategy_id: int
    symbol: str = Field(min_length=1, max_length=20)
    direction: Literal[SignalDirection.BUY, SignalDirection.SELL]
    signal_type: Literal[SignalType.LIVE, SignalType.BACKTEST] = SignalType.LIVE
    entry_time: datetime
    entry_price: Decimal = Field(gt=0)
    sl: Decimal | None = None
    tp: Decimal | None = None
    timeframe: str | None = Field(default=None, max_length=10)
    reason_text: str | None = None


class StrategyCreateRequest(BaseModel):
    code: str = Field(min_length=2, max_length=50)
    name: str = Field(min_length=2, max_length=150)
    school: Literal[
        StrategySchool.SMC, StrategySchool.ICT, StrategySchool.PRICE_ACTION,
        StrategySchool.QUANT, StrategySchool.INDICATOR,
    ]
    #: Bắt buộc chọn ngay lúc tạo và **không đổi được sau đó**: đổi loại nghĩa là vứt bỏ hoặc bộ
    #: điều kiện hoặc toàn bộ tài liệu đã gắn, và mọi bản phân tích cũ sinh ra từ loại trước đó
    #: trở thành không giải thích được. Cần đổi thì tạo chiến lược mới.
    kind: Literal[StrategyKind.RULE, StrategyKind.DOCUMENT] = StrategyKind.RULE
    # `timeframe` cố ý **không** có ở đây: toàn hệ thống chạy trên nến ngày, không cho chọn.
    description: str | None = None
    rules_summary: str | None = None
    min_package_id: int | None = None
    analyst_id: int | None = None
    symbols: list[str] = []


class StrategyRulesRequest(BaseModel):
    """Bộ lọc phân tích của chiến lược. `rules = null` nghĩa là gỡ bộ lọc, quay về phát tay."""

    rules: dict[str, Any] | None = None


class StrategyDocumentRequest(BaseModel):
    """Gắn một tài liệu đã có trong kho vào chiến lược."""

    document_id: int


class StrategyTryRequest(BaseModel):
    """Chạy thử bộ lọc chưa lưu lên một mã."""

    symbol: str = Field(min_length=1, max_length=20)
    rules: dict[str, Any]
    from_date: date | None = None


class QuestionCreateRequest(BaseModel):
    strategy_id: int
    signal_id: int | None = None
    question: str = Field(min_length=5, max_length=2000)


class QuestionAnswerRequest(BaseModel):
    answer: str = Field(min_length=1)
    #: BR-858 — chỉ người có quyền content.publish mới đặt được cờ này.
    make_public: bool = False


class QuestionOut(ORMModel):
    id: int
    strategy_id: int
    signal_id: int | None = None
    question: str
    answer: str | None = None
    answer_type: str | None = None
    answered_at: datetime | None = None
    status: str
    is_public: bool
    helpful_count: int
    sla_due_at: datetime | None = None
    created_at: datetime


# ======================================================================
# TELEGRAM
# ======================================================================
class TelegramStatusOut(BaseModel):
    status: str
    chat_id: int | None = None
    telegram_username: str | None = None
    verified_at: datetime | None = None
    last_error: str | None = None
    usage: dict[str, Any]


class TelegramConnectResponse(BaseModel):
    deep_link: str
    bot_username: str
    expires_at: datetime
    ttl_minutes: int


class TelegramManualRequest(BaseModel):
    chat_id: int
    #: BR-879 — checkbox đồng ý riêng cho việc gửi dữ liệu qua Telegram.
    accept_telegram_consent: bool


class TelegramVerifyRequest(BaseModel):
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")


class AlertSubscribeRequest(BaseModel):
    strategy_id: int
    #: BR-858 — cho tick nhiều mã cùng lúc; về dữ liệu vẫn sinh N bản ghi cặp riêng biệt.
    symbols: list[str] = Field(min_length=1, max_length=50)
    alert_types: list[
        Literal[AlertType.ENTRY, AlertType.TP, AlertType.SL, AlertType.CANCELLED]
    ] | None = None


class AlertOut(ORMModel):
    id: int
    strategy_id: int
    strategy_name: str | None = None
    symbol: str
    alert_types: dict[str, Any] | None = None
    is_active: bool
    inactive_reason: str | None = None
    created_at: datetime


# ======================================================================
# THÔNG BÁO
# ======================================================================
class NotificationOut(ORMModel):
    id: int
    code: str
    channel: str
    subject: str | None = None
    body: str | None = None
    status: str
    read_at: datetime | None = None
    created_at: datetime


class NotificationPreferenceItem(BaseModel):
    code: str
    channel: str
    enabled: bool
    #: BR-815 — nhóm bắt buộc thì FE hiển thị khoá kèm lý do.
    locked: bool = False
    label: str | None = None


class BroadcastRequest(BaseModel):
    """BR-818 — gửi thông báo thủ công theo bộ lọc, bắt buộc xem trước."""

    subject: str = Field(min_length=1, max_length=255)
    body: str = Field(min_length=1)
    channels: list[Literal["EMAIL", "IN_APP", "SMS"]] = ["IN_APP"]
    filter_subscription_status: list[str] | None = None
    filter_compliance_status: list[str] | None = None
    filter_expiring_in_days: int | None = None
    confirm: bool = False
    confirmed_recipient_count: int | None = None


# ======================================================================
# QUẢN TRỊ — KHÁCH HÀNG
# ======================================================================
class CustomerListItem(ORMModel):
    id: int
    email: str
    full_name: str
    phone: str | None = None
    customer_code: str | None = None
    customer_type: str
    securities_account_no: str | None = None
    package_name: str | None = None
    expires_at: datetime | None = None
    latest_nav: Money | None = None
    latest_nav_date: date | None = None
    last_trade_date: date | None = None
    subscription_status: str
    compliance_status: str
    compliance_exempt: bool
    warning_until: datetime | None = None
    last_login_at: datetime | None = None
    created_at: datetime


class GrantPackageRequest(BaseModel):
    package_id: int
    reason: str = Field(min_length=3, max_length=500)
    amount: Money | None = None
    note: str | None = None


class SuspendRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class ExemptRequest(BaseModel):
    exempt: bool
    reason: str = Field(min_length=3, max_length=500)


class CustomerNoteRequest(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


class NavPoint(BaseModel):
    trade_date: date
    nav: Money
    last_trade_date: date | None = None


class ComplianceEventOut(ORMModel):
    id: int
    event: str
    from_status: str | None = None
    to_status: str | None = None
    reason: str | None = None
    nav_avg_20: Money | None = None
    days_since_last_trade: int | None = None
    triggered_by: str
    created_at: datetime


class LoginLogOut(ORMModel):
    id: int
    ip: str | None = None
    user_agent: str | None = None
    result: str
    note: str | None = None
    created_at: datetime


# ======================================================================
# QUẢN TRỊ — NHÂN VIÊN
# ======================================================================
class StaffCreateRequest(BaseModel):
    username: str = Field(min_length=3, max_length=60)
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=150)
    phone: str | None = Field(default=None, max_length=20)
    password: str = Field(min_length=8, max_length=128)
    role_codes: list[str] = Field(min_length=1)


class StaffUpdateRequest(BaseModel):
    email: EmailStr | None = None
    full_name: str | None = Field(default=None, max_length=150)
    phone: str | None = Field(default=None, max_length=20)
    status: Literal["ACTIVE", "INACTIVE"] | None = None
    role_codes: list[str] | None = None
    reason: str | None = Field(default=None, max_length=500)


class StaffListItem(ORMModel):
    id: int
    username: str
    email: str
    full_name: str
    phone: str | None = None
    status: str
    totp_enabled: bool
    last_login_at: datetime | None = None
    roles: list[str] = []
    created_at: datetime


class RoleOut(ORMModel):
    id: int
    code: str
    name: str
    description: str | None = None
    is_system: bool
    permissions: list[str] = []


class AuditLogOut(ORMModel):
    id: int
    actor_id: int | None = None
    actor_name: str | None = None
    actor_type: str
    action: str
    target_type: str | None = None
    target_id: str | None = None
    old_value: dict[str, Any] | None = None
    new_value: dict[str, Any] | None = None
    reason: str | None = None
    ip: str | None = None
    created_at: datetime


# ======================================================================
# DASHBOARD — mục 3.1
# ======================================================================
class DashboardStats(BaseModel):
    accounts: dict[str, Any]
    revenue: dict[str, Any]
    compliance: dict[str, Any]
    content: dict[str, Any]
    last_sync: dict[str, Any] | None = None
    alerts: list[dict[str, Any]] = []


class SyncJobOut(ORMModel):
    id: int
    job_type: str
    run_date: date
    status: str
    rows_read: int
    rows_matched: int
    rows_unmatched: int
    rows_written: int
    error_message: str | None = None
    summary: dict[str, Any] | None = None
    started_at: datetime
    finished_at: datetime | None = None
    triggered_by: str


# ======================================================================
# VĂN BẢN PHÁP LÝ
# ======================================================================
class LegalDocumentOut(ORMModel):
    id: int
    type: str
    version: str
    title: str
    content: str | None = None
    effective_from: datetime
    is_current: bool
    requires_reconsent: bool
    summary_of_changes: str | None = None


class LegalDocumentCreateRequest(BaseModel):
    type: str
    version: str = Field(max_length=20)
    title: str = Field(max_length=255)
    content: str
    effective_from: datetime
    requires_reconsent: bool = False
    summary_of_changes: str | None = None


class ConsentRequest(BaseModel):
    legal_document_ids: list[int] = Field(min_length=1)


# ======================================================================
# DỮ LIỆU THỊ TRƯỜNG — Phần 12
# ======================================================================
class SymbolOut(ORMModel):
    id: int
    symbol: str
    exchange: str
    company_name: str | None = None
    last_ohlcv_date: date | None = None


class CandleOut(ORMModel):
    trade_date: date
    open: Money
    high: Money
    low: Money
    close: Money
    volume: int


class PriceBoardItem(BaseModel):
    symbol: str
    exchange: str
    company_name: str | None = None
    trade_date: date | None = None
    open: Money | None = None
    high: Money | None = None
    low: Money | None = None
    close: Money | None = None
    volume: int | None = None
    reference: Money | None = None
    change: Money | None = None
    change_pct: float | None = None
    has_data: bool = False


# ======================================================================
# PHÂN TÍCH THEO YÊu CẦU — khách bấm nút, kết quả dùng chung theo ngày
# ======================================================================
class AnalysisSetupOut(ORMModel):
    """Một kịch bản vào lệnh. Một bản phân tích có thể có nhiều kịch bản, cả mua lẫn bán."""

    id: int
    direction: Literal["BUY", "SELL"]
    entry_price: Money
    sl: Money | None = None
    tp: Money | None = None
    confidence: str | None = None
    note: str | None = None


class RelatedArticleOut(ORMModel):
    """Bài viết doanh nghiệp gắn kèm một bản phân tích.

    Nối bằng **thẻ**: biên tập viên gõ mã chứng khoán vào ô Thẻ của bài viết, và bản phân tích
    mã đó tự tìm thấy bài. Cố ý không thêm bảng nối hay cột `symbol` riêng — thẻ là thứ biên tập
    viên đã dùng sẵn, và một bài phân tích ngành có thể mang nhiều mã cùng lúc.

    Không có `content`: đây là thẻ dẫn sang bài, không phải bản sao bài. Nội dung vẫn đi qua
    `GET /customer/articles/{slug}` để giữ nguyên phép kiểm tra gói (BR-502) và phép đếm lượt
    xem ở một chỗ duy nhất.
    """

    id: int
    title: str
    slug: str
    excerpt: str | None = None
    published_at: datetime | None = None
    #: BR-502 — bài thuộc gói cao hơn vẫn hiện tên để khách biết có gì, nhưng mở ra là chặn.
    locked: bool = False


class AnalysisOut(ORMModel):
    """Bản phân tích **cho khách hàng**.

    Cố ý không có `evidence`: đó là số liệu thô và tên quy tắc bộ lọc — chất xám công ty
    (BR-848). Việc che nằm ở tầng schema chứ không ở giao diện: ẩn ngoài màn hình mà API vẫn
    trả thì mở tab mạng là đọc được.
    """

    id: int
    analysis_date: date
    #: Để trống = phân tích theo biểu đồ ở màn bảng giá, không gắn chiến lược nào.
    strategy_id: int | None = None
    symbol: str
    source: str
    status: str

    title: str | None = None
    #: HTML đã lọc **lúc lưu**. Giao diện render bằng `dangerouslySetInnerHTML`.
    summary: str | None = None
    #: Văn bản thuần, KHÔNG phải HTML — giao diện phải render bằng text.
    rationale: str | None = None

    setups: list[AnalysisSetupOut] = []

    started_at: datetime | None = None
    completed_at: datetime | None = None
    duration_seconds: int | None = None
    error_message: str | None = None
    view_count: int = 0
    created_at: datetime

    #: Gắn thêm ở tầng API để giao diện không phải gọi thêm một lượt.
    strategy_name: str | None = None
    #: Bài viết có thẻ trùng mã đang phân tích. Rỗng là bình thường — phần lớn mã chưa có bài.
    related_articles: list[RelatedArticleOut] = []
    #: Tên các chỉ báo mà lượt phân tích theo biểu đồ đã dựa vào. Khác `evidence`: bộ chỉ báo là
    #: do chính khách chọn, giấu đi thì họ không biết nhận định căn cứ vào đâu.
    used_indicators: list[str] = []
    #: Lời dặn khách gửi kèm lúc bấm nút. Trả lại để màn hình in ra ngay trên kết quả: đọc một
    #: nhận định mà không nhớ mình đã hỏi gì thì không đánh giá được nó có trả lời đúng hay không.
    note: str = ""
    disclaimer: str = DISCLAIMER_TEXT


class AnalysisDayOut(ORMModel):
    """Một mục trong danh sách ngày để khách chọn xem lại.

    Cố ý **không** chứa nội dung phân tích: danh sách này chỉ để chọn ngày, còn nội dung lấy
    bằng một lượt gọi riêng cho đúng ngày được chọn. Nhét cả `summary` vào đây là tải về 30 bản
    phân tích chỉ để hiện 30 dòng ngày tháng.
    """

    id: int
    analysis_date: date
    source: str
    title: str | None = None
    setup_count: int = 0


class IndicatorPlotIn(BaseModel):
    """Một đường của chỉ báo, kèm các giá trị gần nhất."""

    key: str = Field(max_length=40)
    label: str = Field(max_length=80)
    #: `[["2026-09-02", 54.3], …]` — kèm ngày để mô hình khớp được với nến, không phải đếm lùi.
    points: list[tuple[str, float]] = Field(default=[], max_length=120)


class IndicatorSnapshotIn(BaseModel):
    """Một chỉ báo đang bật trên biểu đồ, ở dạng giao diện gửi lên máy chủ.

    Giá trị do giao diện tính và gửi kèm (xem `market_ai`): công thức của 37 chỉ báo nằm ở
    frontend, chép sang Python là nhân đôi rồi để hai bản trôi khỏi nhau.
    """

    id: str = Field(max_length=40)
    name: str = Field(max_length=120)
    #: Nhãn hiện trên biểu đồ, ví dụ "RSI 14" — cũng là thứ khách thấy lại trong kết quả.
    label: str = Field(max_length=120)
    placement: Literal["overlay", "pane"] = "overlay"
    params: dict[str, str | float | bool | None] = Field(default={})
    plots: list[IndicatorPlotIn] = Field(default=[], max_length=10)
    #: Những gì không vẽ thành đường: vùng Order Block, khoảng FVG, tín hiệu UT Bot… Giao diện
    #: tự diễn giải thành câu vì chỉ nó biết ý nghĩa hình nó vẽ ra.
    notes: list[str] = Field(default=[], max_length=30)


class MarketAnalysisRequest(BaseModel):
    """Yêu cầu phân tích một mã theo đúng bộ chỉ báo đang bật trên biểu đồ."""

    symbol: str = Field(min_length=1, max_length=20)
    indicators: list[IndicatorSnapshotIn] = Field(default=[], max_length=12)
    #: Lời dặn của khách gửi kèm ("chỉ quan tâm chiều mua", "tôi đang giữ giá vốn 21.5"…).
    #: Chặn ở 1000 ký tự: đủ cho một yêu cầu cụ thể, không đủ để dán cả một tài liệu vào rồi
    #: biến lượt phân tích thành một cuộc trò chuyện chung chung không còn bám vào biểu đồ.
    note: str | None = Field(default=None, max_length=1000)


class AnalysisRequestResult(BaseModel):
    """Phản hồi của nút Phân tích.

    `started` phân biệt hai tình huống trông giống nhau trên màn hình: lượt bấm này khởi động
    một mẻ mới (có trừ hạn mức) hay chỉ đọc lại bản đã có (không trừ gì).
    """

    analysis: AnalysisOut
    started: bool
    quota: dict[str, int]


# ======================================================================
# TIN TỨC DẪN NGUỒN
# ======================================================================
class NewsItemOut(ORMModel):
    id: int
    title: str
    summary: str | None = None
    url: str
    image_url: str | None = None
    source_name: str | None = None
    published_at: datetime | None = None
    is_active: bool = True
    sort_order: int = 0
    click_count: int = 0
    created_at: datetime
    #: Có giá trị nghĩa là tin do job kéo về; NULL là nhân viên nhập tay.
    source_id: int | None = None


class NewsSourceOut(ORMModel):
    id: int
    name: str
    url: str
    is_active: bool = True
    max_items: int = 10
    #: PENDING | RUNNING | SUCCESS | PARTIAL | FAILED. Hai giá trị đầu nghĩa là đang chạy dở.
    last_status: str | None = None
    last_error: str | None = None
    #: Các nguồn cùng một lượt chạy có cùng mốc này — giao diện dựa vào đó để gom thành một mẻ.
    last_started_at: datetime | None = None
    last_fetched_at: datetime | None = None
    last_added: int = 0
    item_count: int = 0
    created_at: datetime


class NewsSourceRequest(BaseModel):
    """Một trang nguồn để job dò bài mới."""

    name: str = Field(min_length=2, max_length=120)
    url: str = Field(min_length=8, max_length=1000)
    is_active: bool = True
    #: Trần số bài mỗi lượt. Trên 50 thì một lượt chạy đủ chậm để trang nguồn coi là quét phá.
    max_items: int = Field(default=10, ge=1, le=50)

    @field_validator("url")
    @classmethod
    def _http_only(cls, v: str) -> str:
        url = (v or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            raise ValueError("Đường dẫn phải bắt đầu bằng http:// hoặc https://")
        return url


class NewsItemRequest(BaseModel):
    """Nhập tay một tin. Chỉ bốn thứ cần thiết: tiêu đề, mô tả ngắn, ngày đăng, đường dẫn."""

    title: str = Field(min_length=3, max_length=255)
    summary: str | None = Field(default=None, max_length=2000)
    url: str = Field(min_length=8, max_length=1000)
    source_name: str | None = Field(default=None, max_length=120)
    published_at: datetime | None = None
    is_active: bool = True
    sort_order: int = 0

    @field_validator("url")
    @classmethod
    def _http_only(cls, v: str) -> str:
        """Chặn `javascript:` và `data:` ngay tại cửa.

        Giá trị này đi thẳng vào thuộc tính `href` trên site khách. Chỉ lọc ở giao diện thì ai
        gọi thẳng API vẫn ghi được một liên kết chạy mã cho mọi khách hàng bấm vào.
        """
        url = (v or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            raise ValueError("Đường dẫn phải bắt đầu bằng http:// hoặc https://")
        return url
