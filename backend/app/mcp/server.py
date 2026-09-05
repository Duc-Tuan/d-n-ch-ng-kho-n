"""MCP server `stock-analysis` — cửa duy nhất để mô hình chạm vào dữ liệu của hệ thống.

Chạy:  python -m app.mcp.server        (từ thư mục `backend`)
   hoặc:  python <duong/dan>/app/mcp/server.py   (từ bất kỳ đâu — Claude Desktop dùng cách này)

Xây một lần, dùng cho hai đường:
  * `claude -p` do bể luồng phân tích sinh ra khi khách hàng bấm nút Phân tích;
  * Claude Desktop — phân tích tay, và là cách kiểm chất lượng trước khi tin vào kết quả tự động.

**Ranh giới an toàn duy nhất đáng kể: server này tuyệt đối không ghi vào `signals`.** Nó chỉ
chạm `symbol_analyses` và `symbol_analysis_setups` — bảng kết quả phân tích, thứ khách đọc để
tham khảo. Tín hiệu thật (marker trên biểu đồ, Telegram, thống kê BR-843) chỉ sinh ra từ
`POST /admin/signals`, do một nhân viên có quyền `signal.create` bấm.

Hai điều về kích thước kết quả, cả hai đều đã làm hỏng bản thử đầu tiên nếu bỏ qua:

* Claude Code cảnh báo khi một kết quả MCP vượt 10.000 token và **cắt ở 25.000**
  (`MAX_MCP_OUTPUT_TOKENS`, được nâng lên 50.000 cho tiến trình phân tích). Cắt xảy ra âm thầm,
  giữa câu. Nên bối cảnh chiến lược (tài liệu) đi riêng qua `lay_boi_canh_chien_luoc`, nến đi
  riêng qua `lay_viec_phan_tich`. Gộp chung là chắc chắn bị cắt.
* Mỗi tool mở `session_scope()` **riêng**. Tiến trình MCP sống suốt cả lượt và mô hình có thể
  nghĩ vài phút giữa hai lời gọi; giữ một transaction xuyên suốt quãng đó sẽ khoá bảng và làm
  hỏng phiên khi kết nối MySQL bị đứt vì `wait_timeout`.
"""

# Cố ý KHÔNG `from __future__ import annotations`: FastMCP đọc chú thích kiểu của hàm tool
# bằng `inspect` để sinh JSON Schema, và với annotation hoãn (dạng chuỗi) nó vỡ ngay lúc đăng ký
# tool. Mọi module khác trong dự án đều có dòng đó — đây là ngoại lệ duy nhất và có lý do.

import json
import logging
import sys
from pathlib import Path

# Tự nạp thư mục `backend` vào `sys.path` TRƯỚC khi import bất cứ thứ gì thuộc `app`.
#
# Claude Desktop **bỏ qua khoá `cwd`** trong `claude_desktop_config.json`: nó khởi động tiến
# trình con ở thư mục của chính nó, nên `-m app.mcp.server` chết ngay với
# `ModuleNotFoundError: No module named 'app'` — và phía giao diện chỉ hiện "Server
# disconnected", không kèm dòng lỗi nào.
_BACKEND_DIR = Path(__file__).resolve().parents[2]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from mcp.server import FastMCP  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.database import session_scope  # noqa: E402
from app.models.analysis import SymbolAnalysis  # noqa: E402
from app.models.strategy import Strategy  # noqa: E402
from app.services.analysis import documents as doc_service  # noqa: E402
from app.services.analysis import market_ai  # noqa: E402
from app.services.analysis import ondemand  # noqa: E402

# stdio là kênh truyền của giao thức — mọi thứ in ra stdout sẽ làm hỏng khung tin JSON-RPC.
# Đẩy toàn bộ log sang stderr trước khi bất cứ thứ gì kịp ghi.
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
log = logging.getLogger("stock-analysis-mcp")

mcp = FastMCP("stock-analysis")


def _json(payload) -> str:
    """Kết quả tool luôn là JSON gọn, `ensure_ascii=False` để giữ nguyên tiếng Việt."""
    return json.dumps(payload, ensure_ascii=False, default=str)


