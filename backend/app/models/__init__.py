"""Gom toàn bộ model để Alembic autogenerate nhìn thấy đủ bảng."""

from app.models.analysis import AnalysisQuotaUsage, SymbolAnalysis, SymbolAnalysisSetup
from app.models.base import Base
from app.models.content import (
    Article,
    ArticleVersion,
    ArticleView,
    Category,
    Document,
    DocumentDownload,
)
from app.models.market import (
    CorporateAction,
    MarketSyncLog,
    OhlcvDaily,
    Symbol,
)
from app.models.media import MediaAsset
from app.models.news import NewsItem
from app.models.nav import (
    ComplianceEvent,
    NavDaily,
    SyncJob,
    SyncUnmatched,
    TradingCalendar,
)
from app.models.notification import (
    LegalDocument,
    Notification,
    NotificationPreference,
    NotificationTemplate,
    UserConsent,
)
from app.models.setting import AppSetting
from app.models.staff import (
    AuditLog,
    Permission,
    Role,
    RolePermission,
    Staff,
    StaffNotification,
    StaffRole,
    StaffSession,
)
from app.models.strategy import (
    Signal,
    Strategy,
    StrategyFaq,
    StrategyKbDoc,
    StrategyQuestion,
    StrategyShare,
    StrategyStat,
    StrategySymbol,
)
from app.models.telegram import (
    AlertDelivery,
    StrategyAlert,
    TelegramConnection,
    TelegramDailyCounter,
)
from app.models.user import (
    CustomerNote,
    EmailVerification,
    LoginLog,
    Package,
    PasswordReset,
    Subscription,
    TrialAbuseLog,
    User,
    UserSession,
)

__all__ = [
    "Base",
    # users
    "User", "Package", "Subscription", "EmailVerification", "PasswordReset",
    "UserSession", "LoginLog", "CustomerNote", "TrialAbuseLog",
    # nav
    "NavDaily", "SyncJob", "SyncUnmatched", "ComplianceEvent", "TradingCalendar",
    # market data
    "Symbol", "OhlcvDaily", "CorporateAction", "MarketSyncLog",
    "MediaAsset",
    # staff
    "Staff", "Role", "Permission", "RolePermission", "StaffRole", "StaffSession",
    "AuditLog", "StaffNotification", "AppSetting",
    # content
    "Category", "Article", "ArticleVersion", "Document", "DocumentDownload", "ArticleView",
    # strategy
    "Strategy", "StrategySymbol", "Signal", "StrategyStat", "StrategyShare",
    "StrategyQuestion", "StrategyFaq", "StrategyKbDoc",
    # phân tích theo yêu cầu
    "SymbolAnalysis", "SymbolAnalysisSetup", "AnalysisQuotaUsage",
    # tin tức dẫn nguồn
    "NewsItem",
    # telegram
    "TelegramConnection", "StrategyAlert", "AlertDelivery", "TelegramDailyCounter",
    # notification & legal
    "NotificationTemplate", "Notification", "NotificationPreference",
    "LegalDocument", "UserConsent",
]
