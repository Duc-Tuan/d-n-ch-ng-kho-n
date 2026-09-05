"""Danh mục mã **hạt giống** — chỉ dùng để đổ dữ liệu cho lần dựng hệ thống đầu tiên.

> **Đây không còn là nguồn sự thật.** Nguồn sự thật của danh mục theo dõi là bảng `symbols`.
> Thêm/bớt/sửa mã làm ở Quản trị → *Dữ liệu thị trường → Danh mục mã*; sửa file này không ảnh
> hưởng gì tới hệ thống đang chạy.

Toàn thị trường có hơn 1.500 mã, phần lớn thanh khoản quá thấp để vào lệnh theo tín hiệu:
đặt một lệnh vừa phải cũng đủ làm lệch giá. Hệ thống chỉ theo dõi danh sách chọn lọc.

Tier phản ánh mức độ phù hợp để giao dịch theo tín hiệu, do bộ phận phân tích xếp:
  * ``A`` — thanh khoản tốt, biên độ đủ rộng, ưu tiên vào lệnh.
  * ``B`` — giao dịch được, cần cân nhắc khối lượng.
  * ``C`` — theo dõi tham khảo, hạn chế vào lệnh.

Giá trị còn lại của file: dựng lại môi trường mới (`python -m app.scripts.sync_symbol_universe`)
và ghi nhận danh sách 150 mã ban đầu do bộ phận phân tích chọn.
"""

from __future__ import annotations

from typing import NamedTuple


class UniverseSymbol(NamedTuple):
    symbol: str
    exchange: str  # HOSE | HNX | UPCOM
    industry: str
    tier: str  # A | B | C


