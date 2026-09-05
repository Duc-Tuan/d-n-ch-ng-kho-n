"""Chiến lược cá nhân của khách hàng — mục 13.1 (nguồn tạo thứ hai)."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, File, Form, Query, UploadFile
from pydantic import BaseModel, EmailStr, Field

from app.core.config import settings
from app.core.constants import SignalType, StrategyKind, StrategySchool
from app.core.deps import ActiveUser, DbSession
from app.schemas.common import IdResponse, Message
from app.schemas.domain import StrategyDetail, StrategyListItem
from app.services import (
    signal_service,
    storage_service,
    strategy_run_service,
    user_strategy_service,
)

router = APIRouter(prefix="/my-strategies", tags=["customer-my-strategies"])


class MyStrategyRequest(BaseModel):
    name: str = Field(min_length=2, max_length=150)
    school: Literal[
        StrategySchool.SMC, StrategySchool.ICT, StrategySchool.PRICE_ACTION,
        StrategySchool.QUANT, StrategySchool.INDICATOR,
    ] = StrategySchool.PRICE_ACTION
    #: RULE (tự dựng điều kiện) hoặc DOCUMENT (tự tải tài liệu lên). Chọn một lần lúc tạo.
    #: `update` bỏ qua trường này — đổi loại nghĩa là vứt bỏ toàn bộ thứ đã nhập cho loại cũ.
    kind: Literal[StrategyKind.RULE, StrategyKind.DOCUMENT] = StrategyKind.RULE
    # `timeframe` cố ý không có: toàn hệ thống chạy trên nến ngày.
    symbols: list[str] = Field(min_length=1, max_length=50)
    description: str | None = Field(default=None, max_length=2000)
    rules_summary: str | None = Field(default=None, max_length=5000)

    #: Bộ điều kiện máy chạy được — chỉ dùng cho loại RULE.
    rules: dict[str, Any] | None = None


class TryRulesRequest(BaseModel):
    """Chạy thử một bộ lọc chưa lưu — để người dùng sửa điều kiện và xem kết quả ngay."""

    symbol: str = Field(min_length=1, max_length=20)
    rules: dict[str, Any]
    from_date: date | None = None


class ShareRequest(BaseModel):
    email: EmailStr
    note: str | None = Field(default=None, max_length=255)


def _to_item(strategy, stats: dict) -> StrategyListItem:
    """Dựng thẻ chiến lược từ bộ thống kê đã tính sẵn cho cả danh sách."""
    item = StrategyListItem.model_validate(strategy)
    item.locked = False
    item.stats_live = stats[(strategy.id, SignalType.LIVE)].as_dict()
    item.stats_backtest = stats[(strategy.id, SignalType.BACKTEST)].as_dict()
    return item


@router.get("", response_model=dict)
def list_my_strategies(user: ActiveUser, db: DbSession) -> dict:
    """Chiến lược của tôi và chiến lược người khác chia sẻ cho tôi — tách hai nhóm rõ ràng."""
    own = user_strategy_service.list_own(db, user)
    shared = user_strategy_service.list_shared_with_me(db, user)

    # Một lượt đọc tín hiệu cho cả hai nhóm, thay vì hai truy vấn cho mỗi chiến lược.
    stats = signal_service.compute_stats_bulk(
        db, [s.id for s in own] + [s.id for s, _ in shared]
    )

    # BR — chủ sở hữu muốn biết bao nhiêu người đang dùng chiến lược của mình.
    shares = user_strategy_service.share_counts(db, [s.id for s in own])

    def own_item(strategy) -> dict:
        return {**_to_item(strategy, stats).model_dump(),
                "share_count": shares.get(strategy.id, 0)}

    return {
        "own": [own_item(s) for s in own],
        "shared": [
            {
                **_to_item(s, stats).model_dump(),
                "share_id": share.id,
                "shared_at": share.created_at,
                "note": share.note,
            }
            for s, share in shared
        ],
        "limit": user_strategy_service.MAX_STRATEGIES_PER_USER,
        "used": len(own),
    }


@router.get("/catalog", response_model=dict)
def rule_catalog(user: ActiveUser) -> dict:
    """Danh mục chỉ báo, toán tử để dựng bộ lọc trên giao diện."""
    return strategy_run_service.catalog()


@router.post("/try", response_model=dict)
def try_rules(payload: TryRulesRequest, user: ActiveUser, db: DbSession) -> dict:
    """Chạy thử bộ lọc chưa lưu lên một mã. Không ghi gì vào CSDL."""
    rules = strategy_run_service.parse_or_400(payload.rules)
    return strategy_run_service.run_rules(
        db, rules, payload.symbol, reveal_rules=True, from_date=payload.from_date
    )


@router.post("", response_model=IdResponse, status_code=201)
def create_my_strategy(payload: MyStrategyRequest, user: ActiveUser, db: DbSession) -> IdResponse:
    # Kiểm tra bộ lọc trước khi lưu — lưu một bộ lọc sai rồi mới báo lỗi lúc chạy thì người dùng
    # không biết mình sai từ bước nào.
    if payload.rules:
        strategy_run_service.parse_or_400(payload.rules)

    strategy = user_strategy_service.create(
        db, user,
        name=payload.name,
        school=payload.school,
        kind=payload.kind,
        symbols=payload.symbols,
        description=payload.description,
        rules_summary=payload.rules_summary,
        rules_json=payload.rules,
    )
    db.commit()
    return IdResponse(
        id=strategy.id,
        message="Đã tạo chiến lược. Chỉ bạn nhìn thấy cho tới khi bạn chủ động chia sẻ.",
    )


@router.get("/{strategy_id}", response_model=dict)
def get_my_strategy(strategy_id: int, user: ActiveUser, db: DbSession) -> dict:
    strategy, is_owner = user_strategy_service.get_for_user(db, user, strategy_id)
    detail = StrategyDetail.model_validate(strategy)
    detail.locked = False
    detail.stats_live = signal_service.compute_stats(
        db, strategy.id, signal_type=SignalType.LIVE
    ).as_dict()
    detail.stats_backtest = signal_service.compute_stats(
        db, strategy.id, signal_type=SignalType.BACKTEST
    ).as_dict()
    # Chiến lược cá nhân: tác giả và người được chia sẻ đều xem được bộ lọc — chính nội dung
    # bộ lọc là thứ được chia sẻ, giấu đi thì chia sẻ không còn ý nghĩa.
    return {
        "strategy": detail,
        "is_owner": is_owner,
        # Chỉ chủ sở hữu mới thấy con số này: người được chia sẻ không cần biết chiến lược
        # còn đang ở trong tay bao nhiêu người khác.
        "share_count": (
            user_strategy_service.share_counts(db, [strategy.id]).get(strategy.id, 0)
            if is_owner
            else None
        ),
        "rules": strategy.rules_json,
    }


@router.post("/{strategy_id}/run", response_model=dict)
def run_my_strategy(
    strategy_id: int,
    user: ActiveUser,
    db: DbSession,
    symbol: str = Query(min_length=1, max_length=20),
    from_date: date | None = None,
) -> dict:
    """YC12 — chạy chiến lược lên một mã bất kỳ, trả điểm mua/bán để vẽ lên biểu đồ."""
    strategy, _ = user_strategy_service.get_for_user(db, user, strategy_id)
    return strategy_run_service.run_strategy(
        db, strategy, symbol, reveal_rules=True, from_date=from_date
    )


@router.put("/{strategy_id}", response_model=Message)
def update_my_strategy(
    strategy_id: int, payload: MyStrategyRequest, user: ActiveUser, db: DbSession
) -> Message:
    if payload.rules:
        strategy_run_service.parse_or_400(payload.rules)

    user_strategy_service.update(
        db, user, strategy_id,
        name=payload.name,
        school=payload.school,
        symbols=payload.symbols,
        description=payload.description,
        rules_summary=payload.rules_summary,
        rules_json=payload.rules,
    )
    db.commit()
    return Message(message="Đã lưu chiến lược")


@router.delete("/{strategy_id}", response_model=Message)
def delete_my_strategy(strategy_id: int, user: ActiveUser, db: DbSession) -> Message:
    user_strategy_service.delete(db, user, strategy_id)
    db.commit()
    return Message(message="Đã xoá chiến lược và thu hồi mọi lượt chia sẻ")


# ======================================================================
# Chia sẻ
# ======================================================================
@router.get("/{strategy_id}/shares", response_model=list[dict])
def list_shares(strategy_id: int, user: ActiveUser, db: DbSession) -> list[dict]:
    rows = user_strategy_service.list_shares(db, user, strategy_id)
    return [
        {
            "id": share.id,
            "email": email,
            "is_link": share.share_token is not None,
            "share_url": (
                f"{settings.frontend_base_url}/strategies/shared/{share.share_token}"
                if share.share_token
                else None
            ),
            "note": share.note,
            "created_at": share.created_at,
        }
        for share, email in rows
    ]


@router.post("/{strategy_id}/share", response_model=Message)
def share_strategy(
    strategy_id: int, payload: ShareRequest, user: ActiveUser, db: DbSession
) -> Message:
    """Chia sẻ đích danh theo email. Người nhận chỉ được XEM, không sửa và không chia sẻ tiếp."""
    user_strategy_service.share_with_email(db, user, strategy_id, str(payload.email), payload.note)
    db.commit()
    return Message(message=f"Đã chia sẻ chiến lược với {payload.email}")


@router.post("/{strategy_id}/share-link", response_model=dict)
def create_share_link(strategy_id: int, user: ActiveUser, db: DbSession) -> dict:
    share = user_strategy_service.create_share_link(db, user, strategy_id)
    db.commit()
    return {
        "share_url": f"{settings.frontend_base_url}/strategies/shared/{share.share_token}",
        "message": "Ai có link này và đang đăng nhập đều nhận được chiến lược. Thu hồi bất cứ lúc nào.",
    }


@router.post("/accept/{token}", response_model=IdResponse)
def accept_share(token: str, user: ActiveUser, db: DbSession) -> IdResponse:
    strategy = user_strategy_service.accept_share_link(db, user, token)
    db.commit()
    return IdResponse(id=strategy.id, message=f"Đã thêm chiến lược “{strategy.name}” vào danh sách của bạn")


@router.delete("/shares/{share_id}", response_model=Message)
def revoke_share(share_id: int, user: ActiveUser, db: DbSession) -> Message:
    user_strategy_service.revoke_share(db, user, share_id)
    db.commit()
    return Message(message="Đã thu hồi quyền xem của người nhận")


# ======================================================================
# Tài liệu của chiến lược cá nhân loại DOCUMENT
# ======================================================================
@router.get("/{strategy_id}/documents", response_model=list[dict])
def list_strategy_documents(strategy_id: int, user: ActiveUser, db: DbSession) -> list[dict]:
    """Tài liệu đã gắn. Người được chia sẻ cũng đọc được — tài liệu là nội dung của chiến lược."""
    docs = user_strategy_service.list_documents(db, user, strategy_id)
    return [
        {
            "id": doc.id,
            "title": doc.title,
            "original_name": doc.original_name,
            "file_size": doc.file_size,
            "mime_type": doc.mime_type,
            "created_at": doc.created_at,
            # Tài liệu riêng không ràng bậc gói nên không bao giờ khoá — giữ trường cho đồng
            # dạng với kho tài liệu chung để giao diện dùng chung một thẻ.
            "locked": False,
        }
        for doc in docs
    ]


@router.post("/{strategy_id}/documents", response_model=IdResponse, status_code=201)
async def upload_strategy_document(
    strategy_id: int,
    user: ActiveUser,
    db: DbSession,
    file: UploadFile = File(...),
    title: str | None = Form(None),
) -> IdResponse:
    """Tải một tài liệu lên cho chiến lược cá nhân.

    Dùng lại toàn bộ `storage_service`: whitelist đuôi file, trần dung lượng, đổi tên khi lưu,
    file nằm ngoài thư mục public (BR-510). Khách hàng tải lên không phải lý do để nới bất kỳ
    kiểm tra nào — ngược lại mới đúng.
    """
    content = await storage_service.read_upload(file)
    ext, mime = storage_service.validate_upload(file.filename or "", len(content), content[:16])

    stored_name = storage_service.generate_stored_name(ext)
    checksum = storage_service.save_file(content, stored_name)
    original = storage_service.sanitize_filename(file.filename or stored_name)

    try:
        document = user_strategy_service.attach_document(
            db, user, strategy_id,
            title=title or original,
            stored_name=stored_name,
            original_name=original,
            file_size=len(content),
            mime_type=mime,
            checksum=checksum,
        )
    except Exception:
        # File đã nằm trên đĩa trước khi kiểm tra quyền xong. Không dọn thì mỗi lượt tải bị từ
        # chối để lại một file mồ côi không bản ghi nào trỏ tới.
        storage_service.delete_file(stored_name)
        raise

    db.commit()
    return IdResponse(id=document.id, message="Đã tải tài liệu lên chiến lược")


@router.delete("/{strategy_id}/documents/{document_id}", response_model=Message)
def delete_strategy_document(
    strategy_id: int, document_id: int, user: ActiveUser, db: DbSession
) -> Message:
    stored_name = user_strategy_service.detach_document(db, user, strategy_id, document_id)
    db.commit()
    storage_service.delete_file(stored_name)
    return Message(message="Đã gỡ tài liệu khỏi chiến lược")
