'use client';

import { useState } from 'react';

import { MarketAnalysisPanel } from '@/components/domain/MarketAnalysisPanel';
import { PriceChart } from '@/components/domain/PriceChart';
import { useIndicators } from '@/components/domain/chart/useIndicators';
import {
  Card,
  Disclaimer,
  EmptyState,
  SearchInput,
  Spinner,
  Tabs,
} from '@/components/ui';
import { useApiQuery } from '@/hooks';
import { CUSTOMER } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/datetime';
import { formatNumber, formatPercent } from '@/lib/format';
import type { OhlcvResponse, PriceBoardResponse, SymbolInfo } from '@/types';

const EXCHANGES = [
  { key: 'HOSE', label: 'HOSE' },
  { key: 'HNX', label: 'HNX' },
  { key: 'UPCOM', label: 'UPCOM' },
];

/** Màu theo quy ước thị trường Việt Nam: tăng xanh lá, giảm đỏ, tham chiếu vàng. */
function priceClass(change: number | null | undefined): string {
  if (change === null || change === undefined || change === 0) return 'text-ref';
  return change > 0 ? 'text-up' : 'text-down';
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
  const [exchange, setExchange] = useState('HOSE');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('HPG');

  // Bộ chỉ báo giữ ở đây chứ không trong biểu đồ: cả biểu đồ lẫn nút AI phân tích bên dưới đều
  // cần đúng một bộ này — biểu đồ để vẽ, nút phân tích để gửi cho mô hình đọc.
  const indicators = useIndicators();

  // Đang tìm kiếm thì hiển thị kết quả tìm; không thì hiển thị bảng giá theo sàn.
  const { data: found } = useApiQuery<SymbolInfo[]>(
    search.trim().length >= 1 ? `${CUSTOMER}/market/symbols` : null,
    { q: search.trim(), limit: 30 },
  );

  const { data: board, isLoading } = useApiQuery<PriceBoardResponse>(
    `${CUSTOMER}/market/board`,
    search.trim().length >= 1
      ? { symbols: (found ?? []).map((s) => s.symbol), limit: 30 }
      : { exchange, limit: 60 },
    { refreshInterval: 120_000 },
  );

  const { data: ohlcv, isLoading: chartLoading } = useApiQuery<OhlcvResponse>(
    selected ? `${CUSTOMER}/market/ohlcv` : null,
    { symbol: selected, limit: 400 },
  );

  return (
    <div className="space-y-5 pb-6">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
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

          {!search.trim() && (
            <Tabs items={EXCHANGES} active={exchange} onChange={setExchange} />
          )}

          {isLoading ? (
            <Card>
              <Spinner label="Đang tải bảng giá…" />
            </Card>
          ) : !board?.items.length ? (
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
                        Khối lượng
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {board.items.map((row) => (
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
                          <p className="max-w-[11rem] truncate text-xs text-ink-500">
                            {row.company_name ?? row.exchange}
                          </p>
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2.5 text-right text-[0.9375rem] font-semibold tabular-nums',
                            priceClass(row.change),
                          )}
                        >
                          {row.close !== null ? formatNumber(row.close) : '—'}
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
                                {row.change !== null ? formatNumber(row.change) : ''}
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

          {/* BR-836 — ghi rõ nguồn dữ liệu dưới bảng giá. */}
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
              {ohlcv?.candles.length ? (
                <div className="text-right">
                  <p className="text-xl font-semibold tabular-nums text-ink-900">
                    {formatNumber(ohlcv.candles[ohlcv.candles.length - 1].close)}
                  </p>
                  <p className="text-xs text-ink-500">
                    Phiên {formatDate(ohlcv.candles[ohlcv.candles.length - 1].trade_date)}
                  </p>
                </div>
              ) : null}
            </div>

            {chartLoading ? (
              <div className="py-20">
                <Spinner label="Đang tải biểu đồ…" />
              </div>
            ) : !ohlcv?.candles.length ? (
              <EmptyState
                title={`Chưa có dữ liệu giá cho ${selected}`}
                description="Mã này chưa được đồng bộ hoặc chưa phát sinh giao dịch."
              />
            ) : (
              <PriceChart
                symbol={selected}
                candles={ohlcv.candles}
                indicators={indicators}
                attribution={ohlcv.attribution}
                height={420}
              />
            )}
          </Card>

          {ohlcv?.candles.length ? (
            <MarketAnalysisPanel
              symbol={selected}
              candles={ohlcv.candles}
              instances={indicators.indicators}
            />
          ) : null}

          {ohlcv?.candles.length ? <PriceSummary candles={ohlcv.candles} /> : null}
        </div>
      </div>

      <Disclaimer />
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
    { label: 'Mở cửa', value: formatNumber(last.open) },
    { label: 'Cao nhất phiên', value: formatNumber(last.high) },
    { label: 'Thấp nhất phiên', value: formatNumber(last.low) },
    { label: 'Khối lượng', value: formatNumber(last.volume) },
    { label: 'Cao nhất 1 năm', value: formatNumber(high52) },
    { label: 'Thấp nhất 1 năm', value: formatNumber(low52) },
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