#: 150 mã, xếp theo nhóm ngành. Thứ tự trong danh sách chính là thứ tự ưu tiên khi rà soát.
SYMBOL_UNIVERSE: tuple[UniverseSymbol, ...] = (
    # ---- 1. Ngân hàng (20) --------------------------------------------
    UniverseSymbol("VCB", "HOSE", "Ngân hàng", "B"),
    UniverseSymbol("BID", "HOSE", "Ngân hàng", "B"),
    UniverseSymbol("CTG", "HOSE", "Ngân hàng", "B"),
    UniverseSymbol("TCB", "HOSE", "Ngân hàng", "A"),
    UniverseSymbol("MBB", "HOSE", "Ngân hàng", "A"),
    UniverseSymbol("VPB", "HOSE", "Ngân hàng", "A"),
    UniverseSymbol("ACB", "HOSE", "Ngân hàng", "B"),
    UniverseSymbol("HDB", "HOSE", "Ngân hàng", "B"),
    UniverseSymbol("STB", "HOSE", "Ngân hàng", "A"),
    UniverseSymbol("SHB", "HOSE", "Ngân hàng", "A"),
    UniverseSymbol("VIB", "HOSE", "Ngân hàng", "A"),
    UniverseSymbol("TPB", "HOSE", "Ngân hàng", "A"),
    UniverseSymbol("LPB", "HOSE", "Ngân hàng", "A"),
    UniverseSymbol("MSB", "HOSE", "Ngân hàng", "A"),
    UniverseSymbol("OCB", "HOSE", "Ngân hàng", "B"),
    UniverseSymbol("EIB", "HOSE", "Ngân hàng", "A"),
    UniverseSymbol("SSB", "HOSE", "Ngân hàng", "B"),
    UniverseSymbol("NAB", "HOSE", "Ngân hàng", "B"),
    UniverseSymbol("ABB", "UPCOM", "Ngân hàng", "C"),
    UniverseSymbol("NVB", "HNX", "Ngân hàng", "C"),
    # ---- 2. Chứng khoán (14) ------------------------------------------
    UniverseSymbol("SSI", "HOSE", "Chứng khoán", "A"),
    UniverseSymbol("VND", "HOSE", "Chứng khoán", "A"),
    UniverseSymbol("VCI", "HOSE", "Chứng khoán", "A"),
    UniverseSymbol("HCM", "HOSE", "Chứng khoán", "A"),
    UniverseSymbol("VIX", "HOSE", "Chứng khoán", "A"),
    UniverseSymbol("SHS", "HNX", "Chứng khoán", "A"),
    UniverseSymbol("MBS", "HNX", "Chứng khoán", "A"),
    UniverseSymbol("ORS", "HOSE", "Chứng khoán", "A"),
    UniverseSymbol("FTS", "HOSE", "Chứng khoán", "B"),
    UniverseSymbol("BSI", "HOSE", "Chứng khoán", "B"),
    UniverseSymbol("CTS", "HOSE", "Chứng khoán", "B"),
    UniverseSymbol("AGR", "HOSE", "Chứng khoán", "C"),
    UniverseSymbol("VDS", "HOSE", "Chứng khoán", "C"),
    # DSC đã chuyển sang HOSE — danh sách gốc ghi HNX, lấy theo dữ liệu niêm yết hiện tại.
    UniverseSymbol("DSC", "HOSE", "Chứng khoán", "C"),
    # ---- 3. Bất động sản nhà ở (14) -----------------------------------
    UniverseSymbol("VIC", "HOSE", "Bất động sản nhà ở", "B"),
    UniverseSymbol("VHM", "HOSE", "Bất động sản nhà ở", "B"),
    UniverseSymbol("VRE", "HOSE", "Bất động sản nhà ở", "B"),
    UniverseSymbol("NVL", "HOSE", "Bất động sản nhà ở", "A"),
    UniverseSymbol("PDR", "HOSE", "Bất động sản nhà ở", "A"),
    UniverseSymbol("DXG", "HOSE", "Bất động sản nhà ở", "A"),
    UniverseSymbol("DIG", "HOSE", "Bất động sản nhà ở", "A"),
    UniverseSymbol("KDH", "HOSE", "Bất động sản nhà ở", "B"),
    UniverseSymbol("NLG", "HOSE", "Bất động sản nhà ở", "B"),
    UniverseSymbol("HDG", "HOSE", "Bất động sản nhà ở", "C"),
    UniverseSymbol("CEO", "HNX", "Bất động sản nhà ở", "A"),
    UniverseSymbol("TCH", "HOSE", "Bất động sản nhà ở", "B"),
    UniverseSymbol("HQC", "HOSE", "Bất động sản nhà ở", "A"),
    UniverseSymbol("SCR", "HOSE", "Bất động sản nhà ở", "A"),
    # ---- 4. Bất động sản khu công nghiệp (8) --------------------------
    UniverseSymbol("BCM", "HOSE", "Bất động sản KCN", "C"),
    UniverseSymbol("KBC", "HOSE", "Bất động sản KCN", "A"),
    UniverseSymbol("IDC", "HNX", "Bất động sản KCN", "B"),
    UniverseSymbol("SZC", "HOSE", "Bất động sản KCN", "B"),
    UniverseSymbol("SIP", "HOSE", "Bất động sản KCN", "B"),
    UniverseSymbol("VGC", "HOSE", "Bất động sản KCN", "B"),
    UniverseSymbol("LHG", "HOSE", "Bất động sản KCN", "C"),
    UniverseSymbol("TIP", "HOSE", "Bất động sản KCN", "C"),
    # ---- 5. Xây dựng & Hạ tầng (9) ------------------------------------
    UniverseSymbol("HHV", "HOSE", "Xây dựng & Hạ tầng", "A"),
    UniverseSymbol("VCG", "HOSE", "Xây dựng & Hạ tầng", "B"),
    UniverseSymbol("CTD", "HOSE", "Xây dựng & Hạ tầng", "C"),
    UniverseSymbol("C4G", "UPCOM", "Xây dựng & Hạ tầng", "A"),  # danh sách gốc ghi HNX
    UniverseSymbol("LCG", "HOSE", "Xây dựng & Hạ tầng", "B"),
    UniverseSymbol("FCN", "HOSE", "Xây dựng & Hạ tầng", "B"),
    UniverseSymbol("PC1", "HOSE", "Xây dựng & Hạ tầng", "C"),
    UniverseSymbol("CII", "HOSE", "Xây dựng & Hạ tầng", "C"),
    UniverseSymbol("HUT", "HNX", "Xây dựng & Hạ tầng", "C"),
    # ---- 6. Vật liệu xây dựng (3) -------------------------------------
    UniverseSymbol("HT1", "HOSE", "Vật liệu xây dựng", "B"),
    UniverseSymbol("KSB", "HOSE", "Vật liệu xây dựng", "B"),
    UniverseSymbol("BCC", "HNX", "Vật liệu xây dựng", "C"),
    # ---- 7. Thép & Kim loại (8) ---------------------------------------
    UniverseSymbol("HPG", "HOSE", "Thép & Kim loại", "A"),
    UniverseSymbol("HSG", "HOSE", "Thép & Kim loại", "A"),
    UniverseSymbol("NKG", "HOSE", "Thép & Kim loại", "A"),
    UniverseSymbol("SMC", "HOSE", "Thép & Kim loại", "A"),
    UniverseSymbol("TLH", "HOSE", "Thép & Kim loại", "A"),
    UniverseSymbol("TVN", "UPCOM", "Thép & Kim loại", "B"),
    UniverseSymbol("VGS", "HNX", "Thép & Kim loại", "B"),
    UniverseSymbol("HMC", "HOSE", "Thép & Kim loại", "C"),
    # ---- 8. Hóa chất (4) ----------------------------------------------
    UniverseSymbol("DCM", "HOSE", "Hóa chất", "B"),
    UniverseSymbol("DPM", "HOSE", "Hóa chất", "B"),
    UniverseSymbol("AAA", "HOSE", "Hóa chất", "B"),
    UniverseSymbol("CSV", "HOSE", "Hóa chất", "C"),
    # ---- 9. Dầu khí (9) -----------------------------------------------
    UniverseSymbol("GAS", "HOSE", "Dầu khí", "B"),
    UniverseSymbol("PLX", "HOSE", "Dầu khí", "B"),
    UniverseSymbol("BSR", "HOSE", "Dầu khí", "A"),
    UniverseSymbol("PVS", "HNX", "Dầu khí", "A"),
    UniverseSymbol("PVD", "HOSE", "Dầu khí", "A"),
    UniverseSymbol("PVT", "HOSE", "Dầu khí", "B"),
    UniverseSymbol("OIL", "UPCOM", "Dầu khí", "C"),
    UniverseSymbol("PVC", "HNX", "Dầu khí", "C"),
    UniverseSymbol("PVB", "HNX", "Dầu khí", "C"),
    # ---- 10. Điện & Năng lượng (8) ------------------------------------
    UniverseSymbol("POW", "HOSE", "Điện & Năng lượng", "A"),
    UniverseSymbol("REE", "HOSE", "Điện & Năng lượng", "B"),
    UniverseSymbol("GEX", "HOSE", "Điện & Năng lượng", "A"),
    UniverseSymbol("PGV", "HOSE", "Điện & Năng lượng", "B"),
    UniverseSymbol("NT2", "HOSE", "Điện & Năng lượng", "B"),
    UniverseSymbol("GEG", "HOSE", "Điện & Năng lượng", "B"),
    UniverseSymbol("VSH", "HOSE", "Điện & Năng lượng", "C"),
    UniverseSymbol("QTP", "UPCOM", "Điện & Năng lượng", "C"),
    # ---- 11. Bán lẻ & Tiêu dùng (11) ----------------------------------
    UniverseSymbol("MWG", "HOSE", "Bán lẻ & Tiêu dùng", "A"),
    UniverseSymbol("MSN", "HOSE", "Bán lẻ & Tiêu dùng", "B"),
    UniverseSymbol("VNM", "HOSE", "Bán lẻ & Tiêu dùng", "C"),
    UniverseSymbol("SAB", "HOSE", "Bán lẻ & Tiêu dùng", "C"),
    UniverseSymbol("FRT", "HOSE", "Bán lẻ & Tiêu dùng", "B"),
    UniverseSymbol("DGW", "HOSE", "Bán lẻ & Tiêu dùng", "B"),
    UniverseSymbol("PET", "HOSE", "Bán lẻ & Tiêu dùng", "C"),
    UniverseSymbol("KDC", "HOSE", "Bán lẻ & Tiêu dùng", "C"),
    UniverseSymbol("QNS", "UPCOM", "Bán lẻ & Tiêu dùng", "C"),
    UniverseSymbol("MCH", "HOSE", "Bán lẻ & Tiêu dùng", "C"),  # danh sách gốc ghi UPCOM
    UniverseSymbol("HAX", "HOSE", "Bán lẻ & Tiêu dùng", "B"),
    # ---- 12. Dược phẩm (1) --------------------------------------------
    UniverseSymbol("DBD", "HOSE", "Dược phẩm", "C"),
    # ---- 13. Công nghệ & Viễn thông (7) -------------------------------
    UniverseSymbol("FPT", "HOSE", "Công nghệ & Viễn thông", "A"),
    UniverseSymbol("CMG", "HOSE", "Công nghệ & Viễn thông", "B"),
    UniverseSymbol("VGI", "UPCOM", "Công nghệ & Viễn thông", "B"),
    UniverseSymbol("CTR", "HOSE", "Công nghệ & Viễn thông", "B"),
    UniverseSymbol("ELC", "HOSE", "Công nghệ & Viễn thông", "B"),
    UniverseSymbol("SAM", "HOSE", "Công nghệ & Viễn thông", "C"),
    UniverseSymbol("ITD", "HOSE", "Công nghệ & Viễn thông", "C"),
    # ---- 14. Logistics & Cảng biển (7) --------------------------------
    UniverseSymbol("GMD", "HOSE", "Logistics & Cảng biển", "B"),
    UniverseSymbol("VSC", "HOSE", "Logistics & Cảng biển", "B"),
    UniverseSymbol("HAH", "HOSE", "Logistics & Cảng biển", "B"),
    UniverseSymbol("VTP", "HOSE", "Logistics & Cảng biển", "B"),
    UniverseSymbol("VOS", "HOSE", "Logistics & Cảng biển", "C"),
    UniverseSymbol("VIP", "HOSE", "Logistics & Cảng biển", "C"),
    UniverseSymbol("PHP", "UPCOM", "Logistics & Cảng biển", "C"),  # danh sách gốc ghi HNX
    # ---- 15. Hàng không & Du lịch (3) ---------------------------------
    UniverseSymbol("HVN", "HOSE", "Hàng không & Du lịch", "B"),
    UniverseSymbol("VJC", "HOSE", "Hàng không & Du lịch", "B"),
    UniverseSymbol("ACV", "UPCOM", "Hàng không & Du lịch", "C"),
    # ---- 16. Thủy sản (5) ---------------------------------------------
    UniverseSymbol("VHC", "HOSE", "Thủy sản", "B"),
    UniverseSymbol("ANV", "HOSE", "Thủy sản", "B"),
    UniverseSymbol("IDI", "HOSE", "Thủy sản", "B"),
    UniverseSymbol("ASM", "HOSE", "Thủy sản", "C"),
    UniverseSymbol("FMC", "HOSE", "Thủy sản", "C"),
    # ---- 17. Dệt may & Da giày (4) ------------------------------------
    UniverseSymbol("TNG", "HNX", "Dệt may & Da giày", "B"),
    UniverseSymbol("MSH", "HOSE", "Dệt may & Da giày", "C"),
    UniverseSymbol("TCM", "HOSE", "Dệt may & Da giày", "C"),
    UniverseSymbol("VGT", "UPCOM", "Dệt may & Da giày", "C"),
    # ---- 18. Cao su (3) -----------------------------------------------
    UniverseSymbol("GVR", "HOSE", "Cao su", "C"),
    UniverseSymbol("DRC", "HOSE", "Cao su", "B"),
    UniverseSymbol("PHR", "HOSE", "Cao su", "C"),
    # ---- 19. Phân bón & Nông nghiệp (6) -------------------------------
    UniverseSymbol("DBC", "HOSE", "Phân bón & Nông nghiệp", "B"),
    UniverseSymbol("HAG", "HOSE", "Phân bón & Nông nghiệp", "B"),
    UniverseSymbol("BAF", "HOSE", "Phân bón & Nông nghiệp", "B"),
    UniverseSymbol("BFC", "HOSE", "Phân bón & Nông nghiệp", "C"),
    UniverseSymbol("LAS", "HNX", "Phân bón & Nông nghiệp", "C"),
    UniverseSymbol("SBT", "HOSE", "Phân bón & Nông nghiệp", "C"),
    # ---- 20-23. Bảo hiểm / Dịch vụ tài chính / Nước / Khác (6) --------
    UniverseSymbol("BVH", "HOSE", "Bảo hiểm", "C"),
    UniverseSymbol("MIG", "HOSE", "Bảo hiểm", "C"),
    UniverseSymbol("EVF", "HOSE", "Dịch vụ tài chính khác", "C"),
    UniverseSymbol("TVC", "HNX", "Dịch vụ tài chính khác", "C"),
    UniverseSymbol("BWE", "HOSE", "Nước & Môi trường", "C"),
    UniverseSymbol("HHS", "HOSE", "Khác", "C"),
)

#: Tra cứu nhanh theo mã — dùng ở đường đi nóng của `sync_symbols`.
UNIVERSE_BY_SYMBOL: dict[str, UniverseSymbol] = {u.symbol: u for u in SYMBOL_UNIVERSE}

#: Tập mã hợp lệ. Mọi chỗ cần hỏi "mã này có được theo dõi không" đều dùng biến này.
UNIVERSE_SYMBOLS: frozenset[str] = frozenset(UNIVERSE_BY_SYMBOL)

# Trùng mã trong danh sách là lỗi soạn dữ liệu: bản ghi sau sẽ lặng lẽ đè bản ghi trước ở
# `UNIVERSE_BY_SYMBOL`, và số mã thực tế trong hệ thống ít hơn danh sách mà không ai biết.
assert len(UNIVERSE_BY_SYMBOL) == len(SYMBOL_UNIVERSE), "Danh mục mã có mã trùng"
