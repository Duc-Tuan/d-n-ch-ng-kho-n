"""Từ điển trạng thái và hằng số nghiệp vụ (Phần 1 của đặc tả)."""

from __future__ import annotations

from enum import StrEnum


# ======================================================================
# TRỤC THỜI HẠN — mục 1.1
# ======================================================================
class SubscriptionStatus(StrEnum):
    PENDING_VERIFY = "PENDING_VERIFY"
    TRIAL = "TRIAL"
    TRIAL_EXPIRED = "TRIAL_EXPIRED"
    ACTIVE = "ACTIVE"
    GRACE = "GRACE"
    EXPIRED = "EXPIRED"


#: Trạng thái gói cho phép sử dụng dịch vụ.
SUBSCRIPTION_ALLOWED = frozenset(
    {SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE, SubscriptionStatus.GRACE}
)


# ======================================================================
# TRỤC CHẤT LƯỢNG TÀI KHOẢN — mục 1.2
# ======================================================================
class ComplianceStatus(StrEnum):
    NOT_REQUIRED = "NOT_REQUIRED"
    PENDING_LINK = "PENDING_LINK"
    OK = "OK"
    WARNING = "WARNING"
    SUSPENDED = "SUSPENDED"
    CLOSED = "CLOSED"


#: Trạng thái compliance chặn đăng nhập (BR-001 — ưu tiên cao nhất).
COMPLIANCE_BLOCKING = frozenset({ComplianceStatus.SUSPENDED, ComplianceStatus.CLOSED})


class CustomerType(StrEnum):
    """Chốt 7.1 — hai tuyến khách hàng."""

    IB_LINKED = "IB_LINKED"   # mở TKCK dưới IB → chịu điều kiện NAV/giao dịch
    PAID_ONLY = "PAID_ONLY"   # trả phí thuần → chỉ chịu trục thời hạn


class IbLinkStatus(StrEnum):
    """BR-202."""

    NONE = "NONE"
    PENDING_LINK = "PENDING_LINK"
    OK = "OK"
    REJECTED = "REJECTED"


# ======================================================================
# LÝ DO CHẶN — BR-112 (thông báo phải nêu đúng lý do + hành động tiếp theo)
# ======================================================================
class BlockReason(StrEnum):
    NONE = "NONE"
    EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED"
    TRIAL_EXPIRED = "TRIAL_EXPIRED"
    SUBSCRIPTION_EXPIRED = "SUBSCRIPTION_EXPIRED"
    COMPLIANCE_NAV = "COMPLIANCE_NAV"
    COMPLIANCE_NO_TRADE = "COMPLIANCE_NO_TRADE"
    COMPLIANCE_IB_LINK = "COMPLIANCE_IB_LINK"
    COMPLIANCE_SUSPENDED = "COMPLIANCE_SUSPENDED"
    ACCOUNT_CLOSED = "ACCOUNT_CLOSED"


class LoginResult(StrEnum):
    SUCCESS = "SUCCESS"
    WRONG_PASS = "WRONG_PASS"
    BLOCKED = "BLOCKED"
    LOCKED = "LOCKED"
    NOT_FOUND = "NOT_FOUND"
    WRONG_2FA = "WRONG_2FA"


class ActorType(StrEnum):
    USER = "USER"
    STAFF = "STAFF"
    SYSTEM = "SYSTEM"


class StaffStatus(StrEnum):
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"


class PaymentStatus(StrEnum):
    PENDING = "PENDING"
    PAID = "PAID"
    FAILED = "FAILED"
    REFUNDED = "REFUNDED"
    CANCELLED = "CANCELLED"


# ======================================================================
# NAV / COMPLIANCE
# ======================================================================
class SyncJobType(StrEnum):
    SYNC_NAV = "sync_nav"
    CHECK_COMPLIANCE = "check_compliance"
    CHECK_SUBSCRIPTION = "check_subscription"
    NOTIFY_EXPIRY = "notify_expiry"
    NOTIFY_WARNING = "notify_warning"
    CLOSE_SIGNALS = "close_signals"
    CLEANUP = "cleanup"
    BACKUP_DB = "backup_db"
    #: Kéo tin từ các trang nguồn đã khai báo — giờ chạy đặt ở màn Cấu hình hệ thống.
    SYNC_NEWS = "sync_news"
    #: Phân tích hằng ngày bằng AI — 16:15 sau khi `sync_market` (16:00) ghi xong nến mới.


class SyncJobStatus(StrEnum):
    RUNNING = "RUNNING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"
    PARTIAL = "PARTIAL"


class ComplianceEventType(StrEnum):
    WARNING = "WARNING"
    SUSPEND = "SUSPEND"
    RESTORE = "RESTORE"
    EXEMPT = "EXEMPT"
    CLOSE = "CLOSE"
    REOPEN = "REOPEN"


