"""Sinh cấu hình MCP cho `claude -p` và cho Claude Desktop.

    python -m app.scripts.write_mcp_config

Vì sao phải sinh ra thay vì viết tay một lần:

**Trên Windows, `CreateProcess` không giải được đường dẫn tương đối làm `command`.** File có thật
(`os.path.exists` trả True) nhưng tiến trình vẫn chết với `WinError 2`, và phía client chỉ thấy
"Server disconnected" — không có dòng lỗi nào chỉ ra nguyên nhân. Nên `command` **bắt buộc** là
đường dẫn tuyệt đối.

Đường dẫn tuyệt đối lại gắn chặt với máy và với vị trí thư mục dự án. Viết tay là chép nhầm hoặc
quên cập nhật sau khi di chuyển dự án; sinh từ `sys.executable` thì luôn trỏ đúng chính trình
Python đang chạy backend — cũng là trình duy nhất có `sqlalchemy`, `pymysql` và `mcp`.

Chạy lại script này sau khi: đổi vị trí thư mục dự án, tạo lại `.venv`, hoặc cài trên máy mới.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from app.core.config import BASE_DIR

#: Thư mục gốc dự án — `BASE_DIR` là thư mục `backend`.
PROJECT_ROOT = BASE_DIR.parent

CONFIG_PATH = PROJECT_ROOT / ".claude" / "mcp-analysis.json"
EXAMPLE_PATH = PROJECT_ROOT / ".claude" / "mcp-analysis.example.json"


def build() -> dict:
    return {
        "mcpServers": {
            "stock-analysis": {
                # Tuyệt đối, không tương đối — xem giải thích ở đầu file.
                "command": str(Path(sys.executable).resolve()),
                # Đường dẫn file, **không** dùng `-m app.mcp.server`: Claude Desktop bỏ qua khoá
                # `cwd`, nên dạng `-m` chết với `ModuleNotFoundError: No module named 'app'`.
                # `server.py` tự nạp thư mục `backend` vào `sys.path` nên chạy được ở mọi cwd.
                "args": [str((BASE_DIR / "app" / "mcp" / "server.py").resolve())],
                # Vẫn giữ cho client nào có tôn trọng nó (Claude Code thì có).
                "cwd": str(BASE_DIR.resolve()),
                "env": {
                    # stdio là kênh truyền giao thức; thiếu dòng này thì tiếng Việt trong kết quả
                    # tool làm vỡ khung tin JSON-RPC trên console mã cp1258 của Windows.
                    "PYTHONIOENCODING": "utf-8",
                    "PYTHONUNBUFFERED": "1",
                    # Thắt lưng thêm dây an toàn: kể cả khi `sys.path` tự nạp có vấn đề.
                    "PYTHONPATH": str(BASE_DIR.resolve()),
                },
            }
        }
    }


def main() -> None:
    config = build()
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(config, ensure_ascii=False, indent=2) + "\n"

    # Cùng một nội dung cho cả hai: `claude -p` đọc file trong dự án, còn Claude Desktop cần
    # người dùng chép tay sang `claude_desktop_config.json`.
    CONFIG_PATH.write_text(payload, encoding="utf-8")
    EXAMPLE_PATH.write_text(payload, encoding="utf-8")

    print(f"Đã ghi: {CONFIG_PATH}")
    print(f"Đã ghi: {EXAMPLE_PATH}")
    print()
    print("Cho Claude Desktop — chép khối dưới vào claude_desktop_config.json")
    print(r"   (%APPDATA%\Claude\claude_desktop_config.json), rồi Quit hẳn app và mở lại:")
    print()
    print(payload)


if __name__ == "__main__":
    main()