@mcp.tool()
def lay_boi_canh_chien_luoc(strategy_id: int) -> str:
    """Lấy bối cảnh của một chiến lược: tên, trường phái, tóm tắt quy tắc và toàn văn tài liệu.

    Gọi **trước** `lay_viec_phan_tich`. Đây là căn cứ để viết nhận định: lý do vào lệnh phải bám
    vào tài liệu này chứ không phải kiến thức chung về phân tích kỹ thuật.

    `documents_skipped` liệt kê tài liệu không bóc được chữ, `documents[].truncated` cho biết
    tài liệu nào bị cắt vì quá dài. Nếu phần lớn tài liệu vắng mặt thì hãy nói thẳng trong
    `rationale` rằng căn cứ còn mỏng, thay vì viết như thể đã đọc đủ.
    """
    with session_scope() as db:
        strategy = db.get(Strategy, strategy_id)
        if not strategy:
            return _json({"ok": False, "loi": f"Không tìm thấy chiến lược #{strategy_id}"})

        context = doc_service.strategy_context(db, strategy_id)
        return _json(
            {
                "ok": True,
                "strategy_id": strategy.id,
                "code": strategy.code,
                "name": strategy.name,
                "kind": strategy.kind,
                "school": strategy.school,
                "timeframe": strategy.timeframe,
                "description": strategy.description,
                "rules_summary": strategy.rules_summary,
                "documents": context["documents"],
                "documents_skipped": context["skipped"],
                "documents_text": context["text"],
            }
        )


@mcp.tool()
def lay_viec_phan_tich(analysis_id: int) -> str:
    """Lấy dữ liệu của một lượt phân tích: mã, ngày, nến, và bộ chỉ báo (nếu có).

    `candles` là CSV `date,open,high,low,close,volume` theo thứ tự thời gian tăng dần, phiên
    cuối cùng là phiên mới nhất.

    Hai loại lượt chạy, phân biệt bằng `strategy_id`:

    * **Có `strategy_id`** — phân tích theo chiến lược. Gọi `lay_boi_canh_chien_luoc` trước để
      đọc tài liệu, rồi đối chiếu với nến.
    * **`strategy_id` là null** — phân tích theo biểu đồ ở màn bảng giá. Căn cứ nằm ở
      `indicators`: đúng những chỉ báo người dùng đang bật, kèm giá trị gần nhất của chúng theo
      từng ngày. Bám vào chúng mà viết, và **đừng** gọi `lay_boi_canh_chien_luoc`.

    Đọc xong thì gọi `luu_ket_qua_phan_tich` đúng một lần. Không phân tích được thì gọi
    `bao_loi`. Đừng bỏ việc ở trạng thái chờ: người dùng đang mở màn hình và đợi kết quả này.
    """
    with session_scope() as db:
        item = db.get(SymbolAnalysis, analysis_id)
        if not item:
            return _json({"ok": False, "loi": f"Không tìm thấy lượt phân tích #{analysis_id}"})

        payload = {
            "ok": True,
            "analysis_id": item.id,
            "strategy_id": item.strategy_id,
            "symbol": item.symbol,
            "analysis_date": item.analysis_date.isoformat(),
            "candles": ondemand.candles_csv(db, item.symbol),
        }
        if item.strategy_id is None:
            payload["indicators"] = market_ai.indicators_text(item)
        return _json(payload)


#: Giá trị "rỗng" mà mô hình hay gửi thay cho việc bỏ trống hẳn một tham số.
_EMPTY = ("", "null", "none", "[]", "{}")


def _structured(value, name: str):
    """Nhận tham số có cấu trúc dù mô hình gửi kiểu nào.

    Mô hình gửi `setups` là **mảng thật** trong JSON của lời gọi tool — đó là hành vi tự nhiên
    khi mô tả tham số bày ra một danh sách đối tượng. Bản đầu khai kiểu `str` nên pydantic chặn
    ngay ở tầng khung ("Input should be a valid string"), mô hình không lưu được kết quả, thử
    lại bằng đủ kiểu escape rồi hết giờ — mất hàng chục phút của khách đang ngồi đợi.

    Nên khai kiểu hợp: mảng/đối tượng đi thẳng, còn chuỗi JSON vẫn nhận để không phụ thuộc vào
    việc mô hình chọn cách nào.
    """
    if value is None:
        return None
    if isinstance(value, str):
        if value.strip().lower() in _EMPTY:
            return None
        try:
            return json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{name} không phải JSON hợp lệ: {exc}") from exc
    return value


