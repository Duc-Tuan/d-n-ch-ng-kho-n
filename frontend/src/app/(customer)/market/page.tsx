'use client';

import { useEffect, useMemo, useState } from 'react';

import { MarketAnalysisPanel } from '@/components/domain/MarketAnalysisPanel';
import { PriceChart } from '@/components/domain/PriceChart';
import { withLiveQuote } from '@/components/domain/chart/candles';
import { useIndicators } from '@/components/domain/chart/useIndicators';
import {
  Card,
  Disclaimer,
  EmptyState,
  SearchInput,
  Spinner,
  Tabs,
} from '@/components/ui';
import { useApiQuery, useFlash, useMarketRealtime } from '@/hooks';
import { CUSTOMER } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/datetime';
import { formatNumber, formatPercent, formatPrice } from '@/lib/format';
import type {
  AssetClass,
  Candle,
  OhlcvResponse,
  PriceBoardItem,
  PriceBoardResponse,
  SymbolInfo,
} from '@/types';

/**
 * Trục thứ nhất: **loại tài sản**.
 *
 * Trước đây hàng tab đầu tiên là ba sàn HOSE · HNX · UPCOM, và đó là cách phân loại của *sở giao
 * dịch* chứ không phải của người dùng. Người mở bảng giá lên biết mình định xem cổ phiếu hay xem
 * hợp đồng phái sinh trước khi biết mình quan tâm sàn nào — nhiều người không bao giờ nghĩ tới
 * sàn. Sàn tụt xuống hàng thứ hai, làm bộ lọc bên trong tab Chứng khoán.
 */
const ASSET_TABS: Array<{ key: AssetClass; label: string }> = [
  { key: 'STOCK', label: 'Chứng khoán' },
  { key: 'DERIVATIVE', label: 'Phái sinh' },
];

/**
 * Trục thứ hai: **sàn niêm yết**, chỉ có nghĩa với cổ phiếu.
 *
 * Khoá rỗng là "tất cả" và là mặc định. Bản trước mở thẳng vào HOSE, nghĩa là người dùng không
 * bao giờ thấy mã HNX/UPCOM trừ khi họ tự đổi tab — trong khi danh mục theo dõi có đủ cả ba sàn.
 */
const EXCHANGES = [
  { key: '', label: 'Tất cả' },
  { key: 'HOSE', label: 'HOSE' },
  { key: 'HNX', label: 'HNX' },
  { key: 'UPCOM', label: 'UPCOM' },
];

/** Hợp đồng mặc định khi mở tab Phái sinh — tháng gần nhất là hợp đồng thanh khoản nhất. */
const DEFAULT_DERIVATIVE = 'VN30F1M';
const DEFAULT_STOCK = 'HPG';

/**
 * Màu theo quy ước thị trường Việt Nam: **tím trần · xanh lam sàn** · tăng xanh lá · giảm đỏ ·
 * tham chiếu vàng.
 *
 * Trần và sàn phải xét **trước** dấu của thay đổi giá, vì một mã kịch trần cũng là một mã tăng
 * — xét theo thứ tự ngược lại thì màu tím không bao giờ xuất hiện. Đây là hai màu mà người đọc
 * bảng giá Việt Nam quét tìm đầu tiên, và trước khi có dữ liệu trần/sàn thì hệ thống không có
 * cách nào phân biệt được.
 */
function priceClass(row: Pick<PriceBoardItem, 'change' | 'at_ceiling' | 'at_floor'>): string {
  if (row.at_ceiling) return 'text-ceil';
  if (row.at_floor) return 'text-floor';
  const change = row.change;
  if (change === null || change === undefined || change === 0) return 'text-ref';
  return change > 0 ? 'text-up' : 'text-down';
}

/**
 * Nền nháy một nhịp khi giá vừa đổi.
 *
 * Chỉ nháy **ô giá**, không nháy cả dòng: sáu mươi dòng cùng đổi nền liên tục là thứ người dùng
 * tắt đi chứ không phải thứ họ đọc.
 */
function flashClass(direction: 'up' | 'down' | undefined): string {
  if (!direction) return '';
  return direction === 'up' ? 'bg-up/20' : 'bg-down/20';
}