# ======================================================================
# NỘI DUNG — mục 3.2 / 3.3
# ======================================================================
class ArticleStatus(StrEnum):
    """BR-500."""

    DRAFT = "DRAFT"
    PENDING_REVIEW = "PENDING_REVIEW"
    PUBLISHED = "PUBLISHED"
    ARCHIVED = "ARCHIVED"


class CategoryType(StrEnum):
    ARTICLE = "ARTICLE"
    DOCUMENT = "DOCUMENT"


# ======================================================================
# CHIẾN LƯỢC & TÍN HIỆU — Phần 13
# ======================================================================
class StrategySchool(StrEnum):
    SMC = "SMC"
    ICT = "ICT"
    PRICE_ACTION = "PRICE_ACTION"
    QUANT = "QUANT"
    INDICATOR = "INDICATOR"


class StrategyKind(StrEnum):
    """Chiến lược được mô tả bằng cái gì — quyết định **cách phân tích**, không chỉ là nhãn.

    RULE     — bộ điều kiện máy chạy được (`rules_json`). Bấm Phân tích thì `strategy_engine`
               chạy tại chỗ: miễn phí, tức thì, không tốn hạn mức AI.
    DOCUMENT — tài liệu PDF tải lên. Bấm Phân tích thì Claude đọc tài liệu + nến qua MCP.

    Hai loại **không trộn nhau**: một chiến lược hoặc chạy bằng điều kiện, hoặc chạy bằng tài
    liệu. Trước đây một chiến lược có thể mang cả hai rồi job tự đoán nhánh — người tạo
    không biết đêm nay máy sẽ chạy cái nào trên chiến lược của mình.
    """

    RULE = "RULE"
    DOCUMENT = "DOCUMENT"


class StrategyOwnerType(StrEnum):
    SYSTEM = "SYSTEM"
    USER = "USER"


