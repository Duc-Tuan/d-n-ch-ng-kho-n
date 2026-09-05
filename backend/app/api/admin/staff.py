"""Quản lý nhân viên & phân quyền — mục 3.5, và audit log — mục 3.6."""

from __future__ import annotations

from datetime import date, datetime, time
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select

from app.core.constants import StaffStatus
from app.core.deps import (
    CurrentStaff,
    DbSession,
    SuperAdmin,
    client_ip,
    require_permission,
    user_agent,
)
from app.core.exceptions import Conflict, Forbidden, NotFound, ValidationError
from app.core.pagination import PageParams, build_page, page_params, paginate_page
from app.core.security import hash_password, password_policy_errors
from app.models.staff import AuditLog, Role, Staff
from app.schemas.common import IdResponse, Message
from app.schemas.domain import (
    AuditLogOut,
    RoleOut,
    StaffCreateRequest,
    StaffListItem,
    StaffUpdateRequest,
)
from app.services import rbac
from app.services.audit_service import AuditAction, diff, log_action

router = APIRouter(tags=["admin-staff"])

Pagination = Annotated[PageParams, Depends(page_params)]
CanViewStaff = Annotated[Staff, Depends(require_permission("staff.view"))]
CanViewAudit = Annotated[Staff, Depends(require_permission("audit.view"))]


def _to_item(staff: Staff) -> StaffListItem:
    # `Staff.roles` là quan hệ tới object Role — schema cần list mã, nên dựng thủ công.
    return StaffListItem(
        id=staff.id, username=staff.username, email=staff.email, full_name=staff.full_name,
        phone=staff.phone, status=staff.status, totp_enabled=staff.totp_enabled,
        last_login_at=staff.last_login_at, roles=[r.code for r in staff.roles],
        created_at=staff.created_at,
    )


# ======================================================================
# NHÂN VIÊN — BR-531 chỉ SUPER_ADMIN tạo/sửa/xoá và gán role
# ======================================================================
@router.get("/staff", response_model=dict)
def list_staff(staff: CanViewStaff, db: DbSession, params: Pagination,
               q: str | None = Query(default=None, max_length=100),
               status: str | None = None) -> dict:
    stmt = select(Staff)
    if q:
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(Staff.username.like(pattern), Staff.email.like(pattern),
                Staff.full_name.like(pattern))
        )
    if status:
        stmt = stmt.where(Staff.status == status)
    stmt = stmt.order_by(Staff.id)

    return paginate_page(db, stmt, params, _to_item)


