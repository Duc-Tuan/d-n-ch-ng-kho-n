'use client';

/**
 * Biểu đồ chiến lược kèm marker điểm mua/bán — Phần 13.
 *
 * Dùng `lightweight-charts` theo khuyến nghị mục 12.4: nhẹ (~45KB), API `setMarkers()`
 * khớp trực tiếp với yêu cầu của phần này, và cho phép vẽ marker riêng — điều mà
 * TradingView Widget dạng iframe không làm được.
 *
 * Các quy tắc được cài trong component này:
 *  - BR-841 — marker LIVE màu đậm, marker BACKTEST màu nhạt + nhãn "Mô phỏng";
 *             chú thích phân biệt hiển thị **cố định**, không giấu trong tooltip.
 *  - BR-845 — giới hạn số marker render, cảnh báo khi bị cắt bớt.
 *  - BR-846 — trên mobile marker đủ lớn để chạm, popup mở dạng bottom sheet.
 */
import {
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useIsMobile } from '@/hooks';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/datetime';
import { formatNumber, formatR } from '@/lib/format';
import type { Candle, Signal } from '@/types';
import { Alert, Badge, Modal } from '@/components/ui';
import { chartColors, down, up } from './chart/chartTheme';

type Props = {
  signals: Signal[];
  candles?: Candle[];
  /** BR-836 — ghi nguồn dữ liệu dưới biểu đồ. */
  attribution?: string;
  truncated?: boolean;
  maxMarkers?: number;
  selectedSignalId?: number | null;
  onSelectSignal?: (signal: Signal | null) => void;
  height?: number;
};

/** Đọc lúc chạy — xem `chartTheme`. Nền tối và nền sáng không dùng chung sắc xanh/đỏ. */
function colors() {
  return {
    liveBuy: up(),
    liveSell: down(),
    // Marker mô phỏng nhạt hơn hẳn để phân biệt tuyệt đối với tín hiệu thực (BR-841).
    backtestBuy: up(0.45),
    backtestSell: down(0.45),
  };
}

function toUnix(iso: string): Time {
  return Math.floor(new Date(iso).getTime() / 1000) as Time;
}

/**
 * Khi chưa đấu nối nguồn dữ liệu giá (Phần 12 — quyết định cần chốt trước),
 * dựng chuỗi nến tối thiểu từ chính các mốc giá của tín hiệu để marker có chỗ bám.
 * Thay bằng OHLCV thật ngay khi `MarketDataProvider` (BR-830) sẵn sàng.
 */
/**
 * Ép về số thật.
 *
 * Giá tiền đi qua JSON có thể về dạng chuỗi ("92000.0000") tuỳ cách backend serialize kiểu
 * Decimal. `lightweight-charts` từ chối thẳng giá trị chuỗi và ném lỗi runtime, nên chuẩn hoá
 * ngay tại biên thay vì tin vào kiểu khai báo trong TypeScript.
 */
function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function synthesizeCandles(signals: Signal[]): CandlestickData<Time>[] {
  const points = new Map<number, number>();
  for (const signal of signals) {
    const entry = num(signal.entry_price);
    if (entry !== null) {
      points.set(Math.floor(new Date(signal.entry_time).getTime() / 1000), entry);
    }
    const exit = num(signal.exit_price);
    if (signal.exit_time && exit !== null) {
      points.set(Math.floor(new Date(signal.exit_time).getTime() / 1000), exit);
    }
  }

  return [...points.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, price]) => ({
      time: time as Time,
      open: price,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
    }));
}

