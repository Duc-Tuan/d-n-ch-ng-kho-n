"""Chiến lược cá nhân của khách hàng và cơ chế chia sẻ.

Mục 13.1 định nghĩa hai nguồn tạo chiến lược:
  * **Chiến lược hệ thống** — admin/analyst tạo, mọi KH đủ điều kiện gói đều xem được.
  * **Chiến lược cá nhân** — KH tự tạo, **chỉ mình KH đó xem**.

Nguyên tắc cách ly (BR-850): chiến lược cá nhân mặc định không ai khác nhìn thấy. Muốn người
khác dùng được thì chủ sở hữu phải chia sẻ tường minh — và người nhận chỉ được xem, không được
sửa hay chia sẻ tiếp.
"""

from __future__ import annotations

import re
from datetime import datetime

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.constants import StrategyKind, StrategyOwnerType, StrategyStatus
from app.core.datetime_utils import utcnow
from app.core.exceptions import Conflict, Forbidden, NotFound, ValidationError
from app.core.security import generate_url_token
from app.models.content import Category, Document
from app.models.market import Symbol
from app.models.strategy import Strategy, StrategyKbDoc, StrategyShare, StrategySymbol
from app.models.user import User

#: Giới hạn số chiến lược cá nhân mỗi khách hàng — chặn lạm dụng, không phải rào bán hàng.
MAX_STRATEGIES_PER_USER = 30
MAX_SYMBOLS_PER_STRATEGY = 50

#: Toàn hệ thống chạy trên nến ngày — khách không chọn khung thời gian, giống site quản trị.
FIXED_TIMEFRAME = "D1"

#: Tối đa tài liệu cho một chiến lược cá nhân. Bối cảnh nạp cho AI đã có trần 60.000 ký tự
#: (`analysis/documents.py`), nên file thứ muười chỉ chiếm chỗ đĩa mà không bao giờ được đọc.
MAX_DOCS_PER_STRATEGY = 5


# ======================================================================
# Truy vấn có kiểm soát quyền
# ======================================================================
def visible_strategy_ids(db: Session, user: User) -> set[int]:
    """Tập chiến lược cá nhân mà khách hàng này được xem: của mình + được chia sẻ còn hiệu lực."""
    own = {
        row[0]
        for row in db.execute(
            select(Strategy.id).where(
                Strategy.owner_type == StrategyOwnerType.USER, Strategy.owner_id == user.id
            )
        ).all()
    }
    shared = {
        row[0]
        for row in db.execute(
            select(StrategyShare.strategy_id).where(
                StrategyShare.shared_with_user_id == user.id,
                StrategyShare.revoked_at.is_(None),
            )
        ).all()
    }
    return own | shared


def get_for_user(db: Session, user: User, strategy_id: int) -> tuple[Strategy, bool]:
    """Lấy chiến lược cá nhân kèm cờ `is_owner`. Ném lỗi nếu không có quyền xem."""
    strategy = db.get(Strategy, strategy_id)
    if not strategy or strategy.owner_type != StrategyOwnerType.USER:
        raise NotFound("Chiến lược không tồn tại")

    if strategy.owner_id == user.id:
        return strategy, True

    share = db.scalar(
        select(StrategyShare).where(
            StrategyShare.strategy_id == strategy_id,
            StrategyShare.shared_with_user_id == user.id,
            StrategyShare.revoked_at.is_(None),
        )
    )
    if not share:
        # Không tiết lộ chiến lược có tồn tại hay không — cùng nguyên tắc với BR-850.
        raise NotFound("Chiến lược không tồn tại")
    return strategy, False


def list_own(db: Session, user: User) -> list[Strategy]:
    return list(
        db.scalars(
            select(Strategy)
            .where(Strategy.owner_type == StrategyOwnerType.USER, Strategy.owner_id == user.id)
            .order_by(Strategy.id.desc())
        ).all()
    )


def list_shared_with_me(db: Session, user: User) -> list[tuple[Strategy, StrategyShare]]:
    rows = db.execute(
        select(Strategy, StrategyShare)
        .join(StrategyShare, StrategyShare.strategy_id == Strategy.id)
        .where(
            StrategyShare.shared_with_user_id == user.id,
            StrategyShare.revoked_at.is_(None),
        )
        .order_by(StrategyShare.id.desc())
    ).all()
    return [(s, sh) for s, sh in rows]