@router.post("/staff", response_model=IdResponse, status_code=201)
def create_staff(payload: StaffCreateRequest, actor: SuperAdmin, request: Request,
                 db: DbSession) -> IdResponse:
    username = payload.username.strip().lower()
    email = str(payload.email).strip().lower()

    if db.scalar(select(Staff).where(Staff.username == username)):
        raise Conflict("Tên đăng nhập đã tồn tại", "USERNAME_EXISTS")
    if db.scalar(select(Staff).where(Staff.email == email)):
        raise Conflict("Email đã tồn tại", "EMAIL_EXISTS")

    errors = password_policy_errors(payload.password)
    if errors:
        raise ValidationError(errors[0], {"field": "password", "errors": errors})

    roles = list(db.scalars(select(Role).where(Role.code.in_(payload.role_codes))).all())
    if len(roles) != len(set(payload.role_codes)):
        raise ValidationError("Một hoặc nhiều vai trò không tồn tại", {"field": "role_codes"})

    staff = Staff(
        username=username,
        email=email,
        full_name=payload.full_name.strip(),
        phone=payload.phone,
        password_hash=hash_password(payload.password),
        status=StaffStatus.ACTIVE,
        # BR-532 — bắt buộc thiết lập 2FA ở lần đăng nhập đầu tiên.
        totp_enabled=False,
        must_change_password=True,
    )
    staff.roles = roles
    db.add(staff)
    db.flush()

    log_action(
        db, action=AuditAction.STAFF_CREATE, actor=actor, target_type="staff",
        target_id=staff.id,
        new_value={"username": username, "email": email, "roles": payload.role_codes},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return IdResponse(
        id=staff.id,
        message="Đã tạo tài khoản nhân viên. Nhân viên phải đổi mật khẩu và thiết lập 2FA "
                "ở lần đăng nhập đầu tiên.",
    )


@router.put("/staff/{staff_id}", response_model=Message)
def update_staff(staff_id: int, payload: StaffUpdateRequest, actor: SuperAdmin,
                 request: Request, db: DbSession) -> Message:
    """BR-534 — nhân viên nghỉ việc thì đặt `INACTIVE`, **không xoá bản ghi**."""
    target = db.get(Staff, staff_id)
    if not target:
        raise NotFound("Nhân viên không tồn tại")

    before = {
        "email": target.email, "full_name": target.full_name, "phone": target.phone,
        "status": target.status, "roles": [r.code for r in target.roles],
    }

    if payload.email is not None:
        email = str(payload.email).strip().lower()
        existing = db.scalar(select(Staff).where(Staff.email == email, Staff.id != staff_id))
        if existing:
            raise Conflict("Email đã được dùng bởi tài khoản khác", "EMAIL_EXISTS")
        target.email = email
    if payload.full_name is not None:
        target.full_name = payload.full_name.strip()
    if payload.phone is not None:
        target.phone = payload.phone

    if payload.status is not None:
        if target.id == actor.id and payload.status == StaffStatus.INACTIVE:
            raise Forbidden("Không thể tự vô hiệu hoá tài khoản của chính mình", "SELF_DEACTIVATE")
        target.status = payload.status

    role_changed = False
    if payload.role_codes is not None:
        roles = list(db.scalars(select(Role).where(Role.code.in_(payload.role_codes))).all())
        if len(roles) != len(set(payload.role_codes)):
            raise ValidationError("Một hoặc nhiều vai trò không tồn tại", {"field": "role_codes"})
        if target.id == actor.id and rbac.SUPER_ADMIN not in payload.role_codes:
            raise Forbidden(
                "Không thể tự gỡ quyền Quản trị tối cao của chính mình", "SELF_DEMOTE"
            )
        target.roles = roles
        role_changed = True

    after = {
        "email": target.email, "full_name": target.full_name, "phone": target.phone,
        "status": target.status, "roles": [r.code for r in target.roles],
    }
    old_changed, new_changed = diff(before, after)
    if old_changed:
        # Thay đổi phân quyền là nhóm bắt buộc có lý do (mục 3.6).
        action = AuditAction.STAFF_ROLE_CHANGE if role_changed else AuditAction.STAFF_UPDATE
        log_action(
            db, action=action, actor=actor, target_type="staff", target_id=target.id,
            old_value=old_changed, new_value=new_changed,
            reason=payload.reason or ("Cập nhật thông tin nhân viên" if not role_changed else None),
            ip=client_ip(request), user_agent=user_agent(request),
        )
    db.commit()
    return Message(message="Đã cập nhật nhân viên")


@router.get("/roles", response_model=list[RoleOut])
def list_roles(staff: CanViewStaff, db: DbSession) -> list[RoleOut]:
    roles = db.scalars(select(Role).order_by(Role.id)).all()
    return [
        RoleOut(
            id=r.id, code=r.code, name=r.name, description=r.description,
            is_system=r.is_system,
            permissions=(
                sorted(rbac.PERMISSION_CODES) if r.code == rbac.SUPER_ADMIN
                else sorted(p.code for p in r.permissions)
            ),
        )
        for r in roles
    ]


@router.get("/permissions", response_model=list[dict])
def list_permissions(staff: CanViewStaff) -> list[dict]:
    """Ma trận quyền để dựng màn phân quyền (mục 3.5)."""
    return [
        {"code": p.code, "name": p.name, "module": p.module} for p in rbac.PERMISSIONS
    ]


@router.put("/roles/{role_id}/permissions", response_model=Message)
def update_role_permissions(role_id: int, permission_codes: list[str], reason: str,
                            actor: SuperAdmin, request: Request, db: DbSession) -> Message:
    from app.models.staff import Permission

    role = db.get(Role, role_id)
    if not role:
        raise NotFound("Vai trò không tồn tại")
    if role.code == rbac.SUPER_ADMIN:
        raise Forbidden(
            "Không thể thay đổi quyền của vai trò Quản trị tối cao", "SUPER_ADMIN_IMMUTABLE"
        )

    invalid = set(permission_codes) - rbac.PERMISSION_CODES
    if invalid:
        raise ValidationError(
            f"Quyền không hợp lệ: {', '.join(sorted(invalid))}", {"field": "permission_codes"}
        )

    before = sorted(p.code for p in role.permissions)
    role.permissions = list(
        db.scalars(select(Permission).where(Permission.code.in_(permission_codes))).all()
    )

    log_action(
        db, action=AuditAction.ROLE_UPDATE, actor=actor, target_type="role", target_id=role.id,
        old_value={"permissions": before}, new_value={"permissions": sorted(permission_codes)},
        reason=reason, ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(message=f"Đã cập nhật quyền cho vai trò {role.name}")


# ======================================================================
# AUDIT LOG — mục 3.6
# ======================================================================
@router.get("/audit-logs", response_model=dict)
def list_audit_logs(
    staff: CanViewAudit,
    db: DbSession,
    params: Pagination,
    action: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    actor_id: int | None = None,
    q: str | None = Query(default=None, max_length=100),
    date_from: date | None = None,
    date_to: date | None = None,
) -> dict:
    """Nhật ký lớn rất nhanh: mỗi thao tác của mọi nhân viên là một dòng.

    Vì vậy màn này cần tìm kiếm và lọc theo khoảng ngày, không chỉ phân trang — cuộn tay qua vài
    nghìn dòng để tìm một thao tác là không dùng được khi có sự cố cần đối soát.
    """
    stmt = select(AuditLog)
    if q:
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                AuditLog.actor_name.like(pattern),
                AuditLog.reason.like(pattern),
                AuditLog.target_id.like(pattern),
                AuditLog.ip.like(pattern),
            )
        )
    if date_from:
        stmt = stmt.where(AuditLog.created_at >= datetime.combine(date_from, time.min))
    if date_to:
        # Bao trọn ngày kết thúc: người dùng chọn "đến 05/08" là kỳ vọng gồm cả ngày 05/08.
        stmt = stmt.where(AuditLog.created_at <= datetime.combine(date_to, time.max))
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if target_type:
        stmt = stmt.where(AuditLog.target_type == target_type)
    if target_id:
        stmt = stmt.where(AuditLog.target_id == target_id)
    if actor_id:
        stmt = stmt.where(AuditLog.actor_id == actor_id)
    stmt = stmt.order_by(AuditLog.id.desc())

    return paginate_page(db, stmt, params, AuditLogOut.model_validate)


@router.get("/audit-logs/actions", response_model=list[str])
def audit_actions(staff: CanViewAudit, db: DbSession) -> list[str]:
    """Danh sách action đã xuất hiện — dùng làm dropdown lọc."""
    return [row[0] for row in db.execute(select(AuditLog.action).distinct()).all()]
