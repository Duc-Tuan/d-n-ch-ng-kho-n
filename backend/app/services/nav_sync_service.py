"""Đồng bộ NAV từ Google Sheet — mục 2.7.

BR-401: dùng Google Sheets API với Service Account, KHÔNG dùng link chia sẻ công khai —
dữ liệu NAV là dữ liệu tài chính cá nhân.

BR-301 (nguyên tắc an toàn tuyệt đối): *Không có dữ liệu ≠ vi phạm.* Nếu sheet lỗi,
sai định dạng hoặc thiếu KH, job phải **dừng và báo lỗi**, tuyệt đối không khoá tài khoản.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.constants import SyncJobStatus, SyncJobType
from app.core.datetime_utils import local_today, utcnow
from app.models.nav import NavDaily, SyncJob, SyncUnmatched, TradingCalendar
from app.models.user import User
from app.services import notification_service

log = logging.getLogger(__name__)

SHEET_COLUMNS = ("email", "so_tai_khoan", "ho_ten", "nav", "ngay_giao_dich_gan_nhat",
                 "so_lenh_30_ngay", "ngay_cap_nhat")


class SyncAborted(Exception):
    """Lỗi khiến job phải dừng và KHÔNG ghi gì (BR-403)."""


@dataclass(slots=True)
class SheetRow:
    row_number: int
    email: str
    account_no: str
    full_name: str | None
    nav: Decimal
    last_trade_date: date | None
    order_count_30d: int | None
    updated_date: date | None


@dataclass(slots=True)
class SyncResult:
    rows_read: int = 0
    rows_matched: int = 0
    rows_unmatched: int = 0
    rows_written: int = 0
    invalid_rows: list[dict] = field(default_factory=list)
    stale_data: bool = False


# ======================================================================
# Lịch giao dịch — BR-402
# ======================================================================
def is_trading_day(db: Session, day: date | None = None) -> bool:
    """Ngày nghỉ/lễ/cuối tuần thì bỏ qua, không chạy.

    Nếu chưa có bản ghi trong `trading_calendar`, mặc định thứ 2–6 là ngày giao dịch.
    """
    day = day or local_today()
    row = db.get(TradingCalendar, day)
    if row is not None:
        return row.is_trading_day
    return day.weekday() < 5


# ======================================================================
# Đọc Google Sheet
# ======================================================================
def fetch_sheet_rows(db: Session | None = None) -> list[list[str]]:
    """Đọc dữ liệu thô. Ném exception để tầng gọi xử lý retry (BR-405).

    Cấu hình lấy từ bảng `app_settings` trước, không có mới lấy từ `.env` — để người vận hành
    đổi được ID sheet từ giao diện mà không cần truy cập máy chủ.
    """
    from app.core.database import SessionLocal
    from app.services import settings_service

    owns_session = db is None
    db = db or SessionLocal()
    try:
        sheet_id = settings_service.get_setting(db, "google_sheet_id")
        sheet_range = settings_service.get_setting(db, "google_sheet_range") or settings.google_sheet_range
        account_file = (
            settings_service.get_setting(db, "google_service_account_file")
            or settings.google_service_account_file
        )
    finally:
        if owns_session:
            db.close()

    if not sheet_id:
        raise SyncAborted(
            "Chưa cấu hình ID Google Sheet. Đặt ở Quản trị → Cấu hình hệ thống, "
            "hoặc GOOGLE_SHEET_ID trong .env. Job dừng, không ghi dữ liệu (BR-301)."
        )

    from google.oauth2 import service_account  # import trễ để không bắt buộc khi chạy test
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(
        account_file,
        scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
    )
    service = build("sheets", "v4", credentials=creds, cache_discovery=False)
    response = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range=sheet_range)
        .execute()
    )
    return response.get("values", [])


def fetch_sheet_rows_with_retry(db: Session | None = None) -> list[list[str]]:
    """BR-405 — thử lại 3 lần cách nhau 5 phút; vẫn lỗi thì cảnh báo admin và đánh dấu FAILED."""
    last_error: Exception | None = None
    for attempt in range(1, settings.nav_sync_retry + 1):
        try:
            return fetch_sheet_rows(db)
        except SyncAborted:
            raise
        except Exception as exc:
            last_error = exc
            log.warning("Đọc Google Sheet lỗi (lần %s/%s): %s", attempt, settings.nav_sync_retry, exc)
            if attempt < settings.nav_sync_retry:
                time.sleep(settings.nav_sync_retry_delay_seconds)
    raise SyncAborted(f"Không đọc được Google Sheet sau {settings.nav_sync_retry} lần thử: {last_error}")


# ======================================================================
# Parse & validate — BR-400, BR-403
# ======================================================================
def _parse_decimal(raw: str) -> Decimal:
    cleaned = str(raw).strip().replace(",", "").replace(" ", "").replace("₫", "")
    if not cleaned:
        raise ValueError("giá trị rỗng")
    try:
        return Decimal(cleaned)
    except InvalidOperation as exc:
        raise ValueError(f"không phải số: {raw!r}") from exc


def _parse_date(raw: str) -> date | None:
    text = str(raw).strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"ngày không đúng định dạng: {raw!r}")


def parse_rows(raw_rows: list[list[str]]) -> tuple[list[SheetRow], list[dict]]:
    """Tách dòng hợp lệ và dòng lỗi. Dòng lỗi không làm hỏng cả job nhưng phải báo cho admin."""
    valid: list[SheetRow] = []
    invalid: list[dict] = []

    for idx, raw in enumerate(raw_rows, start=2):  # dòng 1 là tiêu đề
        cells = list(raw) + [""] * (7 - len(raw))
        email = str(cells[0]).strip().lower()
        account_no = str(cells[1]).strip()

        if not email and not account_no:
            continue  # dòng trống ở cuối sheet

        try:
            if not email:
                raise ValueError("thiếu email (khoá đối chiếu)")
            if not account_no:
                raise ValueError("thiếu số tài khoản")

            nav = _parse_decimal(cells[3])
            if nav < 0:  # BR-403.4
                raise ValueError("NAV âm")

            valid.append(
                SheetRow(
                    row_number=idx,
                    email=email,
                    account_no=account_no,
                    full_name=str(cells[2]).strip() or None,
                    nav=nav,
                    last_trade_date=_parse_date(cells[4]),
                    order_count_30d=int(cells[5]) if str(cells[5]).strip().isdigit() else None,
                    updated_date=_parse_date(cells[6]),
                )
            )
        except (ValueError, TypeError) as exc:
            invalid.append({"row": idx, "email": email, "error": str(exc)})

    return valid, invalid


def validate_before_write(db: Session, rows: list[SheetRow], run_date: date) -> bool:
    """BR-403 — validate trước khi ghi. Trả về `stale_data` (dữ liệu cũ hay không).

    Ném `SyncAborted` cho các lỗi nghiêm trọng: **dừng, báo lỗi, không ghi gì**.
    """
    # 1. Sheet phải có ≥ 1 dòng dữ liệu.
    if not rows:
        raise SyncAborted("Sheet không có dòng dữ liệu hợp lệ nào. Dừng job, không ghi gì (BR-403.1).")

    # 2. Số dòng hôm nay không được giảm quá 20% so với lần đồng bộ gần nhất.
    from app.services import settings_service

    max_drop = settings_service.get_int(
        db, "nav_sync_max_row_drop_pct", settings.nav_sync_max_row_drop_pct
    )
    previous = db.scalar(
        select(SyncJob)
        .where(
            SyncJob.job_type == SyncJobType.SYNC_NAV,
            SyncJob.status == SyncJobStatus.SUCCESS,
            SyncJob.run_date < run_date,
        )
        .order_by(SyncJob.run_date.desc())
    )
    if previous and previous.rows_read:
        drop_pct = (previous.rows_read - len(rows)) / previous.rows_read * 100
        if drop_pct > max_drop:
            raise SyncAborted(
                f"Số dòng giảm {drop_pct:.1f}% so với lần đồng bộ ngày {previous.run_date} "
                f"({previous.rows_read} → {len(rows)}). Nghi ngờ sheet bị xoá nhầm. "
                "Dừng job, không ghi gì (BR-403.2)."
            )

    # 3. `ngay_cap_nhat` phải là hôm nay; nếu là dữ liệu cũ thì cảnh báo và KHÔNG dùng xét compliance.
    dates = {r.updated_date for r in rows if r.updated_date}
    stale = bool(dates) and run_date not in dates
    if not dates:
        stale = True
    return stale


# ======================================================================
# Ghi dữ liệu
# ======================================================================
def write_rows(db: Session, job: SyncJob, rows: list[SheetRow], run_date: date) -> SyncResult:
    """BR-404 — ghi vào `nav_daily` (một dòng/user/ngày), không ghi đè lịch sử."""
    result = SyncResult(rows_read=len(rows))

    emails = [r.email for r in rows]
    users = db.scalars(select(User).where(User.email.in_(emails), User.deleted_at.is_(None))).all()
    by_email = {u.email: u for u in users}

    existing = {
        row[0]
        for row in db.execute(
            select(NavDaily.user_id).where(NavDaily.trade_date == run_date)
        ).all()
    }

    for row in rows:
        user = by_email.get(row.email)
        if not user:
            # BR-403.5 — không bỏ qua âm thầm.
            result.rows_unmatched += 1
            db.add(
                SyncUnmatched(
                    sync_job_id=job.id,
                    email_in_sheet=row.email,
                    account_no=row.account_no,
                    nav=row.nav,
                    row_number=row.row_number,
                    note="Email trong sheet không khớp tài khoản nào trong hệ thống",
                )
            )
            continue

        result.rows_matched += 1
        if user.id in existing:
            record = db.scalar(
                select(NavDaily).where(NavDaily.user_id == user.id, NavDaily.trade_date == run_date)
            )
            record.nav = row.nav
            record.last_trade_date = row.last_trade_date
            record.order_count_30d = row.order_count_30d
            record.account_no = row.account_no
            record.sync_job_id = job.id
        else:
            db.add(
                NavDaily(
                    user_id=user.id,
                    trade_date=run_date,
                    nav=row.nav,
                    last_trade_date=row.last_trade_date,
                    order_count_30d=row.order_count_30d,
                    account_no=row.account_no,
                    sync_job_id=job.id,
                )
            )
        result.rows_written += 1

        # Bản sao tiện tra cứu trên màn danh sách KH — lịch sử vẫn nằm ở `nav_daily`.
        user.latest_nav = row.nav
        user.latest_nav_date = run_date
        user.last_trade_date = row.last_trade_date

    db.flush()
    return result


# ======================================================================
# Điểm vào của job
# ======================================================================
def run_sync_nav(db: Session, *, run_date: date | None = None, triggered_by: str = "scheduler",
                 force: bool = False) -> SyncJob:
    """Job `sync_nav` — 15:15 ngày giao dịch."""
    run_date = run_date or local_today()

    job = SyncJob(
        job_type=SyncJobType.SYNC_NAV,
        run_date=run_date,
        status=SyncJobStatus.RUNNING,
        started_at=utcnow(),
        triggered_by=triggered_by,
    )
    db.add(job)
    db.flush()

    if not force and not is_trading_day(db, run_date):
        job.status = SyncJobStatus.SKIPPED
        job.error_message = "Không phải ngày giao dịch (BR-402)"
        job.finished_at = utcnow()
        db.commit()
        return job

    try:
        raw_rows = fetch_sheet_rows_with_retry(db)
        rows, invalid = parse_rows(raw_rows)
        stale = validate_before_write(db, rows, run_date)

        result = write_rows(db, job, rows, run_date)
        result.invalid_rows = invalid
        result.stale_data = stale

        job.rows_read = result.rows_read
        job.rows_matched = result.rows_matched
        job.rows_unmatched = result.rows_unmatched
        job.rows_written = result.rows_written
        job.summary = {
            "invalid_rows": invalid[:50],
            "invalid_count": len(invalid),
            "stale_data": stale,
        }
        # Dữ liệu cũ → PARTIAL: job compliance sẽ KHÔNG chạy (BR-403.3).
        job.status = SyncJobStatus.PARTIAL if (stale or invalid) else SyncJobStatus.SUCCESS
        job.finished_at = utcnow()
        db.commit()

        if stale:
            notification_service.notify_admins(
                "Đồng bộ NAV dùng dữ liệu cũ",
                f"Ngày chạy {run_date}: cột ngay_cap_nhat trong sheet không phải hôm nay. "
                "Dữ liệu đã ghi nhưng KHÔNG được dùng để xét compliance (BR-403.3).",
            )
        if invalid:
            notification_service.notify_admins(
                f"Đồng bộ NAV: {len(invalid)} dòng lỗi định dạng",
                "\n".join(f"Dòng {i['row']} ({i['email']}): {i['error']}" for i in invalid[:30]),
            )
        if result.rows_unmatched:
            notification_service.notify_admins(
                f"Đồng bộ NAV: {result.rows_unmatched} email không khớp tài khoản",
                "Xem chi tiết tại Admin Site → Đồng bộ dữ liệu → Dòng chưa khớp.",
            )
        return job

    except SyncAborted as exc:
        db.rollback()
        job = db.get(SyncJob, job.id)
        job.status = SyncJobStatus.FAILED
        job.error_message = str(exc)
        job.finished_at = utcnow()
        db.commit()
        notification_service.notify_admins(
            f"Job sync_nav THẤT BẠI ngày {run_date}",
            f"{exc}\n\nJob compliance hôm nay sẽ KHÔNG chạy (BR-301). "
            "Không có tài khoản nào bị thay đổi trạng thái.",
        )
        return job

    except Exception as exc:  # lỗi ngoài dự kiến — vẫn phải báo, tuyệt đối không nuốt
        db.rollback()
        log.exception("sync_nav lỗi không mong đợi")
        job = db.get(SyncJob, job.id)
        job.status = SyncJobStatus.FAILED
        job.error_message = f"{type(exc).__name__}: {exc}"
        job.finished_at = utcnow()
        db.commit()
        notification_service.notify_admins(
            f"Job sync_nav LỖI ngày {run_date}", f"{type(exc).__name__}: {exc}"
        )
        return job


def get_last_sync_job(db: Session, job_type: str = SyncJobType.SYNC_NAV) -> SyncJob | None:
    return db.scalar(
        select(SyncJob).where(SyncJob.job_type == job_type).order_by(SyncJob.id.desc())
    )


def nav_average(db: Session, user_id: int, window: int | None = None) -> tuple[Decimal | None, int]:
    """BR-300 — NAV trung bình N phiên gần nhất. Trả về (trung bình, số phiên thực có).

    Trả `None` khi không có dữ liệu — tầng gọi phải hiểu đây là "thiếu dữ liệu",
    **không phải** "NAV = 0" (BR-301).
    """
    from app.services import settings_service

    window = window or settings_service.get_int(
        db, "compliance_nav_window", settings.compliance_nav_window
    )
    subq = (
        select(NavDaily.nav)
        .where(NavDaily.user_id == user_id)
        .order_by(NavDaily.trade_date.desc())
        .limit(window)
        .subquery()
    )
    row = db.execute(select(func.avg(subq.c.nav), func.count(subq.c.nav))).one()
    avg, count = row[0], row[1] or 0
    if not count:
        return None, 0
    return Decimal(str(avg)), int(count)