class StrategyStatus(StrEnum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    ARCHIVED = "ARCHIVED"


class SignalType(StrEnum):
    """BR-841 — không bao giờ gộp chung khi tính thống kê."""

    LIVE = "LIVE"
    BACKTEST = "BACKTEST"


class SignalDirection(StrEnum):
    BUY = "BUY"
    SELL = "SELL"


class SignalResult(StrEnum):
    OPEN = "OPEN"
    WIN = "WIN"
    LOSS = "LOSS"
    BE = "BE"
    CANCELLED = "CANCELLED"


class SignalExitReason(StrEnum):
    TP = "TP"
    SL = "SL"
    MANUAL = "MANUAL"
    EXPIRE = "EXPIRE"


class AnalysisSource(StrEnum):
    """Ai sinh ra bản phân tích.

    ENGINE — `strategy_engine` chạy tại chỗ từ `rules_json`: miễn phí, tức thì, lặp lại được.
    AI     — Claude đọc tài liệu chiến lược qua MCP rồi viết nhận định.
    Giữ dấu vết này để về sau đối chiếu chất lượng hai nguồn trên cùng một mã.
    """

    ENGINE = "ENGINE"
    AI = "AI"


class AnalysisConfidence(StrEnum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class SymbolAnalysisStatus(StrEnum):
    """Vòng đời một lượt phân tích theo yêu cầu (chiến lược × mã × ngày).

    QUEUED → RUNNING → (DONE | FAILED).

    Ba trạng thái đầu chính là cơ chế chống chạy trùng: người đầu tiên chiếm được dòng
    (QUEUED) thì mới chạy; mọi người bấm sau đọc đúng dòng đó và chờ. Xem
    `services/analysis/ondemand.py::request_analysis`.
    """

    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    DONE = "DONE"
    FAILED = "FAILED"


class KbIndexStatus(StrEnum):
    """Trạng thái bóc chữ tài liệu chiến lược — cột `strategy_kb_docs.index_status`.

    UNSUPPORTED và EMPTY **phải** được liệt kê ra `run.summary`: một chiến lược mất tài liệu
    nền mà không ai biết sẽ cho ra phân tích chung chung, và không có cách nào nhận ra từ kết quả.
    """

    PENDING = "PENDING"
    OK = "OK"
    EMPTY = "EMPTY"
    UNSUPPORTED = "UNSUPPORTED"


class QuestionStatus(StrEnum):
    PENDING = "PENDING"
    ANSWERED = "ANSWERED"
    CLOSED = "CLOSED"


class AnswerType(StrEnum):
    HUMAN = "HUMAN"
    AI = "AI"


# ======================================================================
# TELEGRAM — Phần 15
# ======================================================================
class TelegramStatus(StrEnum):
    PENDING = "PENDING"
    VERIFIED = "VERIFIED"
    BLOCKED = "BLOCKED"
    DISCONNECTED = "DISCONNECTED"


class AlertType(StrEnum):
    """BR-871."""

    ENTRY = "ENTRY"
    TP = "TP"
    SL = "SL"
    CANCELLED = "CANCELLED"
    DIGEST = "DIGEST"


DEFAULT_ALERT_TYPES = [AlertType.ENTRY, AlertType.TP, AlertType.SL, AlertType.CANCELLED]


class AlertInactiveReason(StrEnum):
    """BR-860c."""

    USER = "USER"
    PACKAGE = "PACKAGE"
    SYSTEM_SCOPE_CHANGED = "SYSTEM_SCOPE_CHANGED"


class DeliveryStatus(StrEnum):
    QUEUED = "QUEUED"
    SENT = "SENT"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"


class DeliverySkipReason(StrEnum):
    """BR-883 — luôn ghi lý do, không bỏ qua âm thầm."""

    SUBSCRIPTION_INACTIVE = "SUBSCRIPTION_INACTIVE"
    COMPLIANCE_BLOCKED = "COMPLIANCE_BLOCKED"
    PACKAGE_TOO_LOW = "PACKAGE_TOO_LOW"
    TELEGRAM_NOT_VERIFIED = "TELEGRAM_NOT_VERIFIED"
    DAILY_LIMIT = "DAILY_LIMIT"
    OUTSIDE_WINDOW = "OUTSIDE_WINDOW"
    ALERT_TYPE_DISABLED = "ALERT_TYPE_DISABLED"


# ======================================================================
# THÔNG BÁO — Phần 10
# ======================================================================
class NotificationChannel(StrEnum):
    EMAIL = "EMAIL"
    IN_APP = "IN_APP"
    SMS = "SMS"
    TELEGRAM = "TELEGRAM"
    PUSH = "PUSH"


class NotificationStatus(StrEnum):
    QUEUED = "QUEUED"
    SENT = "SENT"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"


class NotificationCode(StrEnum):
    """Mục 10.2 — danh mục thông báo."""

    VERIFY_EMAIL = "VERIFY_EMAIL"
    WELCOME = "WELCOME"
    TRIAL_D5 = "TRIAL_D5"
    TRIAL_D6 = "TRIAL_D6"
    TRIAL_D7 = "TRIAL_D7"
    TRIAL_EXPIRED = "TRIAL_EXPIRED"
    PAYMENT_SUCCESS = "PAYMENT_SUCCESS"
    IB_LINK_REMINDER = "IB_LINK_REMINDER"
    EXPIRY_T15 = "EXPIRY_T15"
    EXPIRY_T7 = "EXPIRY_T7"
    EXPIRY_T3 = "EXPIRY_T3"
    EXPIRY_T1 = "EXPIRY_T1"
    EXPIRY_T0 = "EXPIRY_T0"
    GRACE_END = "GRACE_END"
    COMPLIANCE_WARNING = "COMPLIANCE_WARNING"
    COMPLIANCE_WARNING_D3 = "COMPLIANCE_WARNING_D3"
    COMPLIANCE_WARNING_D1 = "COMPLIANCE_WARNING_D1"
    COMPLIANCE_SUSPENDED = "COMPLIANCE_SUSPENDED"
    COMPLIANCE_RESTORED = "COMPLIANCE_RESTORED"
    PASSWORD_RESET_OTP = "PASSWORD_RESET_OTP"
    PASSWORD_CHANGED = "PASSWORD_CHANGED"
    NEW_DEVICE_LOGIN = "NEW_DEVICE_LOGIN"
    NEW_ARTICLE = "NEW_ARTICLE"
    NEW_DOCUMENT = "NEW_DOCUMENT"
    NEW_SIGNAL = "NEW_SIGNAL"
    QA_ANSWERED = "QA_ANSWERED"
    ADMIN_BROADCAST = "ADMIN_BROADCAST"
    ACCOUNT_CREATED = "ACCOUNT_CREATED"


#: BR-815 — nhóm giao dịch/bảo mật/compliance KH không được tắt.
OPTIONAL_NOTIFICATION_CODES = frozenset(
    {
        NotificationCode.NEW_ARTICLE,
        NotificationCode.NEW_DOCUMENT,
        NotificationCode.NEW_SIGNAL,
    }
)

#: BR-816 — thông báo bảo mật vẫn gửi trong giờ yên lặng.
SECURITY_NOTIFICATION_CODES = frozenset(
    {
        NotificationCode.NEW_DEVICE_LOGIN,
        NotificationCode.PASSWORD_CHANGED,
        NotificationCode.PASSWORD_RESET_OTP,
    }
)


# ======================================================================
# VĂN BẢN PHÁP LÝ — BR-801
# ======================================================================
class LegalDocType(StrEnum):
    TOS = "TOS"
    PRIVACY = "PRIVACY"
    REFUND = "REFUND"
    DISCLAIMER = "DISCLAIMER"
    COOKIE = "COOKIE"
    NAV_CONSENT = "NAV_CONSENT"      # BR-803
    TELEGRAM_CONSENT = "TELEGRAM_CONSENT"  # BR-879


DISCLAIMER_TEXT = (
    "Thông tin mang tính tham khảo, không phải khuyến nghị mua bán chứng khoán. "
    "Khách hàng tự chịu trách nhiệm với mọi quyết định đầu tư của mình. "
    "Hiệu suất trong quá khứ không đảm bảo kết quả trong tương lai."
)
