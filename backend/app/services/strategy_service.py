"""Xoá chiến lược — dọn dữ liệu phụ thuộc theo đúng thứ tự khoá ngoại.

**Vì sao phải có module này thay vì một `db.delete(strategy)`.** Trong lược đồ, hầu hết bảng con
trỏ về `strategies.id` bằng `ON DELETE CASCADE`, nhưng `signals.strategy_id` thì **không** (xem
migration `0001`, dòng `ForeignKeyConstraint(['strategy_id'], ['strategies.id'], )` — không có
`ondelete`). MySQL mặc định là RESTRICT, nên chiến lược nào từng phát ra dù chỉ một tín hiệu là
`db.delete()` chết với lỗi 1451 và người dùng chỉ thấy "không xoá được". Đó đúng là tình trạng
đang gặp ở cả site quản trị lẫn chiến lược cá nhân của khách.

**Vì sao dọn ở tầng ứng dụng chứ không sửa khoá ngoại thành CASCADE.** Sửa khoá ngoại vẫn không
đủ: `alert_deliveries.signal_id` và `strategy_questions.signal_id` trỏ về `signals.id` cũng không
có `ondelete`, nên cascade từ `strategies` xuống `signals` lại vướng ở tầng dưới. Dọn tường minh
giải quyết trọn chuỗi, chạy được trên CSDL đang có mà không cần migration, và **đếm được** đã xoá
những gì — con số đó đi thẳng vào nhật ký kiểm toán.

**Tín hiệu và BR-840.** BR-840 nói tín hiệu bất biến *sau khi tạo*: không sửa, không xoá lẻ. Xoá
cả chiến lược là chuyện khác — nó bỏ luôn cả bối cảnh mà tín hiệu thuộc về. Nhưng vì thao tác này
làm bốc hơi lịch sử hiệu suất, tầng gọi **bắt buộc** ghi nhật ký kèm lý do và số bản ghi đã mất
(xem `AuditAction.STRATEGY_DELETE`) — mất dữ liệu thì được, mất dấu vết thì không.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.models.analysis import SymbolAnalysis, SymbolAnalysisSetup
from app.models.content import Document
from app.models.strategy import (
    Signal,
    Strategy,
    StrategyFaq,
    StrategyKbDoc,
    StrategyQuestion,
    StrategyShare,
    StrategyStat,
)
from app.models.telegram import AlertDelivery, StrategyAlert


@dataclass
class PurgeResult:
    """Đã xoá những gì — để báo lại cho người bấm nút và ghi vào nhật ký."""

    signals: int = 0
    analyses: int = 0
    alerts: int = 0
    questions: int = 0
    shares: int = 0
    documents: int = 0

    #: File cần xoá khỏi đĩa **sau khi commit**. Xoá file trước khi commit thì giao dịch CSDL
    #: rollback là mất file mà bản ghi vẫn còn — hỏng theo kiểu không sửa lại được.
    stored_names: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "signals": self.signals,
            "analyses": self.analyses,
            "alerts": self.alerts,
            "questions": self.questions,
            "shares": self.shares,
            "documents": self.documents,
        }


def counts_for(db: Session, strategy_id: int) -> dict:
    """Đếm trước những gì sẽ mất, để hộp xác nhận nói rõ cái giá của cú bấm.

    "Xoá chiến lược này?" và "Xoá chiến lược này cùng 412 tín hiệu, 96 bản phân tích và 8 khách
    hàng đang nhận cảnh báo?" là hai câu hỏi khác nhau.
    """

    def _count(model, column) -> int:
        return int(db.scalar(select(func.count()).select_from(model).where(column == strategy_id)) or 0)

    return {
        "signals": _count(Signal, Signal.strategy_id),
        "analyses": _count(SymbolAnalysis, SymbolAnalysis.strategy_id),
        "alerts": int(
            db.scalar(
                select(func.count())
                .select_from(StrategyAlert)
                .where(StrategyAlert.strategy_id == strategy_id, StrategyAlert.is_active.is_(True))
            )
            or 0
        ),
        "questions": _count(StrategyQuestion, StrategyQuestion.strategy_id),
        "shares": int(
            db.scalar(
                select(func.count())
                .select_from(StrategyShare)
                .where(
                    StrategyShare.strategy_id == strategy_id,
                    StrategyShare.revoked_at.is_(None),
                )
            )
            or 0
        ),
        "documents": _count(StrategyKbDoc, StrategyKbDoc.strategy_id),
    }


def purge(db: Session, strategy: Strategy) -> PurgeResult:
    """Xoá chiến lược cùng mọi thứ treo vào nó. Chưa commit — tầng gọi tự quyết định.

    Thứ tự dưới đây là **thứ tự khoá ngoại**, không phải thứ tự tuỳ ý: bảng nào bị bảng khác trỏ
    tới thì phải xoá bảng trỏ tới trước. Đảo một bước là gặp lại đúng lỗi 1451 đang phải sửa.

    Riêng `strategy_symbols` để `db.delete(strategy)` tự lo qua quan hệ `delete-orphan` — bulk
    delete rồi lại xoá qua ORM sẽ khiến SQLAlchemy thao tác trên bộ sưu tập đã lỗi thời.
    """
    result = PurgeResult()
    strategy_id = strategy.id
    signal_ids = select(Signal.id).where(Signal.strategy_id == strategy_id)

    # 1. Lượt gửi cảnh báo trỏ về từng tín hiệu — tầng sâu nhất của chuỗi.
    db.execute(delete(AlertDelivery).where(AlertDelivery.signal_id.in_(signal_ids)))

    # 2. Câu hỏi của chiến lược KHÁC nhưng hỏi về tín hiệu của chiến lược này. Hiếm, nhưng chỉ
    #    cần một bản ghi như vậy là bước xoá tín hiệu bên dưới thất bại. Gỡ tham chiếu chứ không
    #    xoá: câu hỏi đó vẫn thuộc về chiến lược kia và không có lý do gì mất theo.
    db.execute(
        update(StrategyQuestion)
        .where(
            StrategyQuestion.signal_id.in_(signal_ids),
            StrategyQuestion.strategy_id != strategy_id,
        )
        .values(signal_id=None)
    )

    result.questions = db.execute(
        delete(StrategyQuestion).where(StrategyQuestion.strategy_id == strategy_id)
    ).rowcount or 0

    result.signals = db.execute(
        delete(Signal).where(Signal.strategy_id == strategy_id)
    ).rowcount or 0

    # 3. Bản phân tích và kịch bản con của nó.
    analysis_ids = select(SymbolAnalysis.id).where(SymbolAnalysis.strategy_id == strategy_id)
    db.execute(delete(SymbolAnalysisSetup).where(SymbolAnalysisSetup.analysis_id.in_(analysis_ids)))
    result.analyses = db.execute(
        delete(SymbolAnalysis).where(SymbolAnalysis.strategy_id == strategy_id)
    ).rowcount or 0

    # 4. Đăng ký cảnh báo, thống kê, hỏi đáp công khai, lượt chia sẻ.
    result.alerts = db.execute(
        delete(StrategyAlert).where(StrategyAlert.strategy_id == strategy_id)
    ).rowcount or 0
    db.execute(delete(StrategyStat).where(StrategyStat.strategy_id == strategy_id))
    db.execute(delete(StrategyFaq).where(StrategyFaq.strategy_id == strategy_id))
    result.shares = db.execute(
        delete(StrategyShare).where(StrategyShare.strategy_id == strategy_id)
    ).rowcount or 0

    # 5. Tài liệu. Bản ghi `documents` là tài sản của KHO, không của chiến lược — nhiều chiến
    #    lược dùng chung một file, nên chỉ gỡ liên kết. Ngoại lệ là tài liệu riêng của khách hàng
    #    (`owner_user_id`): nó tồn tại chỉ vì chiến lược này, không gỡ thì thành file mồ côi chiếm
    #    đĩa vĩnh viễn. Đánh dấu ngưng dùng thay vì xoá bản ghi, đúng như `detach_document` —
    #    nhật ký tải xuống cũ vẫn cần tham chiếu tới nó.
    links = db.scalars(
        select(StrategyKbDoc).where(StrategyKbDoc.strategy_id == strategy_id)
    ).all()
    result.documents = len(links)
    for link in links:
        document = db.get(Document, link.document_id)
        db.delete(link)
        if document and document.owner_user_id is not None:
            others = db.scalar(
                select(func.count())
                .select_from(StrategyKbDoc)
                .where(
                    StrategyKbDoc.document_id == document.id,
                    StrategyKbDoc.strategy_id != strategy_id,
                )
            ) or 0
            if not others:
                document.is_active = False
                result.stored_names.append(document.stored_name)

    db.delete(strategy)
    db.flush()
    return result