export function StrategyChart({
  signals,
  candles,
  attribution,
  truncated = false,
  maxMarkers = 500,
  selectedSignalId = null,
  onSelectSignal,
  height = 420,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const isMobile = useIsMobile();

  const [activeSignal, setActiveSignal] = useState<Signal | null>(null);

  const data = useMemo<CandlestickData<Time>[]>(() => {
    if (!candles?.length) return synthesizeCandles(signals);
    // Nến từ API cũng phải chuẩn hoá — cùng lý do như synthesizeCandles.
    return candles
      .map((c) => ({
        time: Math.floor(new Date(c.trade_date).getTime() / 1000) as Time,
        open: num(c.open),
        high: num(c.high),
        low: num(c.low),
        close: num(c.close),
      }))
      .filter(
        (c): c is CandlestickData<Time> =>
          c.open !== null && c.high !== null && c.low !== null && c.close !== null,
      );
  }, [candles, signals]);

  const signalsByTime = useMemo(() => {
    const map = new Map<number, Signal>();
    for (const signal of signals) {
      map.set(Math.floor(new Date(signal.entry_time).getTime() / 1000), signal);
    }
    return map;
  }, [signals]);

  // Khởi tạo biểu đồ một lần.
  useEffect(() => {
    if (!containerRef.current) return;

    const theme = chartColors();
    const palette = colors();
    const chart = createChart(containerRef.current, {
      height,
      // `attributionLogo` — xem `chartTheme.baseChartOptions`. Biểu đồ này tự dựng tuỳ
      // chọn nên phải tắt lại một lần nữa ở đây.
      layout: {
        background: { type: ColorType.Solid, color: theme.background },
        textColor: theme.text,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: theme.grid },
        horzLines: { color: theme.grid },
      },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      handleScroll: {
        // BR-846 — khoá cuộn dọc của biểu đồ trên mobile để không tranh chấp với cuộn trang.
        vertTouchDrag: !isMobile,
      },
      handleScale: { pinch: true, axisPressedMouseMove: true },
    });

    const series = chart.addCandlestickSeries({
      upColor: palette.liveBuy,
      downColor: palette.liveSell,
      borderVisible: false,
      wickUpColor: palette.liveBuy,
      wickDownColor: palette.liveSell,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const resize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    resize();
    window.addEventListener('resize', resize);

    // Chạm/hover vào marker → mở popup chi tiết (mục 13.2 bước 4).
    chart.subscribeClick((param) => {
      if (!param.time) return;
      const signal = signalsByTime.get(param.time as number);
      setActiveSignal(signal ?? null);
      onSelectSignal?.(signal ?? null);
    });

    return () => {
      window.removeEventListener('resize', resize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, isMobile]);

  // Cập nhật dữ liệu nến.
  useEffect(() => {
    if (!seriesRef.current) return;
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  // Cập nhật marker.
  useEffect(() => {
    if (!seriesRef.current) return;

    const markers: SeriesMarker<Time>[] = signals.slice(0, maxMarkers).map((signal) => {
      const isBuy = signal.direction === 'BUY';
      const isLive = signal.signal_type === 'LIVE';
      const highlighted = selectedSignalId === signal.id;
      const palette = colors();

      return {
        time: toUnix(signal.entry_time),
        // Marker mua ▲ đặt dưới nến, marker bán ▼ đặt trên nến (mục 13.2 bước 3).
        position: isBuy ? 'belowBar' : 'aboveBar',
        shape: isBuy ? 'arrowUp' : 'arrowDown',
        color: isLive
          ? isBuy
            ? palette.liveBuy
            : palette.liveSell
          : isBuy
            ? palette.backtestBuy
            : palette.backtestSell,
        // BR-841 — tín hiệu mô phỏng luôn có nhãn "Mô phỏng" ngay trên marker.
        text: isLive
          ? highlighted
            ? `● ${isBuy ? 'MUA' : 'BÁN'}`
            : isBuy
              ? 'MUA'
              : 'BÁN'
          : `${isBuy ? 'MUA' : 'BÁN'} (Mô phỏng)`,
        // BR-846 — marker ≥ 24px để chạm được trên điện thoại.
        size: isMobile ? 2 : 1,
      };
    });

    seriesRef.current.setMarkers(markers);
  }, [signals, maxMarkers, selectedSignalId, isMobile]);

  // Bảng danh sách bấm vào một dòng → biểu đồ cuộn tới đúng nến (liên kết hai chiều).
  useEffect(() => {
    if (!selectedSignalId || !chartRef.current) return;
    const signal = signals.find((s) => s.id === selectedSignalId);
    if (!signal) return;
    const time = Math.floor(new Date(signal.entry_time).getTime() / 1000);
    chartRef.current.timeScale().setVisibleRange({
      from: (time - 86400 * 30) as Time,
      to: (time + 86400 * 30) as Time,
    });
  }, [selectedSignalId, signals]);

  return (
    <div className="space-y-3">
      {/* BR-845 — cảnh báo khi số marker bị cắt bớt, kèm gợi ý thu hẹp khoảng thời gian. */}
      {truncated && (
        <Alert tone="warning">
          Chỉ hiển thị {maxMarkers} tín hiệu gần nhất để biểu đồ không bị chậm. Thu hẹp khoảng thời
          gian để xem đầy đủ.
        </Alert>
      )}

      <div className="overflow-hidden rounded-xl border border-ink-200 bg-surface">
        <div ref={containerRef} className="w-full" />
      </div>

      {/* BR-841 — chú thích phân biệt hiển thị CỐ ĐỊNH, không giấu trong tooltip. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-xs">
        <span className="font-medium text-ink-700">Chú thích:</span>
        <span className="flex items-center gap-1.5">
          <span className="text-up">▲</span>
          <span className="text-down">▼</span>
          <span className="text-ink-600">Tín hiệu thực — đã phát ra tại thời điểm thực</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-up/45">▲</span>
          <span className="text-down/45">▼</span>
          <span className="text-ink-600">
            Mô phỏng — tính lại trên dữ liệu lịch sử, chưa từng phát ra thực tế
          </span>
        </span>
      </div>

      {!candles?.length && signals.length > 0 ? (
        <p className="text-xs text-ink-500">
          Chưa có dữ liệu giá của mã này nên biểu đồ đang dựng tạm từ mốc giá của tín hiệu.
        </p>
      ) : attribution ? (
        <p className="text-xs text-ink-500">{attribution}</p>
      ) : null}

      <SignalPopup
        signal={activeSignal}
        onClose={() => {
          setActiveSignal(null);
          onSelectSignal?.(null);
        }}
      />
    </div>
  );
}

/** Popup chi tiết marker — bottom sheet trên mobile, modal trên desktop (BR-846). */
function SignalPopup({ signal, onClose }: { signal: Signal | null; onClose: () => void }) {
  if (!signal) return null;

  const isBuy = signal.direction === 'BUY';
  const rows: Array<[string, React.ReactNode]> = [
    ['Thời điểm', formatDateTime(signal.entry_time)],
    ['Giá vào', formatNumber(signal.entry_price)],
    ['Cắt lỗ', signal.sl ? formatNumber(signal.sl) : '—'],
    ['Chốt lời', signal.tp ? formatNumber(signal.tp) : '—'],
  ];

  if (signal.exit_time) {
    rows.push(['Thời điểm thoát', formatDateTime(signal.exit_time)]);
    rows.push(['Giá thoát', formatNumber(signal.exit_price)]);
    rows.push(['Kết quả R', formatR(signal.r_multiple)]);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span className={cn('font-semibold', isBuy ? 'text-up' : 'text-down')}>
            {isBuy ? '▲ MUA' : '▼ BÁN'}
          </span>
          {signal.symbol}
          <Badge tone={signal.signal_type === 'LIVE' ? 'green' : 'gray'}>
            {signal.signal_type === 'LIVE' ? 'Tín hiệu thực' : 'Mô phỏng'}
          </Badge>
        </span>
      }
      size="sm"
    >
      <div className="space-y-4">
        {signal.signal_type === 'BACKTEST' && (
          <Alert tone="warning">
            Đây là tín hiệu mô phỏng, được tính lại trên dữ liệu lịch sử và{' '}
            <strong>chưa từng phát ra thực tế</strong>.
          </Alert>
        )}

        <dl className="divide-y divide-ink-100">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3 py-2 text-sm">
              <dt className="text-ink-500">{label}</dt>
              <dd className="font-medium tabular-nums text-ink-900">{value}</dd>
            </div>
          ))}
        </dl>

        {signal.reason_text && (
          <div className="rounded-lg bg-ink-50 p-3">
            <p className="text-xs font-medium text-ink-500">Lý do vào lệnh</p>
            <p className="mt-1 text-sm text-ink-700">{signal.reason_text}</p>
          </div>
        )}

        {signal.cancel_reason && (
          <Alert tone="info" title="Tín hiệu đã bị huỷ">
            {signal.cancel_reason}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