# ======================================================================
# Tạo và sửa
# ======================================================================
def _generate_code(db: Session, user: User, name: str) -> str:
    """Mã chiến lược phải là duy nhất toàn hệ thống — thêm tiền tố người dùng để tránh đụng."""
    base = re.sub(r"[^A-Z0-9]+", "_", name.upper()).strip("_")[:24] or "CHIEN_LUOC"
    candidate = f"U{user.id}_{base}"
    suffix = 1
    while db.scalar(select(Strategy).where(Strategy.code == candidate)):
        suffix += 1
        candidate = f"U{user.id}_{base}_{suffix}"
    return candidate


def _validate_symbols(db: Session, symbols: list[str]) -> list[str]:
    """Chỉ nhận mã có thật trong danh mục niêm yết — tránh chiến lược trỏ vào mã không tồn tại."""
    cleaned = {s.strip().upper() for s in symbols if s and s.strip()}
    if not cleaned:
        raise ValidationError("Chọn ít nhất một mã cổ phiếu", {"field": "symbols"})
    if len(cleaned) > MAX_SYMBOLS_PER_STRATEGY:
        raise ValidationError(
            f"Mỗi chiến lược tối đa {MAX_SYMBOLS_PER_STRATEGY} mã", {"field": "symbols"}
        )

    known = {
        row[0]
        for row in db.execute(
            select(Symbol.symbol).where(Symbol.symbol.in_(cleaned), Symbol.is_active.is_(True))
        ).all()
    }
    unknown = cleaned - known
    if unknown:
        raise ValidationError(
            f"Mã không tồn tại hoặc đã ngừng niêm yết: {', '.join(sorted(unknown))}",
            {"field": "symbols", "unknown": sorted(unknown)},
        )
    return sorted(known)


def create(
    db: Session,
    user: User,
    *,
    name: str,
    school: str,
    kind: str,
    symbols: list[str],
    description: str | None = None,
    rules_summary: str | None = None,
    rules_json: dict | None = None,
) -> Strategy:
    count = db.scalar(
        select(func.count())
        .select_from(Strategy)
        .where(Strategy.owner_type == StrategyOwnerType.USER, Strategy.owner_id == user.id)
    ) or 0
    if count >= MAX_STRATEGIES_PER_USER:
        raise Conflict(
            f"Bạn đã tạo tối đa {MAX_STRATEGIES_PER_USER} chiến lược. "
            "Xoá bớt chiến lược cũ để tạo mới.",
            "STRATEGY_LIMIT_REACHED",
        )

    valid_symbols = _validate_symbols(db, symbols)

    strategy = Strategy(
        code=_generate_code(db, user, name),
        name=name.strip(),
        school=school,
        kind=kind,
        timeframe=FIXED_TIMEFRAME,
        description=description,
        rules_summary=rules_summary,
        # Chiến lược loại tài liệu không mang bộ điều kiện. Bỏ qua thay vì báo lỗi ở tầng này:
        # tầng API đã không nhận `rules` cho loại DOCUMENT, đây là chốt thứ hai.
        rules_json=rules_json if kind == StrategyKind.RULE else None,
        owner_type=StrategyOwnerType.USER,
        owner_id=user.id,
        # Không bao giờ công khai: chiến lược cá nhân chỉ đến được người khác qua chia sẻ.
        is_public=False,
        status=StrategyStatus.ACTIVE,
        min_package_id=None,
    )
    db.add(strategy)
    db.flush()

    for symbol in valid_symbols:
        db.add(StrategySymbol(strategy_id=strategy.id, symbol=symbol))
    db.flush()
    return strategy


def update(
    db: Session,
    user: User,
    strategy_id: int,
    *,
    name: str | None = None,
    school: str | None = None,
    symbols: list[str] | None = None,
    description: str | None = None,
    rules_summary: str | None = None,
    rules_json: dict | None = None,
) -> Strategy:
    strategy, is_owner = get_for_user(db, user, strategy_id)
    if not is_owner:
        raise Forbidden(
            "Bạn chỉ được xem chiến lược này. Chỉ người tạo mới sửa được.", "NOT_STRATEGY_OWNER"
        )

    if name is not None:
        strategy.name = name.strip()
    if school is not None:
        strategy.school = school
    if description is not None:
        strategy.description = description
    if rules_summary is not None:
        strategy.rules_summary = rules_summary
    if rules_json is not None:
        if strategy.kind != StrategyKind.RULE:
            raise Conflict(
                "Chiến lược này chạy bằng tài liệu, không có bộ điều kiện để sửa.",
                "STRATEGY_KIND_MISMATCH",
            )
        strategy.rules_json = rules_json

    if symbols is not None:
        valid = _validate_symbols(db, symbols)
        current = {s.symbol for s in strategy.symbols}
        for symbol in current - set(valid):
            db.execute(
                StrategySymbol.__table__.delete().where(
                    StrategySymbol.strategy_id == strategy_id, StrategySymbol.symbol == symbol
                )
            )
        for symbol in set(valid) - current:
            db.add(StrategySymbol(strategy_id=strategy_id, symbol=symbol))

    db.flush()
    return strategy


