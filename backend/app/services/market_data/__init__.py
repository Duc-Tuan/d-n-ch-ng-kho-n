"""Dữ liệu thị trường — Phần 12.

Ứng dụng chỉ dùng những gì export ở đây, không import thẳng từ `providers.py`.
"""

from app.services.market_data.base import (
    Bar,
    MarketDataError,
    MarketDataProvider,
    SymbolInfo,
)
from app.services.market_data import fullsync
from app.services.market_data.providers import attribution, get_provider
from app.services.market_data.service import (
    add_symbol,
    coverage_stats,
    get_candles,
    get_price_board,
    list_symbol_codes,
    lookup_listing,
    remove_symbol,
    search_symbols,
    sync_ohlcv,
    sync_ohlcv_batch,
    sync_symbols,
)

__all__ = [
    "Bar",
    "SymbolInfo",
    "MarketDataProvider",
    "MarketDataError",
    "get_provider",
    "attribution",
    "sync_symbols",
    "sync_ohlcv",
    "sync_ohlcv_batch",
    "get_candles",
    "search_symbols",
    "list_symbol_codes",
    "get_price_board",
    "lookup_listing",
    "add_symbol",
    "remove_symbol",
    "coverage_stats",
    "fullsync",
]
