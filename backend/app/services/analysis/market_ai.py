"""Phân tích theo biểu đồ — nút Phân tích ở màn bảng giá.

Khác phân tích theo chiến lược ở **căn cứ**, không ở kết quả:

* Theo chiến lược: mô hình đọc tài liệu của chiến lược rồi đối chiếu với nến. Kết quả dùng
  chung theo ngày cho mọi khách, vì căn cứ là như nhau với tất cả mọi người.
* Theo biểu đồ: căn cứ là **bộ chỉ báo người dùng đang bật** — RSI 14 hay RSI 21, có Bollinger
  hay không, có bộ SMC hay không. Bộ chỉ báo do chính họ chọn, nên kết quả là của riêng họ.

Ba điều khác biệt kéo theo từ đó:

**Chống chạy trùng theo bộ chỉ báo, không theo ngày.** Khoá là `(người bấm, ngày, mã, vân tay
bộ chỉ báo)`. Bấm lại đúng bộ đó trong ngày thì đọc lại bản cũ, không tiêu thêm lượt: nến của
phiên đã đóng là cố định, chạy lại chỉ tốn tiền để nhận về đúng câu trả lời cũ. Đổi tham số một
chỉ báo là một câu hỏi khác — vân tay đổi, và nó xứng đáng một lượt mới.

**Giá trị chỉ báo do giao diện tính rồi gửi lên.** Cả 37 chỉ báo nằm ở `frontend/src/lib/
indicators`. Chép chúng sang Python để máy chủ tự tính là nhân đôi công thức, và hai bản sẽ
trôi khỏi nhau — lúc đó con số mô hình đọc không còn là con số người dùng nhìn thấy trên biểu
đồ, mà đó chính là thứ khiến nhận định trở nên vô nghĩa.

**Vẫn tiêu chung một hạn mức.** Cùng `analysis_quota_usage` với nút bên chiến lược: với người
dùng thì đây là "một lượt hỏi AI", họ không quan tâm nó xuất phát từ màn nào.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.constants import AnalysisSource, SymbolAnalysisStatus
from app.core.datetime_utils import local_today
from app.core.exceptions import TooManyRequests, ValidationError
from app.models.analysis import AnalysisQuotaUsage, SymbolAnalysis
from app.models.market import OhlcvDaily, Symbol
from app.services.analysis import ondemand

log = logging.getLogger(__name__)


def _canonical_params(params: dict | None) -> dict:
    """Tham số ở dạng so sánh được, bất kể đường nào gửi lên.

    Số đi qua pydantic (nút bấm, `POST`) thành `float`: `14` hoá `14.0`. Số đọc thẳng từ JSON
    của tham số truy vấn (màn hình đọc lại, `GET`) vẫn là `int`. Cùng một bộ chỉ báo mà băm ra
    hai vân tay thì màn hình không bao giờ tìm thấy bản mà chính nút bấm vừa tạo ra — nó hiện
    "chưa phân tích" ngay sau khi phân tích xong. Quy hết về `float` để hai đường gặp nhau.
    """
    out: dict = {}
    for key, value in (params or {}).items():
        # `bool` là con của `int` trong Python — không đổi nó thành 1.0/0.0.
        out[key] = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else value
    return out


def clean_note(note: str | None) -> str:
    """Câu hỏi kèm theo, ở dạng chuẩn để so sánh và để băm.

    Khoảng trắng thừa không phải một câu hỏi khác: gõ thêm dấu cách ở cuối rồi bấm lại mà bị
    tính một lượt mới là mất tiền cho đúng câu hỏi cũ.
    """
    return (note or "").strip()


def fingerprint(symbol: str, indicators: list[dict], note: str | None = None) -> str:
    """Vân tay của một câu hỏi: mã + bộ chỉ báo + lời dặn kèm theo.

    Chỉ lấy **mã chỉ báo và tham số**, không lấy giá trị: giá trị đổi theo từng phiên, mà ngày
    thì đã nằm trong khoá rồi. Sắp xếp trước khi băm để thứ tự người dùng thêm chỉ báo không
    tạo ra hai vân tay khác nhau cho cùng một bộ.

    Câu hỏi kèm theo nằm trong vân tay vì nó đổi hẳn câu trả lời: cùng một bộ chỉ báo, hỏi
    "vào lệnh được chưa" và hỏi "vùng cắt lỗ hợp lý ở đâu" là hai việc khác nhau. Chỉ nối vào
    khi có chữ, nên các bản đã lưu trước khi có ô nhập vẫn giữ nguyên vân tay cũ.
    """
    parts = sorted(
        f"{item.get('id')}:"
        f"{json.dumps(_canonical_params(item.get('params')), sort_keys=True, default=str)}"
        for item in indicators
    )
    raw = f"{symbol.upper()}|" + "|".join(parts)
    text = clean_note(note)
    if text:
        raw += f"|note:{text}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _assert_symbol_usable(db: Session, symbol: str) -> None:
    """Mã phải có thật và có nến. Không có nến thì không có gì để phân tích."""
    exists = db.scalar(select(Symbol.id).where(Symbol.symbol == symbol))
    if not exists:
        raise ValidationError(f"Không tìm thấy mã {symbol}", {"field": "symbol"})
    has_candles = db.scalar(select(OhlcvDaily.id).where(OhlcvDaily.symbol == symbol).limit(1))
    if not has_candles:
        raise ValidationError(
            f"Chưa có dữ liệu giá của mã {symbol} để phân tích", {"field": "symbol"}
        )


def _find(
    db: Session, *, user_id: int, day: date, symbol: str, key: str
) -> SymbolAnalysis | None:
    return db.scalar(
        select(SymbolAnalysis)
        .where(
            SymbolAnalysis.strategy_id.is_(None),
            SymbolAnalysis.requested_by == user_id,
            SymbolAnalysis.analysis_date == day,
            SymbolAnalysis.symbol == symbol,
            SymbolAnalysis.context_key == key,
        )
        .order_by(SymbolAnalysis.id.desc())
    )


def find_for_indicators(
    db: Session, user_id: int, symbol: str, indicators: list[dict], note: str | None = None
) -> SymbolAnalysis | None:
    """Bản phân tích của **đúng bộ chỉ báo đang bật**, trong ngày hôm nay. `None` nếu chưa có.

    Màn bảng giá cố ý không hiện "bản gần nhất bất kỳ" của mã này. Căn cứ của một nhận định là
    bộ chỉ báo sinh ra nó: đem bản của bộ khác đặt ngay dưới biểu đồ đang bật bộ này là để cạnh
    nhau hai thứ không nói về nhau, và người đọc không có cách nào biết. Đổi chỉ báo thì màn
    hình trở lại trạng thái chưa phân tích, và nút Phân tích là đường duy nhất để có bản mới.

    Khoá ở đây **đúng bằng** khoá của `request_analysis`, nên thứ hiện ra là thứ nút bấm sẽ trả
    về mà không tiêu thêm lượt nào — hai đường không thể lệch nhau.

    Không bật chỉ báo nào cũng là một bộ hợp lệ (bộ rỗng), và nó khớp với bản phân tích thuần
    nến — chứ không phải khớp với mọi bản.
    """
    symbol = (symbol or "").strip().upper()
    if not symbol:
        return None
    key = fingerprint(symbol, indicators, note)
    return _find(db, user_id=user_id, day=local_today(), symbol=symbol, key=key)


def request_analysis(
    db: Session, *, user_id: int, symbol: str, indicators: list[dict], note: str | None = None
) -> tuple[SymbolAnalysis, bool]:
    """Trả `(bản phân tích, có khởi động lượt chạy mới không)`.

    Ném `TooManyRequests` khi hết hạn mức, `ValidationError` khi mã không dùng được.
    """
    symbol = (symbol or "").strip().upper()
    if not symbol:
        raise ValidationError("Chưa chọn mã để phân tích", {"field": "symbol"})
    _assert_symbol_usable(db, symbol)

    day = local_today()
    note = clean_note(note)
    key = fingerprint(symbol, indicators, note)

    existing = _find(db, user_id=user_id, day=day, symbol=symbol, key=key)
    if existing:
        # Bản hỏng thì cho chạy lại như một lượt mới — người dùng không có cách nào sửa được
        # lỗi hạ tầng, và bắt họ đổi tham số chỉ để thoát khỏi một bản FAILED là vô lý.
        if existing.status != SymbolAnalysisStatus.FAILED:
            return existing, False
        state = ondemand.quota_state(db, user_id, day)
        if state["remaining"] <= 0:
            raise TooManyRequests(
                f"Bạn đã dùng hết {state['limit']} lượt phân tích của hôm nay.",
                "ANALYSIS_QUOTA_EXCEEDED",
            )
        db.add(AnalysisQuotaUsage(user_id=user_id, usage_date=day, analysis_id=existing.id))
        existing.context = {"indicators": indicators, "note": note}
        ondemand.reset_for_retry(db, existing)
        return existing, True

    # Xét hạn mức **trước** khi chèn: chèn xong mới phát hiện hết lượt thì phải xoá lại, và
    # giữa hai bước đó worker có thể đã nhặt việc đi chạy.
    state = ondemand.quota_state(db, user_id, day)
    if state["remaining"] <= 0:
        raise TooManyRequests(
            f"Bạn đã dùng hết {state['limit']} lượt phân tích của hôm nay. "
            "Hạn mức đặt lại vào đầu ngày hôm sau.",
            "ANALYSIS_QUOTA_EXCEEDED",
        )

    item = SymbolAnalysis(
        analysis_date=day,
        strategy_id=None,
        symbol=symbol,
        source=AnalysisSource.AI,
        status=SymbolAnalysisStatus.QUEUED,
        requested_by=user_id,
        view_count=1,
        context={"indicators": indicators, "note": note},
        context_key=key,
    )
    db.add(item)
    db.flush()
    db.add(AnalysisQuotaUsage(user_id=user_id, usage_date=day, analysis_id=item.id))
    db.flush()
    return item, True


# ======================================================================
# Bối cảnh cho mô hình đọc
# ======================================================================
def indicators_text(item: SymbolAnalysis) -> str:
    """Bộ chỉ báo của một lượt, viết thành văn bản cho mô hình đọc.

    Dạng bảng chứ không JSON, vì cùng một dữ liệu thì JSON tốn khoảng gấp ba số token do lặp
    tên khoá ở mọi dòng — và phần tiết kiệm được ở đây là phần nến giữ lại được.
    """
    indicators = ((item.context or {}).get("indicators")) or []
    if not indicators:
        return "(Người dùng không bật chỉ báo nào — phân tích thuần theo nến.)"

    blocks: list[str] = []
    for ind in indicators:
        params = ind.get("params") or {}
        param_text = ", ".join(f"{k}={v}" for k, v in params.items()) or "mặc định"
        head = f"### {ind.get('label') or ind.get('name')} ({ind.get('name')}) — {param_text}"
        lines = [head]

        for plot in ind.get("plots") or []:
            points = plot.get("points") or []
            if not points:
                continue
            body = " ".join(f"{d}={v}" for d, v in points)
            lines.append(f"- {plot.get('label') or plot.get('key')}: {body}")

        for note in ind.get("notes") or []:
            lines.append(f"- {note}")

        blocks.append("\n".join(lines))

    return "\n\n".join(blocks)


def note_of(item: SymbolAnalysis) -> str:
    """Lời dặn kèm theo của một lượt. Rỗng nghĩa là khách không dặn gì."""
    return clean_note(((item.context or {}).get("note")))


def indicator_labels(item: SymbolAnalysis) -> list[str]:
    """Tên các chỉ báo đã dùng — giao diện hiện lại để khách biết nhận định dựa trên cái gì."""
    indicators = ((item.context or {}).get("indicators")) or []
    return [str(ind.get("label") or ind.get("name") or ind.get("id")) for ind in indicators]