def delete(db: Session, user: User, strategy_id: int) -> None:
    strategy, is_owner = get_for_user(db, user, strategy_id)
    if not is_owner:
        raise Forbidden("Chỉ người tạo mới xoá được chiến lược này", "NOT_STRATEGY_OWNER")

    # Thu hồi mọi lượt chia sẻ trước, để người nhận không còn thấy chiến lược đã xoá.
    db.execute(
        StrategyShare.__table__.update()
        .where(StrategyShare.strategy_id == strategy_id, StrategyShare.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )
    db.delete(strategy)
    db.flush()


# ======================================================================
# Chia sẻ
# ======================================================================
def share_with_email(
    db: Session, user: User, strategy_id: int, email: str, note: str | None = None
) -> StrategyShare:
    """Chia sẻ đích danh cho một khách hàng khác theo email."""
    strategy, is_owner = get_for_user(db, user, strategy_id)
    if not is_owner:
        raise Forbidden(
            "Chỉ người tạo mới chia sẻ được chiến lược này. Chiến lược được chia sẻ tới bạn "
            "không thể chia sẻ tiếp cho người khác.",
            "NOT_STRATEGY_OWNER",
        )

    target = db.scalar(
        select(User).where(User.email == email.strip().lower(), User.deleted_at.is_(None))
    )
    if not target:
        raise NotFound(
            "Không tìm thấy khách hàng với email này. Người nhận phải có tài khoản trên hệ thống.",
            "RECIPIENT_NOT_FOUND",
        )
    if target.id == user.id:
        raise ValidationError("Không thể chia sẻ cho chính mình", {"field": "email"})

    existing = db.scalar(
        select(StrategyShare).where(
            StrategyShare.strategy_id == strategy_id,
            StrategyShare.shared_with_user_id == target.id,
        )
    )
    if existing:
        if existing.revoked_at is None:
            raise Conflict("Bạn đã chia sẻ chiến lược này cho người đó rồi", "ALREADY_SHARED")
        # Chia sẻ lại sau khi thu hồi — dùng lại bản ghi cũ để giữ nguyên lịch sử.
        existing.revoked_at = None
        existing.note = note
        db.flush()
        _notify_recipient(db, target, user, strategy)
        return existing

    share = StrategyShare(
        strategy_id=strategy_id,
        shared_by_user_id=user.id,
        shared_with_user_id=target.id,
        can_view=True,
        accepted_at=utcnow(),
        note=note,
    )
    db.add(share)
    db.flush()
    _notify_recipient(db, target, user, strategy)
    return share


def create_share_link(db: Session, user: User, strategy_id: int) -> StrategyShare:
    """Sinh link chia sẻ. Ai có link và đang đăng nhập thì nhận được chiến lược."""
    strategy, is_owner = get_for_user(db, user, strategy_id)
    if not is_owner:
        raise Forbidden("Chỉ người tạo mới chia sẻ được chiến lược này", "NOT_STRATEGY_OWNER")

    existing = db.scalar(
        select(StrategyShare).where(
            StrategyShare.strategy_id == strategy_id,
            StrategyShare.share_token.is_not(None),
            StrategyShare.shared_with_user_id.is_(None),
            StrategyShare.revoked_at.is_(None),
        )
    )
    if existing:
        return existing

    share = StrategyShare(
        strategy_id=strategy_id,
        shared_by_user_id=user.id,
        shared_with_user_id=None,
        share_token=generate_url_token()[:48],
        can_view=True,
    )
    db.add(share)
    db.flush()
    return share


def accept_share_link(db: Session, user: User, token: str) -> Strategy:
    """Người nhận mở link — tạo bản ghi chia sẻ đích danh cho chính họ."""
    link = db.scalar(
        select(StrategyShare).where(
            StrategyShare.share_token == token, StrategyShare.revoked_at.is_(None)
        )
    )
    if not link:
        raise NotFound("Link chia sẻ không hợp lệ hoặc đã bị thu hồi", "SHARE_LINK_INVALID")

    strategy = db.get(Strategy, link.strategy_id)
    if not strategy:
        raise NotFound("Chiến lược không còn tồn tại")
    if strategy.owner_id == user.id:
        return strategy

    existing = db.scalar(
        select(StrategyShare).where(
            StrategyShare.strategy_id == link.strategy_id,
            StrategyShare.shared_with_user_id == user.id,
        )
    )
    if existing:
        existing.revoked_at = None
    else:
        db.add(
            StrategyShare(
                strategy_id=link.strategy_id,
                shared_by_user_id=link.shared_by_user_id,
                shared_with_user_id=user.id,
                can_view=True,
                accepted_at=utcnow(),
                note="Nhận qua link chia sẻ",
            )
        )
    db.flush()
    return strategy


def list_shares(db: Session, user: User, strategy_id: int) -> list[tuple[StrategyShare, str | None]]:
    """Danh sách người đang được chia sẻ — kèm email để chủ sở hữu biết đã chia cho ai."""
    _, is_owner = get_for_user(db, user, strategy_id)
    if not is_owner:
        raise Forbidden("Chỉ người tạo mới xem được danh sách chia sẻ", "NOT_STRATEGY_OWNER")

    rows = db.execute(
        select(StrategyShare, User.email)
        .outerjoin(User, User.id == StrategyShare.shared_with_user_id)
        .where(
            StrategyShare.strategy_id == strategy_id,
            StrategyShare.revoked_at.is_(None),
        )
        .order_by(StrategyShare.id.desc())
    ).all()
    return [(share, email) for share, email in rows]


def revoke_share(db: Session, user: User, share_id: int) -> None:
    share = db.get(StrategyShare, share_id)
    if not share or share.revoked_at:
        raise NotFound("Lượt chia sẻ không tồn tại")

    _, is_owner = get_for_user(db, user, share.strategy_id)
    if not is_owner:
        raise Forbidden("Chỉ người tạo mới thu hồi được chia sẻ", "NOT_STRATEGY_OWNER")

    share.revoked_at = utcnow()
    db.flush()


def _notify_recipient(db: Session, target: User, sender: User, strategy: Strategy) -> None:
    from app.core.constants import NotificationChannel, NotificationCode
    from app.services import notification_service

    notification_service.enqueue(
        db,
        user=target,
        code=NotificationCode.ADMIN_BROADCAST,
        channels=[NotificationChannel.IN_APP],
        reference_id=f"share:{strategy.id}:{target.id}",
        context={
            "full_name": target.full_name,
            "subject": "Bạn được chia sẻ một chiến lược",
            # Không lộ email người gửi — chỉ nêu tên hiển thị.
            "message": (
                f"{sender.full_name} đã chia sẻ chiến lược “{strategy.name}” với bạn. "
                "Xem trong mục Chiến lược → Được chia sẻ."
            ),
        },
    )


# ======================================================================
# Tài liệu của chiến lược cá nhân
# ======================================================================
#: Danh mục riêng cho file khách tự tải lên. `documents.category_id` là NOT NULL nên phải có một
#: danh mục; dùng chung danh mục với kho công ty sẽ trộn hai loại nội dung trong mọi bộ lọc.
PERSONAL_DOC_CATEGORY_CODE = "PERSONAL_STRATEGY"


def _personal_doc_category(db: Session) -> Category:
    """Lấy (hoặc tạo) danh mục tài liệu riêng. Ẩn khỏi site khách vì `is_active=False`."""
    from app.core.constants import CategoryType

    category = db.scalar(
        select(Category).where(
            Category.code == PERSONAL_DOC_CATEGORY_CODE, Category.type == CategoryType.DOCUMENT
        )
    )
    if category:
        return category
    category = Category(
        code=PERSONAL_DOC_CATEGORY_CODE,
        name="Tài liệu chiến lược cá nhân",
        type=CategoryType.DOCUMENT,
        sort_order=999,
        # Tắt hẳn: danh mục này không bao giờ được hiện như một lựa chọn trên giao diện.
        is_active=False,
    )
    db.add(category)
    db.flush()
    return category


def list_documents(db: Session, user: User, strategy_id: int) -> list[Document]:
    """Tài liệu của một chiến lược cá nhân. Người được chia sẻ cũng đọc được."""
    get_for_user(db, user, strategy_id)
    return list(
        db.scalars(
            select(Document)
            .join(StrategyKbDoc, StrategyKbDoc.document_id == Document.id)
            .where(StrategyKbDoc.strategy_id == strategy_id, Document.is_active.is_(True))
            .order_by(Document.id.desc())
        ).all()
    )


def attach_document(
    db: Session,
    user: User,
    strategy_id: int,
    *,
    title: str,
    stored_name: str,
    original_name: str,
    file_size: int,
    mime_type: str,
    checksum: str | None,
) -> Document:
    """Gắn một file vừa tải lên vào chiến lược cá nhân loại DOCUMENT.

    `owner_user_id` là thứ giữ file này nằm ngoài kho tài liệu chung. Thiếu nó thì lượt tải đầu
    tiên của một khách đã phát file riêng của họ cho toàn bộ khách hàng còn lại.
    """
    strategy, is_owner = get_for_user(db, user, strategy_id)
    if not is_owner:
        raise Forbidden(
            "Bạn chỉ được xem chiến lược này. Chỉ người tạo mới thêm được tài liệu.",
            "NOT_STRATEGY_OWNER",
        )
    if strategy.kind != StrategyKind.DOCUMENT:
        raise Conflict(
            "Chiến lược này chạy bằng bộ điều kiện, không nhận tài liệu. "
            "Muốn dùng tài liệu thì tạo chiến lược loại tài liệu.",
            "STRATEGY_KIND_MISMATCH",
        )

    count = db.scalar(
        select(func.count())
        .select_from(StrategyKbDoc)
        .where(StrategyKbDoc.strategy_id == strategy_id)
    ) or 0
    if count >= MAX_DOCS_PER_STRATEGY:
        raise Conflict(
            f"Mỗi chiến lược chỉ gắn được tối đa {MAX_DOCS_PER_STRATEGY} tài liệu.",
            "DOCUMENT_LIMIT_REACHED",
        )

    document = Document(
        category_id=_personal_doc_category(db).id,
        title=title.strip()[:255],
        stored_name=stored_name,
        original_name=original_name,
        file_size=file_size,
        mime_type=mime_type,
        checksum=checksum,
        # Không ràng bậc gói: tài liệu của chính khách, không phải hàng công ty bán.
        min_package_id=None,
        owner_user_id=user.id,
        uploaded_by=user.id,
    )
    db.add(document)
    db.flush()
    db.add(StrategyKbDoc(strategy_id=strategy_id, document_id=document.id))
    db.flush()
    return document


def detach_document(db: Session, user: User, strategy_id: int, document_id: int) -> str:
    """Gỡ tài liệu khỏi chiến lược và đánh dấu ngưng dùng. Trả `stored_name` để tầng gọi xoá file."""
    _, is_owner = get_for_user(db, user, strategy_id)
    if not is_owner:
        raise Forbidden("Chỉ người tạo mới gỡ được tài liệu", "NOT_STRATEGY_OWNER")

    link = db.scalar(
        select(StrategyKbDoc).where(
            StrategyKbDoc.strategy_id == strategy_id, StrategyKbDoc.document_id == document_id
        )
    )
    document = db.get(Document, document_id)
    if not link or not document or document.owner_user_id != user.id:
        raise NotFound("Tài liệu không tồn tại")

    db.delete(link)
    document.is_active = False
    db.flush()
    return document.stored_name


# ======================================================================
# Thống kê chia sẻ
# ======================================================================
def share_counts(db: Session, strategy_ids: list[int]) -> dict[int, int]:
    """Số người đang dùng chiến lược, theo từng chiến lược.

    Gộp cho cả danh sách trong một truy vấn: gọi lẻ từng dòng nghĩa là N lượt COUNT cho một màn
    hình vốn chỉ hiển thị một con số nhỏ trên mỗi thẻ.

    Đếm lượt **còn hiệu lực** (`revoked_at IS NULL`) — chia rồi thu hồi thì người đó không
    còn dùng nữa, đếm vào là nói quá độ phổ biến của chiến lược.
    """
    if not strategy_ids:
        return {}
    rows = db.execute(
        select(StrategyShare.strategy_id, func.count())
        .where(
            StrategyShare.strategy_id.in_(strategy_ids),
            StrategyShare.revoked_at.is_(None),
        )
        .group_by(StrategyShare.strategy_id)
    ).all()
    return {int(strategy_id): int(count) for strategy_id, count in rows}
