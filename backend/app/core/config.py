"""Cấu hình ứng dụng — đọc toàn bộ từ biến môi trường / file .env."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ---------- Ứng dụng ----------
    app_name: str = "He thong tu van chung khoan"
    app_env: Literal["development", "staging", "production"] = "development"
    debug: bool = True
    api_prefix: str = "/api/v1"
    timezone: str = "Asia/Ho_Chi_Minh"

    # ---------- MySQL ----------
    db_host: str = "localhost"
    db_port: int = 3306
    db_user: str = "root"
    db_password: str = ""
    db_name: str = "stock_system"
    db_echo: bool = False
    db_pool_size: int = 10
    db_max_overflow: int = 20
    # Cho phép ép URL thẳng (dùng khi chạy test bằng SQLite).
    database_url_override: str | None = None

    # ---------- Bảo mật ----------
    jwt_secret_customer: str = "change-me-customer"
    jwt_secret_staff: str = "change-me-staff"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 30
    refresh_token_days: int = 14
    bcrypt_rounds: int = 12

    cors_origins: str = "http://localhost:3000"

    # ---------- Chính sách tài khoản ----------
    trial_days: int = 7
    grace_days: int = 3
    email_verify_ttl_hours: int = 24
    unverified_purge_days: int = 7
    login_max_attempts: int = 5
    login_lock_minutes: int = 15
    otp_ttl_minutes: int = 10
    otp_max_attempts: int = 5
    otp_request_per_hour: int = 3
    single_session: bool = True
    device_alert_threshold: int = 5
    trial_per_ip_per_day: int = 3
    require_phone_otp: bool = False

    # ---------- Compliance ----------
    compliance_nav_min: int = 100_000_000
    compliance_nav_window: int = 20
    compliance_no_trade_days: int = 90
    compliance_warning_days: int = 7
    ib_link_deadline_days: int = 15

    # ---------- Google Sheet ----------
    google_sheet_id: str = ""
    google_sheet_range: str = "NAV!A2:G"
    google_service_account_file: str = "./secrets/service-account.json"
    nav_sync_max_row_drop_pct: int = 20
    nav_sync_retry: int = 3
    nav_sync_retry_delay_seconds: int = 300

    # ---------- Scheduler ----------
    enable_scheduler: bool = True
    job_sync_nav_cron: str = "15 15 * * *"
    job_check_compliance_cron: str = "30 16 * * *"
    job_check_subscription_cron: str = "5 0 * * *"
    job_notify_expiry_cron: str = "0 9 * * *"
    job_notify_warning_cron: str = "0 9 * * *"
    job_close_signals_cron: str = "0 16 * * *"
    job_cleanup_cron: str = "0 2 * * *"

    # ---------- Email ----------
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from_email: str = "no-reply@localhost"
    smtp_from_name: str = "Stock System"
    smtp_tls: bool = True

    # ---------- SMS ----------
    sms_provider: str = "none"
    sms_api_key: str = ""
    sms_secret: str = ""
    sms_brandname: str = ""
    quiet_hours_start: int = 22
    quiet_hours_end: int = 7

    # ---------- Telegram ----------
    telegram_bot_token: str = ""
    telegram_bot_username: str = ""
    telegram_webhook_secret: str = ""
    telegram_connect_token_ttl_minutes: int = 15
    telegram_max_msg_per_day: int = 10
    telegram_send_rate_per_second: int = 25
    telegram_allow_group_chat: bool = False
    telegram_send_window_start: str = "08:45"
    telegram_send_window_end: str = "15:15"
    telegram_digest_time: str = "16:00"

    # ---------- Dữ liệu thị trường (Phần 12) ----------
    #: BR-830 — đổi nhà cung cấp chỉ cần đổi giá trị này.
    market_data_provider: str = "VNDIRECT"

    #: Nguồn riêng cho **nến trong ngày**. Bỏ trống thì dùng chung `market_data_provider`.
    #:
    #: Tách riêng vì hai loại nến có hai bài toán khác hẳn. Nến ngày cần lịch sử sâu và phải
    #: khớp tuyệt đối với thứ chiến lược đang chạy (VPS đi tới 2000). Nến trong ngày thì nguồn
    #: nào cũng chỉ giữ một cửa sổ gần đây, nhưng cửa sổ rộng hẹp rất khác nhau: đo ngày
    #: 08/09/2026, khung 1 giờ của VPS có ~310 nến (3 tháng) còn Entrade có ~3.720 nến (từ
    #: 2023-09) và liền mạch từng năm.
    #:
    #: Trộn nguồn ở đây **không** vi phạm BR-83x: điều luật đó cấm ghép hai nguồn áp hệ số điều
    #: chỉnh cổ tức khác nhau (VPS và VNDIRECT lệch tới 16% trên cùng một phiên). Entrade đối
    #: chiếu với VPS trên 5 mã × 745 phiên chỉ lệch trung bình 0,03% và tối đa 0,11% — sai số
    #: làm tròn. Và nến ngày vẫn chỉ lấy từ nguồn chính: `ohlcv_bars` chỉ phục vụ biểu đồ, còn
    #: `ohlcv_daily` — thứ chiến lược và backtest đọc — không đổi nguồn.
    #:
    #: Muốn quay lại dùng một nguồn duy nhất thì đặt rỗng.
    market_intraday_provider: str = "ENTRADE"

    market_history_days: int = 730
    market_sync_delay_seconds: float = 0.25

    #: Các khung trong ngày mà job `sync_market` tải về mỗi phiên, ngăn cách bằng dấu phẩy.
    #:
    #: Chỉ liệt kê khung **tự tải về** (1m, 5m, 15m, 30m, 1h) — 3m, 2h và 4h được gộp ra lúc
    #: đọc nên khai báo ở đây cũng không có tác dụng gì. Bỏ trống thì hệ thống quay về đúng
    #: hành vi cũ: chỉ đồng bộ nến ngày.
    #:
    #: Đây là chỗ đánh đổi giữa độ chi tiết và dung lượng: một phiên của 150 mã là ~43.000 nến
    #: 1 phút nhưng chỉ ~750 nến 1 giờ. Danh mục lớn mà máy chủ nhỏ thì bỏ `1m` ra trước tiên.
    market_intraday_timeframes: str = "1m,5m,15m,30m,1h"

    #: Khoảng lịch sử xin cho một cặp (mã, khung) chưa có dữ liệu nào.
    #:
    #: Xin rộng hơn cũng vô ích: nguồn chỉ phục vụ một **cửa sổ trượt** vài trăm nến gần đây và
    #: trả `no_data` cho mọi khoảng trong quá khứ (đã đo). Lịch sử trong ngày chỉ dày lên nhờ
    #: chạy đều đặn, không nạp bù một lần cho xong như nến ngày.
    market_intraday_history_days: int = 60

    #: Dọn nến trong ngày quá hạn trong job `cleanup`. Hạn của từng khung khai báo ở
    #: `market_data.timeframes` (`retention_days`). Tắt thì bảng cứ thế lớn mãi.
    market_bar_retention_enabled: bool = True
    #: 16:00 thứ 2–6 — sau giờ đóng cửa (15:00) và sau khi sở công bố giá cuối phiên.
    #: Job vẫn tự bỏ qua ngày nghỉ lễ theo bảng `trading_calendar`.
    #: Viết `mon-fri` chứ **không** viết `1-5`: APScheduler đánh số 0=thứ 2 (khác cron Unix
    #: 0=chủ nhật), nên `1-5` sẽ thành thứ 3 đến thứ 7 — chạy thừa thứ 7 và bỏ mất thứ 2.
    job_sync_market_cron: str = "0 16 * * mon-fri"

    # ---------- Tin tức dẫn nguồn ----------
    #: Giờ kéo tin mặc định. Đây chỉ là giá trị dự phòng: giờ đang có hiệu lực nằm ở cấu hình
    #: `news_sync_time` sửa được trên giao diện, và `scheduler.reschedule_news_sync()` áp ngay
    #: khi lưu. Chạy hằng ngày kể cả cuối tuần — báo vẫn đăng bài ngày nghỉ.
    job_sync_news_time: str = "04:10"

    # ---------- Phân tích theo yêu cầu (MCP + claude -p) ----------
    #: Claude Code CLI. Phải đăng nhập bằng **chính người dùng hệ điều hành đang chạy backend**:
    #: hồ sơ OAuth lưu theo user, chạy backend dưới service account khác thì `claude -p` không
    #: có thông tin đăng nhập. Không dùng cờ `--bare` — bare mode bỏ qua OAuth và đòi API key,
    #: tức là mất đúng thứ ta muốn giữ (chạy bằng gói thuê bao).
    ai_claude_cli_path: str = "claude"
    ai_mcp_config_path: str = ".claude/mcp-analysis.json"

    ai_candles_per_symbol: int = 300
    #: Một lượt phân tích một mã — ngắn hơn hẳn cả lô 8 mã ngày trước, nhưng vẫn phải đủ chỗ
    #: cho một lượt đọc tài liệu dài.
    ai_analysis_timeout_seconds: int = 600

    #: BR — mỗi tài khoản được bao nhiêu lượt **chạy AI mới** mỗi ngày.
    #:
    #: Đọc lại bản đã có (ai đó phân tích cặp chiến lược+mã đó trước rồi) **không** tính lượt:
    #: nó không tốn gì cả, và trừ lượt ở đó nghĩa là phạt khách vì xem lại kết quả cũ. Chiến
    #: lược loại RULE chạy bằng bộ điều kiện tại chỗ cũng không tính — không có lượt gọi mô hình nào.
    analysis_daily_quota: int = 10

    #: Số lượt `claude -p` chạy song song. Mỗi lượt là một tiến trình thật và ăn hạn mức gói thuê
    #: bao chung, nên để thấp: 20 khách bấm cùng lúc thì xếp hàng, không phải 20 tiến trình.
    analysis_workers: int = 2

    # ---------- Lưu trữ ----------
    storage_dir: str = "./storage/documents"
    max_upload_mb: int = 50
    allowed_upload_ext: str = "pdf,docx,xlsx,pptx,png,jpg,jpeg"
    signed_url_ttl_seconds: int = 300
    pdf_watermark: bool = True

    # ---------- Cảnh báo vận hành ----------
    admin_alert_emails: str = ""
    admin_alert_telegram_chat_id: str = ""

    # ---------- Seed ----------
    seed_super_admin_username: str = "superadmin"
    seed_super_admin_email: str = "admin@localhost"
    seed_super_admin_password: str = "ChangeMe@2026"

    frontend_base_url: str = "http://localhost:3000"

    @field_validator("bcrypt_rounds")
    @classmethod
    def _check_bcrypt(cls, v: int) -> int:
        # BR-2.1: bcrypt cost >= 12
        if v < 12:
            raise ValueError("BCRYPT_ROUNDS phải >= 12 theo yêu cầu bảo mật")
        return v

    # ------------------------------------------------------------------
    @property
    def database_url(self) -> str:
        if self.database_url_override:
            return self.database_url_override
        pwd = self.db_password
        return (
            f"mysql+pymysql://{self.db_user}:{pwd}@{self.db_host}:{self.db_port}/"
            f"{self.db_name}?charset=utf8mb4"
        )

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def allowed_ext_set(self) -> set[str]:
        return {e.strip().lower().lstrip(".") for e in self.allowed_upload_ext.split(",") if e.strip()}

    @property
    def admin_alert_email_list(self) -> list[str]:
        return [e.strip() for e in self.admin_alert_emails.split(",") if e.strip()]

    @property
    def storage_path(self) -> Path:
        p = Path(self.storage_dir)
        return p if p.is_absolute() else (BASE_DIR / p).resolve()

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