/**
 * Nền mờ cùng sắc cho ô thay đổi giá.
 *
 * Chỉ tô chữ là chưa đủ để quét nhanh một bảng sáu mươi dòng: mắt phải đọc từng con số mới
 * biết dòng nào tăng dòng nào giảm. Một mảng nền — dù rất nhạt — cho hình dạng để nhận ra
 * trước cả khi đọc, và ở nền tối thì mảng nền còn nổi hơn hẳn so với nét chữ mảnh.
 */
function changeChipClass(change: number | null | undefined): string {
  if (change === null || change === undefined || change === 0) return 'bg-ref/10 text-ref';
  return change > 0 ? 'bg-up/10 text-up' : 'bg-down/10 text-down';
}

export default function MarketPage() {
  const [assetClass, setAssetClass] = useState<AssetClass>('STOCK');
  /** Rỗng nghĩa là mọi sàn. Chỉ áp dụng cho cổ phiếu — phái sinh chỉ có một sàn. */
  const [exchange, setExchange] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(DEFAULT_STOCK);

  /**
   * Biểu đồ đang phóng to kín màn hình hay không.
   *
   * Cần biết ở đây vì lúc đó phần phân tích **chuyển chỗ** — sang cột phải của lớp phủ. Dựng nó ở
   * cả hai nơi cùng lúc thì có hai bảng phân tích cùng sống, mỗi bảng một trạng thái chờ kết quả
   * riêng, và cái nằm dưới lớp phủ chỉ tốn lượt gọi chứ không ai nhìn thấy.
   */
  const [chartExpanded, setChartExpanded] = useState(false);

  // Bộ chỉ báo giữ ở đây chứ không trong biểu đồ: cả biểu đồ lẫn nút AI phân tích bên dưới đều
  // cần đúng một bộ này — biểu đồ để vẽ, nút phân tích để gửi cho mô hình đọc.
  const indicators = useIndicators();

  /**
   * Đang tìm kiếm thì hiển thị kết quả tìm; không thì hiển thị bảng giá theo tab.
   *
   * Ô tìm kiếm cố ý **không** lọc theo tab đang mở: người gõ "VN30" trong khi đứng ở tab Chứng
   * khoán vẫn phải thấy hợp đồng phái sinh. Bắt họ đoán đúng tab trước rồi mới cho tìm là biến
   * ô tìm kiếm thành một câu đố.
   */
  const { data: found } = useApiQuery<SymbolInfo[]>(
    search.trim().length >= 1 ? `${CUSTOMER}/market/symbols` : null,
    { q: search.trim(), limit: 30 },
  );

  const { data: board, isLoading } = useApiQuery<PriceBoardResponse>(
    `${CUSTOMER}/market/board`,
    search.trim().length >= 1
      ? { symbols: (found ?? []).map((s) => s.symbol), limit: 30 }
      : {
          asset_class: assetClass,
          // Bỏ hẳn tham số khi chọn "Tất cả" thay vì gửi chuỗi rỗng: máy chủ phân biệt
          // "không lọc" với "lọc theo sàn tên là rỗng", và cái sau trả về không dòng nào.
          exchange: assetClass === 'STOCK' && exchange ? exchange : undefined,
          limit: 60,
        },
    // Đường lùi, không phải đường chính. Kênh WebSocket bên dưới mới là thứ đẩy giá; lượt gọi
    // lại này chỉ để lấy những trường kênh kia không mang (tên công ty, mã mới thêm vào danh
    // mục) và để bảng vẫn sống khi kênh rớt. Giữ 2 phút như cũ khi kênh còn chạy; kênh chết thì
    // rút xuống 15 giây để bảng vẫn nhúc nhích.
    { refreshInterval: 120_000 },
  );

  // Đúng những mã đang hiển thị — không đăng ký cả sàn cho một bảng 60 dòng.
  const visible = useMemo(
    () => (board?.items ?? []).map((row) => row.symbol),
    [board?.items],
  );

  const { quotes, connected } = useMarketRealtime(
    visible,
    Boolean(board?.realtime_enabled) && visible.length > 0,
  );
  const flash = useFlash(quotes);

  /**
   * Bảng giá sau khi phủ giá đang chạy lên.
   *
   * Máy chủ đã phủ một lần ở `/market/board`, nhưng ảnh chụp đó già đi ngay khi response rời máy
   * chủ. Phủ thêm lần nữa ở đây bằng gói tin WebSocket mới nhất là thứ làm bảng giá thật sự
   * chạy giữa hai lượt gọi API.
   */
  const rows = useMemo<PriceBoardItem[]>(() => {
    const items = board?.items ?? [];
    if (!Object.keys(quotes).length) return items;

    return items.map((row) => {
      const quote = quotes[row.symbol];
      if (!quote || quote.price === null) return row;
      return {
        ...row,
        realtime: true,
        close: quote.price,
        change: quote.change,
        change_pct: quote.change_pct,
        volume: quote.volume,
        reference: quote.reference ?? row.reference,
        ceiling: quote.ceiling,
        floor: quote.floor,
        at_ceiling: quote.ceiling !== null && quote.price >= quote.ceiling,
        at_floor: quote.floor !== null && quote.price <= quote.floor,
      };
    });
  }, [board?.items, quotes]);

  const { data: ohlcv, isLoading: chartLoading } = useApiQuery<OhlcvResponse>(
    selected ? `${CUSTOMER}/market/ohlcv` : null,
    { symbol: selected, limit: 400 },
  );

  /**
   * Nến ngày sau khi phủ giá đang chạy lên cây nến cuối — xem `withLiveQuote`.
   *
   * Cùng lý lẽ với `rows` ở trên, và là thứ giữ cho biểu đồ nói cùng một con số với bảng giá:
   * chuỗi nến chỉ được gọi lại khi đổi mã, nên không có bước phủ này thì mã AAA hiện 7,38 bên
   * trái và 7,36 trên biểu đồ.
   *
   * Phụ thuộc vào **chính gói tin của mã đang chọn** chứ không vào cả `quotes`: kho gói tin đổi
   * mỗi nhịp vì một mã bất kỳ trong sáu mươi dòng vừa khớp lệnh, và dựng lại chuỗi bốn trăm nến
   * kèm toàn bộ chỉ báo cho mỗi nhịp ấy là việc thừa.
   */
  const liveQuote = quotes[selected];
  const chartCandles = useMemo<Candle[]>(
    () => withLiveQuote(ohlcv?.candles ?? [], liveQuote),
    [ohlcv?.candles, liveQuote],
  );
  const lastCandle = chartCandles[chartCandles.length - 1];

  const defaultSymbol = assetClass === 'DERIVATIVE' ? DEFAULT_DERIVATIVE : DEFAULT_STOCK;

  /**
   * Đổi tab thì biểu đồ đi theo.
   *
   * Không làm bước này thì bấm sang Phái sinh cho ra một bảng bốn hợp đồng nằm cạnh biểu đồ HPG
   * — người dùng phải tự bấm thêm một lần nữa mới hiểu tab đã đổi.
   *
   * Bộ lọc sàn **giữ nguyên** khi quay lại tab Chứng khoán: nó là lựa chọn riêng của tab đó, và
   * xoá nó mỗi lần người dùng ghé qua tab kia là bắt họ đặt lại.
   */
  function changeAssetClass(next: AssetClass) {
    if (next === assetClass) return;
    setAssetClass(next);
    setSelected(next === 'DERIVATIVE' ? DEFAULT_DERIVATIVE : DEFAULT_STOCK);
  }

  /**
   * Lưới an toàn cho mã mặc định.
   *
   * `VN30F1M` được nạp ở migration `0016`, nhưng một bản cài chưa chạy migration — hoặc một danh
   * mục bị sửa tay ở site quản trị — sẽ không có nó, và khi đó tab Phái sinh mở ra với một biểu
   * đồ trắng cạnh một bảng có dữ liệu. Rơi về dòng đầu tiên thì màn hình luôn nói được điều gì
   * đó.
   *
   * Điều kiện `selected === defaultSymbol` là phần quan trọng: hiệu ứng này **chỉ** chạm vào mã
   * mặc định mà chưa ai bấm tới. Người dùng đã tự chọn một mã rồi lọc sang sàn khác vẫn giữ
   * nguyên biểu đồ của mình, không bị kéo về dòng đầu bảng.
   */
  useEffect(() => {
    if (search.trim()) return;
    const items = board?.items ?? [];
    if (!items.length) return;
    if (selected !== defaultSymbol) return;
    if (items.some((row) => row.symbol === defaultSymbol)) return;
    setSelected(items[0].symbol);
  }, [board?.items, defaultSymbol, search, selected]);

  return (
    <div className="space-y-5 pb-6">
      {/* Cột trái vừa đủ cho bốn cột số của bảng giá; phần dôi ra dồn hết cho biểu đồ, vì đó mới
          là thứ người dùng nhìn lâu và cần bề ngang để đọc nến. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,25rem)_minmax(0,1fr)]">
        {/* ---------- CỘT TRÁI: BẢNG GIÁ ----------
            Dính ở mép trên khi cuộn. Cột phải cao gấp nhiều lần (biểu đồ + phân tích + chỉ số),
            nên cuộn xuống đọc nhận định là mất luôn danh sách mã — mà đó chính là chỗ đổi sang
            mã khác. Vùng cuộn ở đây là `<main>` của khung Customer chứ không phải cửa sổ, nên
            `top` tính từ mép dưới thanh điều hướng trên cùng.

            `self-start` vì ô lưới mặc định giãn hết chiều cao hàng: giãn rồi thì không còn gì
            để dính, `sticky` im lặng không có tác dụng.

            Chiều cao bị chặn theo màn hình và bảng mã tự co lại bên trong (`flex-1 min-h-0`):
            một khối dính cao hơn khung nhìn sẽ trôi mất phần đầu và không bao giờ quay lại
            cho tới khi người dùng cuộn ngược lên. */}
        <div className="space-y-3 lg:sticky lg:top-5 lg:flex lg:max-h-[calc(100vh-10rem)] lg:flex-col lg:self-start">
          <SearchInput
            placeholder="Tìm mã hoặc tên công ty…"
            value={search}
            onSearch={setSearch}
          />

          {/*
            Hai tầng, và khoảng cách giữa chúng là thứ nói lên quan hệ: tab loại tài sản là
            điều hướng (đổi hẳn nội dung bảng), hàng sàn bên dưới chỉ là bộ lọc thu hẹp cái
            đang xem. Dựng cả hai cùng cỡ, cùng kiểu thì người dùng phải đọc chữ mới biết cái
            nào quan trọng hơn.

            Ẩn cả khối khi đang tìm kiếm: kết quả tìm cắt ngang cả hai trục, hiện một tab "đang
            bật" trong lúc bảng không hề lọc theo nó là nói sai.
          */}
          {!search.trim() && (
            <div className="space-y-2.5">
              <Tabs
                items={ASSET_TABS}
                active={assetClass}
                onChange={(key) => changeAssetClass(key as AssetClass)}
              />

              {/* Sàn chỉ có nghĩa với cổ phiếu: phái sinh Việt Nam chỉ niêm yết trên HNX, nên
                  một bộ lọc ba sàn ở đó là ba nút mà hai nút luôn trả về danh sách rỗng. */}
              {assetClass === 'STOCK' && (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Lọc theo sàn">
                  {EXCHANGES.map((item) => {
                    const active = exchange === item.key;
                    return (
                      <button
                        key={item.key || 'all'}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setExchange(item.key)}
                        className={cn(
                          'rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                          active
                            ? 'border-brand bg-brand-soft text-brand'
                            : 'border-line text-ink-500 hover:border-line-strong hover:text-ink-800',
                        )}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {board?.realtime_enabled && <SessionBar board={board} connected={connected} />}

          {isLoading ? (
            <Card>
              <Spinner label="Đang tải bảng giá…" />
            </Card>
          ) : !rows.length ? (
            <EmptyState
              title="Không tìm thấy mã nào"
              description="Thử từ khoá khác, ví dụ HPG hoặc Hòa Phát."
            />
          ) : (
            <Card padded={false} className="overflow-hidden lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
              {/* Bảng nhiều cột không dùng được trên điện thoại (mục 11.2), nên mỗi mã là một
                  dòng gọn: mã · tên · giá · %thay đổi · khối lượng. */}
              <div className="max-h-[32rem] overflow-y-auto overscroll-contain lg:max-h-none lg:min-h-0 lg:flex-1">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-surface/95 text-xs backdrop-blur">
                    <tr className="border-b border-line">
                      <th className="px-3 py-2.5 text-left text-label font-medium uppercase text-ink-500">
                        Mã
                      </th>
                      <th className="px-3 py-2.5 text-right text-label font-medium uppercase text-ink-500">
                        Giá
                      </th>
                      <th className="px-3 py-2.5 text-right text-label font-medium uppercase text-ink-500">
                        +/-
                      </th>
                      <th className="hidden px-3 py-2.5 text-right text-label font-medium uppercase text-ink-500 sm:table-cell">
                        K/L
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {rows.map((row) => (
                      <tr
                        key={row.symbol}
                        onClick={() => setSelected(row.symbol)}
                        className={cn(
                          // Viền trái cho mã đang xem: riêng đổi nền là quá nhẹ để tìm lại dòng đang chọn
                          // trong một danh sách sáu mươi dòng, nhất là ở nền tối nơi các bậc xám sát nhau.
                          'cursor-pointer border-l-2 transition-colors',
                          selected === row.symbol
                            ? 'border-brand bg-ink-100'
                            : 'border-transparent hover:bg-ink-50',
                        )}
                      >
                        <td className="px-3 py-2.5">
                          <p className="font-semibold tracking-tight text-ink-900">{row.symbol}</p>
                          {/* <p className="max-w-[8rem] truncate text-xs text-ink-500">
                            {row.company_name ?? row.exchange}
                          </p> */}
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2.5 text-right text-[0.9375rem] font-semibold tabular-nums',
                            // Nền nháy phải tắt dần chứ không biến mất đột ngột: một mảng màu
                            // tắt phụt trông như lỗi vẽ, còn tắt dần thì mắt đọc được là "vừa
                            // có gì đó xảy ra ở dòng này".
                            'transition-colors duration-500',
                            priceClass(row),
                            flashClass(flash[row.symbol]),
                          )}
                          title={
                            row.ceiling !== null && row.floor !== null
                              ? `Trần ${formatPrice(row.ceiling)} · Sàn ${formatPrice(row.floor)}`
                              : undefined
                          }
                        >
                          {row.close !== null ? formatPrice(row.close) : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {row.change_pct !== null ? (
                            // Một dòng thay vì hai: hai dòng chữ 12px chồng lên nhau đọc chậm
                            // hơn hẳn, và làm mỗi hàng cao thêm mà không thêm thông tin gì.
                            <span
                              className={cn(
                                'inline-flex items-baseline gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums',
                                changeChipClass(row.change),
                              )}
                            >
                              <span>
                                {row.change !== null && row.change > 0 ? '+' : ''}
                                {row.change !== null ? formatPrice(row.change) : ''}
                              </span>
                              <span className="opacity-80">
                                {formatPercent(row.change_pct, 2)}
                              </span>
                            </span>
                          ) : (
                            <span className="text-ink-400">—</span>
                          )}
                        </td>
                        <td className="hidden px-3 py-2.5 text-right tabular-nums text-ink-500 sm:table-cell">
                          {row.volume !== null ? formatNumber(row.volume) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* BR-836 — ghi rõ nguồn dữ liệu dưới bảng giá. BR-833 — kèm khuyến cáo giá tham
              khảo, vì nguồn là endpoint công khai không có hợp đồng. */}
          {board && (
            <p className="px-1 text-xs text-ink-500">
              {board.attribution} · {board.note}
            </p>
          )}
        </div>

        {/* ---------- CỘT PHẢI: BIỂU ĐỒ ---------- */}
        <div className="space-y-3">
          <Card>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-display font-semibold text-ink-900">{selected}</h2>
                <p className="text-xs text-ink-500">
                  {board?.items.find((i) => i.symbol === selected)?.company_name ?? 'Biểu đồ ngày'}
                </p>
              </div>
              {lastCandle ? (
                <div className="text-right">
                  <p className="text-xl font-semibold tabular-nums text-ink-900">
                    {formatPrice(lastCandle.close)}
                  </p>
                  <p className="text-xs text-ink-500">
                    Phiên {formatDate(lastCandle.trade_date)}
                  </p>
                </div>
              ) : null}
            </div>

            {chartLoading ? (
              <div className="py-20">
                <Spinner label="Đang tải biểu đồ…" />
              </div>
            ) : !chartCandles.length ? (
              <EmptyState
                title={`Chưa có dữ liệu giá cho ${selected}`}
                description="Mã này chưa được đồng bộ hoặc chưa phát sinh giao dịch."
              />
            ) : (
              <PriceChart
                symbol={selected}
                candles={chartCandles}
                tzOffsetSeconds={ohlcv?.tz_offset_seconds ?? 0}
                indicators={indicators}
                attribution={ohlcv?.attribution}
                height={420}
                onExpandedChange={setChartExpanded}
                onSymbolChange={setSelected}
                // Phóng to kín màn hình thì lớp phủ che mất mọi thứ bên dưới. Đưa phần phân tích
                // sang cột phải để vẫn đọc được nhận định cùng lúc với biểu đồ — chính lúc bung
                // hết cỡ mới là lúc người dùng soi kỹ và cần đối chiếu.
                sidePanel={
                  <div className="space-y-3">
                    {/* `dense` cứng ở đây chứ không lấy theo `chartExpanded`: khối này chỉ được
                        dựng khi đang phóng to (xem `PriceChart`), nên nó luôn ở cột hẹp. */}
                    <MarketAnalysisPanel
                      symbol={selected}
                      candles={chartCandles}
                      instances={indicators.indicators}
                      dense
                    />
                    <PriceSummary candles={chartCandles} />
                  </div>
                }
              />
            )}
          </Card>

          {/* Đang phóng to thì hai khối này đã nằm ở cột phải của lớp phủ — xem `sidePanel`. */}
          {chartCandles.length > 0 && !chartExpanded ? (
            <>
              <MarketAnalysisPanel
                symbol={selected}
                candles={chartCandles}
                instances={indicators.indicators}
              />
              <PriceSummary candles={chartCandles} />
            </>
          ) : null}
        </div>
      </div>

      <Disclaimer />
    </div>
  );
}

/**
 * Dải trạng thái phiên phía trên bảng giá.
 *
 * Ba thông tin, và cả ba đều cần thiết vì thiếu chúng thì **một bảng giá đứng im vì thị trường
 * đang nghỉ trưa và một bảng giá đứng im vì kết nối đã chết trông y hệt nhau**:
 *
 * * Phiên đang ở đâu (ATO · liên tục · nghỉ trưa · ATC · đóng cửa).
 * * Kênh đẩy còn sống không — chấm xanh nhấp nháy.
 * * Ảnh chụp gần nhất lúc mấy giờ, hiện rõ khi dữ liệu đã chậm.
 */
function SessionBar({
  board,
  connected,
}: {
  board: PriceBoardResponse;
  connected: boolean;
}) {
  const live = board.realtime && connected;
  const asOf = board.as_of ? new Date(board.as_of) : null;

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs">
      <span className="inline-flex items-center gap-1.5">
        <span
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-full',
            live ? 'animate-pulse bg-up' : board.stale ? 'bg-ref' : 'bg-ink-300',
          )}
        />
        <span className="font-medium text-ink-900">{board.session_label}</span>
      </span>

      {board.stale ? (
        <span className="text-ref">
          Dữ liệu chậm
          {asOf ? ` — cập nhật lúc ${asOf.toLocaleTimeString('vi-VN')}` : ''}
        </span>
      ) : asOf ? (
        <span className="tabular-nums text-ink-500">{asOf.toLocaleTimeString('vi-VN')}</span>
      ) : null}

      {!connected && board.realtime_enabled && board.session !== 'CLOSED' && (
        <span className="text-ink-400">· đang kết nối lại…</span>
      )}
    </div>
  );
}

/** Vài chỉ số nhanh của mã đang chọn — đọc trực tiếp từ chuỗi nến đã tải. */
function PriceSummary({ candles }: { candles: OhlcvResponse['candles'] }) {
  const last = candles[candles.length - 1];
  const window = candles.slice(-252);
  const high52 = Math.max(...window.map((c) => c.high));
  const low52 = Math.min(...window.map((c) => c.low));
  const avgVolume = window.reduce((sum, c) => sum + c.volume, 0) / (window.length || 1);

  const items = [
    { label: 'Mở cửa', value: formatPrice(last.open) },
    { label: 'Cao nhất phiên', value: formatPrice(last.high) },
    { label: 'Thấp nhất phiên', value: formatPrice(last.low) },
    { label: 'Khối lượng', value: formatNumber(last.volume) },
    { label: 'Cao nhất 1 năm', value: formatPrice(high52) },
    { label: 'Thấp nhất 1 năm', value: formatPrice(low52) },
    { label: 'KL trung bình 1 năm', value: formatNumber(Math.round(avgVolume)) },
    { label: 'Số phiên có dữ liệu', value: formatNumber(candles.length) },
  ];

  return (
    <Card>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {items.map((item) => (
          <div key={item.label}>
            <dt className="text-xs text-ink-500">{item.label}</dt>
            <dd className="mt-0.5 font-medium tabular-nums text-ink-900">{item.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