@mcp.tool()
def luu_ket_qua_phan_tich(
    analysis_id: int,
    title: str,
    summary: str,
    rationale: str,
    setups: list[dict] | str | None = None,
    evidence: dict | str | None = None,
) -> str:
    """Ghi kết quả phân tích. Gọi **đúng một lần** cho mỗi lượt.

    `setups` là **danh sách** kịch bản vào lệnh — gửi thẳng mảng JSON, không bọc trong chuỗi.
    Liệt kê mọi kịch bản mà tài liệu chiến lược cho phép — cả chiều MUA lẫn chiều BÁN nếu cả
    hai đều có căn cứ. Mảng rỗng `[]` là kết quả hợp lệ khi phiên này không có điểm vào; đừng
    bịa ra một điểm vào chỉ để danh sách không trống.

    Riêng lượt phân tích theo biểu đồ (lượt không gắn chiến lược nào): **tối đa một kịch bản
    MUA và một kịch bản BÁN**. Gửi dư thì máy chủ tự giữ lại cái có `confidence` cao nhất của
    mỗi chiều và bỏ phần còn lại — tự chọn trước khi gửi thì bạn còn được chọn.

    Mỗi phần tử:
      {"direction": "BUY"|"SELL", "entry_price": số, "sl": số|null, "tp": số|null,
       "confidence": "LOW"|"MEDIUM"|"HIGH", "note": "điều kiện kích hoạt, một hai câu"}

    Ràng buộc chiều lệnh được kiểm ngay tại đây: BUY cần sl < entry < tp, SELL cần tp < entry
    < sl. Sai thì tool trả lỗi và bạn sửa lại rồi gọi lại — lúc này bạn còn đang cầm dữ liệu.

    `title`, `summary` (HTML ngắn) và `rationale` (văn bản thuần) **khách hàng đều đọc được**:
    không trích nguyên văn tài liệu, không nêu tên quy tắc hay tham số bộ lọc. `evidence` là
    chỗ duy nhất được ghi số liệu thô và tên quy tắc — trường đó chỉ nội bộ đọc.
    """
    try:
        setups = _structured(setups, "setups") or []
    except ValueError as exc:
        return _json({"ok": False, "loi": str(exc)})
    if not isinstance(setups, list):
        return _json({"ok": False, "loi": "setups phải là một mảng"})

    try:
        evidence = _structured(evidence, "evidence")
    except ValueError:
        # Bằng chứng hỏng định dạng không đáng để vứt cả bản phân tích — giữ nguyên văn.
        evidence = {"raw": evidence}

    try:
        with session_scope() as db:
            item = ondemand.save_result(
                db,
                analysis_id,
                title=title,
                summary=summary,
                rationale=rationale,
                setups=setups,
                evidence=evidence,
            )
            return _json(
                {"ok": True, "analysis_id": item.id, "status": item.status,
                 "so_kich_ban": len(setups)}
            )
    except Exception as exc:  # noqa: BLE001 — trả lỗi cho mô hình sửa, không làm chết server
        return _json({"ok": False, "loi": str(getattr(exc, "message", None) or exc)})


@mcp.tool()
def bao_loi(analysis_id: int, ly_do: str) -> str:
    """Đánh dấu một lượt phân tích là không làm được, kèm lý do.

    Dùng khi mã thiếu nến, dữ liệu bất thường, hoặc tài liệu chiến lược không đủ căn cứ. Lý do
    ghi ở đây hiện thẳng ra màn hình của người đang chờ, nên viết cho họ đọc chứ không phải cho
    lập trình viên.
    """
    with session_scope() as db:
        item = ondemand.fail(db, analysis_id, ly_do)
        if not item:
            return _json({"ok": False, "loi": f"Không tìm thấy lượt phân tích #{analysis_id}"})
        return _json({"ok": True, "analysis_id": item.id, "status": item.status})


def main() -> None:
    log.info("MCP stock-analysis khởi động (stdio), DB=%s", settings.db_name)
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
