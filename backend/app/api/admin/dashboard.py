"""Dashboard quản trị — mục 3.1."""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import case, func, select

from app.core.constants import (
    ArticleStatus,
    ComplianceStatus,
    PaymentStatus,
    SubscriptionStatus,
    SyncJobStatus,
    SyncJobType,
)
from app.core.datetime_utils import local_today, utcnow
from app.core.deps import DbSession, require_permission
from app.models.content import Article, Document
from app.models.nav import SyncJob
from app.models.staff import Staff
from app.models.user import LoginLog, Package, Subscription, User
from app.schemas.domain import DashboardStats, SyncJobOut

router = APIRouter(tags=["admin-dashboard"])

CanView = Annotated[Staff, Depends(require_permission("dashboard.view"))]


@router.get("/dashboard", response_model=DashboardStats)
def dashboard(staff: CanView, db: DbSession) -> DashboardStats:
    now = utcnow()
    today = local_today()

    # ---------- Nhóm chỉ số tài khoản ----------
    status_counts = dict(
        db.execute(
            select(User.subscription_status, func.count())
            .where(User.deleted_at.is_(None))
            .group_by(User.subscription_status)
        ).all()
    )
    compliance_counts = dict(
        db.execute(
            select(User.compliance_status, func.count())
            .where(User.deleted_at.is_(None))
            .group_by(User.compliance_status)
        ).all()
    )

    def _new_since(days: int) -> int:
        return int(
            db.scalar(
                select(func.count())
                .select_from(User)
                .where(User.deleted_at.is_(None), User.created_at >= now - timedelta(days=days))
            ) or 0
        )

    total_users = int(
        db.scalar(select(func.count()).select_from(User).where(User.deleted_at.is_(None))) or 0
    )

    # Tỷ lệ chuyển đổi Trial → Trả phí — chỉ số quan trọng nhất của mô hình này.
    ever_trialed = int(
        db.scalar(
            select(func.count()).select_from(User)
            .where(User.deleted_at.is_(None), User.trial_used.is_(True))
        ) or 0
    )
    converted = int(
        db.scalar(
            select(func.count(func.distinct(Subscription.user_id)))
            .join(Package, Package.id == Subscription.package_id)
            .where(
                Package.is_trial.is_(False),
                Subscription.payment_status == PaymentStatus.PAID,
            )
        ) or 0
    )

    def _expiring_within(days: int) -> int:
        return int(
            db.scalar(
                select(func.count())
                .select_from(Subscription)
                .join(User, User.current_subscription_id == Subscription.id)
                .where(
                    User.deleted_at.is_(None),
                    Subscription.expires_at.between(now, now + timedelta(days=days)),
                )
            ) or 0
        )

    accounts = {
        "total": total_users,
        "trial": status_counts.get(SubscriptionStatus.TRIAL, 0),
        "active": status_counts.get(SubscriptionStatus.ACTIVE, 0),
        "grace": status_counts.get(SubscriptionStatus.GRACE, 0),
        "expired": status_counts.get(SubscriptionStatus.EXPIRED, 0),
        "trial_expired": status_counts.get(SubscriptionStatus.TRIAL_EXPIRED, 0),
        "pending_verify": status_counts.get(SubscriptionStatus.PENDING_VERIFY, 0),
        "warning": compliance_counts.get(ComplianceStatus.WARNING, 0),
        "suspended": compliance_counts.get(ComplianceStatus.SUSPENDED, 0),
        "closed": compliance_counts.get(ComplianceStatus.CLOSED, 0),
        "pending_link": compliance_counts.get(ComplianceStatus.PENDING_LINK, 0),
        "new_today": _new_since(1),
        "new_7d": _new_since(7),
        "new_30d": _new_since(30),
        "trial_conversion_rate": round(converted / ever_trialed * 100, 2) if ever_trialed else None,
        "trial_conversion_detail": {"trialed": ever_trialed, "converted": converted},
        "expiring_7d": _expiring_within(7),
        "expiring_15d": _expiring_within(15),
        "expiring_30d": _expiring_within(30),
    }

    # ---------- Nhóm chỉ số doanh thu ----------
    revenue_rows = db.execute(
        select(
            func.date_format(Subscription.paid_at, "%Y-%m").label("month")
            if db.bind.dialect.name == "mysql"
            else func.strftime("%Y-%m", Subscription.paid_at).label("month"),
            Package.name,
            func.sum(Subscription.amount),
            func.count(),
        )
        .join(Package, Package.id == Subscription.package_id)
        .where(
            Subscription.payment_status == PaymentStatus.PAID,
            Subscription.paid_at.is_not(None),
            Subscription.paid_at >= now - timedelta(days=365),
        )
        .group_by("month", Package.name)
        .order_by("month")
    ).all()

    by_month: dict[str, dict] = {}
    for month, package_name, amount, count in revenue_rows:
        entry = by_month.setdefault(month, {"month": month, "total": 0.0, "packages": {}})
        entry["total"] += float(amount or 0)
        entry["packages"][package_name] = {"amount": float(amount or 0), "count": int(count)}

    # Tỷ lệ gia hạn: số KH có từ 2 gói trả phí trở lên.
    renewers = db.scalar(
        select(func.count()).select_from(
            select(Subscription.user_id)
            .join(Package, Package.id == Subscription.package_id)
            .where(
                Package.is_trial.is_(False),
                Subscription.payment_status == PaymentStatus.PAID,
            )
            .group_by(Subscription.user_id)
            .having(func.count() > 1)
            .subquery()
        )
    ) or 0

    revenue = {
        "by_month": list(by_month.values()),
        "renewal_rate": round(int(renewers) / converted * 100, 2) if converted else None,
        "paying_customers": converted,
        "renewed_customers": int(renewers),
    }

    # ---------- Nhóm chỉ số compliance ----------
    nav_agg = db.execute(
        select(func.sum(User.latest_nav), func.avg(User.latest_nav), func.count(User.latest_nav))
        .where(User.deleted_at.is_(None), User.latest_nav.is_not(None))
    ).one()

    compliance = {
        "total_nav": float(nav_agg[0] or 0),
        "avg_nav": float(nav_agg[1] or 0),
        "accounts_with_nav": int(nav_agg[2] or 0),
        "warning_count": compliance_counts.get(ComplianceStatus.WARNING, 0),
        "suspended_count": compliance_counts.get(ComplianceStatus.SUSPENDED, 0),
    }

    # ---------- Nhóm nội dung ----------
    top_articles = db.execute(
        select(Article.id, Article.title, Article.view_count)
        .where(Article.status == ArticleStatus.PUBLISHED)
        .order_by(Article.view_count.desc())
        .limit(5)
    ).all()

    content = {
        "articles_published": int(
            db.scalar(
                select(func.count()).select_from(Article)
                .where(Article.status == ArticleStatus.PUBLISHED)
            ) or 0
        ),
        "articles_pending_review": int(
            db.scalar(
                select(func.count()).select_from(Article)
                .where(Article.status == ArticleStatus.PENDING_REVIEW)
            ) or 0
        ),
        "documents": int(
            db.scalar(
                select(func.count()).select_from(Document).where(Document.is_active.is_(True))
            ) or 0
        ),
        "top_articles": [
            {"id": a, "title": t, "view_count": v} for a, t, v in top_articles
        ],
    }

    # ---------- Trạng thái job đồng bộ lần cuối ----------
    last_sync = db.scalar(
        select(SyncJob)
        .where(SyncJob.job_type == SyncJobType.SYNC_NAV)
        .order_by(SyncJob.id.desc())
    )
    last_sync_info = (
        SyncJobOut.model_validate(last_sync).model_dump() if last_sync else None
    )

    # ---------- Cờ đỏ cần chú ý ----------
    alerts: list[dict] = []
    if last_sync and last_sync.status == SyncJobStatus.FAILED:
        alerts.append({
            "level": "danger",
            "message": f"Job đồng bộ NAV ngày {last_sync.run_date} thất bại: {last_sync.error_message}",
            "action": "/admin/sync",
        })
    if last_sync and last_sync.run_date < today:
        alerts.append({
            "level": "warning",
            "message": f"Chưa có dữ liệu NAV cho hôm nay (lần cuối: {last_sync.run_date})",
            "action": "/admin/sync",
        })
    if not last_sync:
        alerts.append({
            "level": "warning",
            "message": "Chưa từng chạy job đồng bộ NAV. Kiểm tra cấu hình Google Sheet.",
            "action": "/admin/sync",
        })

    # BR-111 — cờ đỏ nghi ngờ chia sẻ tài khoản.
    device_alerts = int(
        db.scalar(
            select(func.count(func.distinct(LoginLog.user_id)))
            .where(LoginLog.result == "DEVICE_ALERT", LoginLog.created_at >= now - timedelta(days=30))
        ) or 0
    )
    if device_alerts:
        alerts.append({
            "level": "warning",
            "message": f"{device_alerts} tài khoản đăng nhập từ nhiều thiết bị bất thường (nghi chia sẻ tài khoản)",
            "action": "/admin/customers?flag=device",
        })

    unmatched = int(
        db.scalar(
            select(func.sum(SyncJob.rows_unmatched)).where(
                SyncJob.job_type == SyncJobType.SYNC_NAV, SyncJob.run_date == today
            )
        ) or 0
    )
    if unmatched:
        alerts.append({
            "level": "info",
            "message": f"{unmatched} dòng trong Google Sheet chưa khớp tài khoản nào",
            "action": "/admin/sync/unmatched",
        })

    return DashboardStats(
        accounts=accounts,
        revenue=revenue,
        compliance=compliance,
        content=content,
        last_sync=last_sync_info,
        alerts=alerts,
    )
