'use client';

/**
 * Kết quả chạy chiến lược lên một mã (YC12).
 *
 * Đây là màn trả lời câu hỏi *"chiến lược này áp vào mã tôi quan tâm thì cho gì?"*: biểu đồ nến
 * kèm mũi tên mua/bán, bảng từng lệnh, và thống kê tổng hợp.
 *
 * BR-848 — khi `summary` là null nghĩa là người xem không được biết quy tắc bên trong (chiến
 * lược của hệ thống). Component tự ẩn phần công thức, vẫn hiển thị đầy đủ kết quả. Không cần
 * nơi gọi truyền thêm cờ gì: máy chủ đã quyết định, giao diện chỉ phản ánh.
 */

import {
  ColorType,
  createChart,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type LogicalRange,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Alert, Badge, Card, Disclaimer, EmptyState, Icon, Table, type Column } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/datetime';
import { formatNumber } from '@/lib/format';
import type { Candle, OhlcvResponse, RunTrade, StrategyRunResult } from '@/types';
import { chartColor, chartColors, down, up } from './chart/chartTheme';


const OVERLAY_COLORS = ['#2563eb', '#9333ea', '#ea580c', '#0891b2'];

/** Số nến còn lại bên trái trước khi bắt đầu tải thêm — tải sớm để không thấy khoảng trắng. */
const LOAD_MORE_THRESHOLD = 20;
const LOAD_MORE_SIZE = 300;

function toTime(iso: string): Time {
  return Math.floor(new Date(iso).getTime() / 1000) as Time;
}

/** Giá qua JSON có thể về dạng chuỗi — ép số trước khi đưa vào thư viện biểu đồ. */
function num(value: number | string | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toneOf(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return 'text-ink-700';
  return value > 0 ? 'text-up' : 'text-down';
}

export function StrategyRunView({
  result,
  candles,
  height = 440,
  ohlcvEndpoint,
}: {
  result: StrategyRunResult;
  candles: Candle[];
  height?: number;
  /**
   * Đường dẫn API nến của site đang dùng — truyền vào thì bật tải thêm lịch sử khi cuộn.
   *
   * Nhận từ nơi gọi thay vì đoán, cùng lý do như `useStrategyRun`: hai site có hai cookie và
   * hai tiền tố API khác nhau, component dùng chung không được phép tự chọn hộ.
   */
  ohlcvEndpoint?: string;
}) {
  return (
    <div className="space-y-4">
      {result.warnings.map((warning) => (
        <Alert key={warning} tone="warning">
          {warning}
        </Alert>
      ))}

      <Card padded={false} className="overflow-hidden">
        <div className="border-b border-ink-200 px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold text-ink-900">
              {result.symbol} · điểm mua bán theo chiến lược
            </h3>
            <span className="text-xs text-ink-500">
              {formatDate(result.from_date)} – {formatDate(result.to_date)} · {result.bars} phiên
            </span>
          </div>

          {/* Chỉ hiện khi người xem được quyền biết quy tắc. */}
          {result.summary && <p className="mt-1 text-xs text-ink-500">{result.summary}</p>}
        </div>

        <RunChart
          result={result}
          candles={candles}
          height={height}
          ohlcvEndpoint={ohlcvEndpoint}
        />
      </Card>

      <StatsGrid result={result} />
      <TradeTable trades={result.trades} />

      <Disclaimer>{result.disclaimer}</Disclaimer>
    </div>
  );
}

function RunChart({
  result,
  candles: initialCandles,
  height,
  ohlcvEndpoint,
}: {
  result: StrategyRunResult;
  candles: Candle[];
  height: number;
  ohlcvEndpoint?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const overlayRefs = useRef<ISeriesApi<'Line'>[]>([]);

  const [candles, setCandles] = useState<Candle[]>(initialCandles);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  // Dùng ref trong callback của biểu đồ để không phải gắn lại sự kiện mỗi lần dữ liệu đổi.
  const stateRef = useRef({ candles, loadingMore, exhausted, ohlcvEndpoint, symbol: result.symbol });
  stateRef.current = { candles, loadingMore, exhausted, ohlcvEndpoint, symbol: result.symbol };

  // Chạy lại chiến lược (đổi mã, sửa bộ lọc) thì bắt đầu lại từ dữ liệu mới.
  useEffect(() => {
    setCandles(initialCandles);
    setExhausted(false);
  }, [initialCandles, result.symbol]);

  /**
   * Cuộn về quá khứ thì nạp thêm nến cũ hơn nến sớm nhất đang có.
   *
   * Không có phần này, biểu đồ dừng ở đúng số nến tải lần đầu và người dùng kéo tới mép trái
   * chỉ thấy khoảng trắng — trong khi bảng danh sách lệnh vẫn liệt kê những lệnh cũ hơn thế,
   * vì máy chủ chạy chiến lược trên khoảng dữ liệu dài hơn khoảng vẽ ban đầu.
   */
  const loadOlder = useCallback(async () => {
    const state = stateRef.current;
    if (!state.ohlcvEndpoint || state.loadingMore || state.exhausted || !state.candles.length) return;

    setLoadingMore(true);
    try {
      const earliest = state.candles[0].trade_date;
      // Lùi một ngày để không lấy trùng nến đang có ở mép.
      const before = new Date(earliest);
      before.setDate(before.getDate() - 1);

      const response = await api.get<OhlcvResponse>(state.ohlcvEndpoint, {
        symbol: state.symbol,
        date_to: before.toISOString().slice(0, 10),
        limit: LOAD_MORE_SIZE,
      });

      const older = response.candles ?? [];
      if (!older.length) {
        setExhausted(true);
        return;
      }

      setCandles((current) => {
        // Ghép và khử trùng theo ngày — nguồn có thể trả lặp ở mép.
        const seen = new Set(current.map((c) => c.trade_date));
        const merged = [...older.filter((c) => !seen.has(c.trade_date)), ...current];
        if (merged.length === current.length) setExhausted(true);
        return merged;
      });
    } catch {
      // Hết lịch sử hoặc lỗi mạng — dừng tải thêm, không báo lỗi ồn ào giữa thao tác cuộn.
      setExhausted(true);
    } finally {
      setLoadingMore(false);
    }
  }, []);

  const bars = useMemo<CandlestickData<Time>[]>(
    () =>
      candles.map((c) => ({
        time: toTime(c.trade_date),
        open: num(c.open),
        high: num(c.high),
        low: num(c.low),
        close: num(c.close),
      })),
    [candles],
  );

  const markers = useMemo<SeriesMarker<Time>[]>(() => {
    // Thư viện yêu cầu marker sắp xếp tăng dần theo thời gian, nếu không sẽ ném lỗi khẳng định.
    const sorted = [...result.markers].sort((a, b) => a.trade_date.localeCompare(b.trade_date));

    return sorted.map((marker) => {
      const isEntry = marker.kind === 'ENTRY';
      const isBuy = marker.direction === 'BUY';
      // Mũi tên vào lệnh nằm dưới nến và chỉ lên với lệnh mua; thoát lệnh nằm trên nến.
      const below = isEntry === isBuy;

      return {
        time: toTime(marker.trade_date),
        position: below ? 'belowBar' : 'aboveBar',
        shape: below ? 'arrowUp' : 'arrowDown',
        color: isEntry ? (isBuy ? up() : down()) : chartColor('ink-500', '113 113 127'),
        text: marker.note ? `${marker.label} · ${marker.note}` : marker.label,
      } satisfies SeriesMarker<Time>;
    });
  }, [result.markers]);

  useEffect(() => {
    if (!containerRef.current) return;

    const theme = chartColors();
    const chart = createChart(containerRef.current, {
      height,
      // `attributionLogo` — xem `chartTheme.baseChartOptions`.
      layout: {
        background: { type: ColorType.Solid, color: theme.background },
        textColor: theme.text,
        attributionLogo: false,
      },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border, timeVisible: false },
      crosshair: { mode: 1 },
    });

    priceRef.current = chart.addCandlestickSeries({
      upColor: up(),
      downColor: down(),
      borderVisible: false,
      wickUpColor: up(),
      wickDownColor: down(),
    });

    chartRef.current = chart;

    // Cuộn tới gần mép trái thì nạp thêm lịch sử.
    const onRangeChange = (logicalRange: LogicalRange | null) => {
      if (logicalRange && logicalRange.from < LOAD_MORE_THRESHOLD) void loadOlder();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    const resize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    resize();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart.remove();
      chartRef.current = null;
      priceRef.current = null;
      overlayRefs.current = [];
    };
  }, [height, loadOlder]);

  // Khi nạp thêm lịch sử, giữ nguyên vùng người dùng đang nhìn thay vì nhảy về đầu.
  const previousCount = useRef(0);
  useEffect(() => {
    if (!priceRef.current || !chartRef.current) return;

    const grew = bars.length > previousCount.current && previousCount.current > 0;
    const savedRange = grew ? chartRef.current.timeScale().getVisibleLogicalRange() : null;
    const added = bars.length - previousCount.current;

    priceRef.current.setData(bars);
    // Gọi lại sau mỗi lần đổi nến: marker của lệnh cũ chỉ bám được khi nến của nó đã có mặt.
    priceRef.current.setMarkers(markers);

    if (savedRange && added > 0) {
      chartRef.current.timeScale().setVisibleLogicalRange({
        from: savedRange.from + added,
        to: savedRange.to + added,
      });
    } else if (!grew) {
      chartRef.current.timeScale().fitContent();
    }

    previousCount.current = bars.length;
  }, [bars, markers]);

  // Đường chỉ báo vẽ chồng — chỉ có khi người xem được quyền biết quy tắc.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const series of overlayRefs.current) chart.removeSeries(series);
    overlayRefs.current = [];

    result.overlays.forEach((overlay, index) => {
      const series = chart.addLineSeries({
        color: OVERLAY_COLORS[index % OVERLAY_COLORS.length],
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        title: overlay.label,
      });
      series.setData(
        overlay.points.map((p) => ({ time: toTime(p.trade_date), value: num(p.value) })) as LineData<Time>[],
      );
      overlayRefs.current.push(series);
    });
  }, [result.overlays]);

  if (!candles.length) {
    return (
      <div className="p-6">
        <EmptyState
          title="Chưa có dữ liệu giá để vẽ"
          description="Mã này chưa được đồng bộ dữ liệu ngày."
        />
      </div>
    );
  }

  return (
    <div>
      <div ref={containerRef} className="w-full" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs text-ink-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-0 border-x-4 border-b-[7px] border-x-transparent border-b-up" />
          Điểm vào lệnh
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-0 border-x-4 border-t-[7px] border-x-transparent border-t-ink-600" />
          Điểm thoát lệnh
        </span>
        {result.overlays.map((overlay, index) => (
          <span key={overlay.label} className="flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-4"
              style={{ backgroundColor: OVERLAY_COLORS[index % OVERLAY_COLORS.length] }}
            />
            {overlay.label}
          </span>
        ))}

        {ohlcvEndpoint && (
          <span className="ml-auto flex items-center gap-1.5">
            {loadingMore ? (
              <>
                <Icon name="spinner" size={13} />
                Đang tải thêm lịch sử…
              </>
            ) : exhausted ? (
              `${candles.length} phiên · đã tải hết lịch sử`
            ) : (
              `${candles.length} phiên · kéo sang trái để xem thêm`
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function StatsGrid({ result }: { result: StrategyRunResult }) {
  const s = result.stats;

  if (!s.total_trades) {
    return (
      <Card>
        <EmptyState
          title="Không có lệnh nào đã đóng"
          description="Chiến lược chưa sinh lệnh hoàn chỉnh nào trong khoảng dữ liệu này, nên chưa có thống kê."
        />
      </Card>
    );
  }

  const items: Array<{ label: string; value: string; tone?: string; hint?: string }> = [
    { label: 'Số lệnh đã đóng', value: formatNumber(s.total_trades) },
    {
      label: 'Tỷ lệ thắng',
      value: s.win_rate !== null ? `${s.win_rate}%` : '—',
      hint: `${s.wins} thắng / ${s.losses} thua`,
    },
    {
      label: 'Lãi lỗ trung bình mỗi lệnh',
      value: s.avg_profit_pct !== null ? `${s.avg_profit_pct > 0 ? '+' : ''}${s.avg_profit_pct}%` : '—',
      tone: toneOf(s.avg_profit_pct),
    },
    {
      label: 'Tổng lãi lỗ cộng dồn',
      value: s.total_return_pct !== null ? `${s.total_return_pct > 0 ? '+' : ''}${s.total_return_pct}%` : '—',
      tone: toneOf(s.total_return_pct),
      hint: 'Giả định tái đầu tư toàn bộ vào lệnh kế tiếp',
    },
    {
      label: 'Sụt giảm sâu nhất',
      value: s.max_drawdown_pct !== null ? `-${s.max_drawdown_pct}%` : '—',
      tone: 'text-down',
      hint: 'Mức lỗ sâu nhất tính từ đỉnh vốn',
    },
    {
      label: 'Hệ số lợi nhuận',
      value: s.profit_factor !== null ? String(s.profit_factor) : 'Không có lệnh lỗ',
      hint: 'Tổng lãi chia tổng lỗ; trên 1 là có lãi',
    },
    {
      label: 'Lệnh tốt nhất',
      value: s.best_pct !== null ? `+${s.best_pct}%` : '—',
      tone: 'text-up',
    },
    {
      label: 'Lệnh xấu nhất',
      value: s.worst_pct !== null ? `${s.worst_pct}%` : '—',
      tone: 'text-down',
    },
    {
      label: 'Số phiên giữ trung bình',
      value: s.avg_bars_held !== null ? String(s.avg_bars_held) : '—',
    },
    {
      label: 'Lệnh còn mở',
      value: formatNumber(s.open_trades),
      hint: 'Chưa tính vào thống kê thắng thua',
    },
  ];

  return (
    <Card>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((item) => (
          <div key={item.label}>
            <dt className="text-xs text-ink-500">{item.label}</dt>
            <dd className={cn('mt-0.5 font-semibold tabular-nums', item.tone ?? 'text-ink-900')}>
              {item.value}
            </dd>
            {item.hint && <p className="mt-0.5 text-[11px] leading-tight text-ink-400">{item.hint}</p>}
          </div>
        ))}
      </dl>
    </Card>
  );
}

function TradeTable({ trades }: { trades: RunTrade[] }) {
  const columns: Column<RunTrade>[] = [
    {
      key: 'entry',
      header: 'Vào lệnh',
      render: (t) => (
        <div>
          <p className="font-medium text-ink-900">{formatDate(t.entry_date)}</p>
          <p className="text-xs tabular-nums text-ink-500">{formatNumber(t.entry_price)}</p>
        </div>
      ),
    },
    {
      key: 'exit',
      header: 'Thoát lệnh',
      render: (t) =>
        t.is_open ? (
          <Badge tone="amber">Đang mở</Badge>
        ) : (
          <div>
            <p className="text-ink-900">{formatDate(t.exit_date!)}</p>
            <p className="text-xs tabular-nums text-ink-500">{formatNumber(t.exit_price!)}</p>
          </div>
        ),
    },
    {
      key: 'reason',
      header: 'Lý do thoát',
      render: (t) => <span className="text-sm text-ink-600">{t.exit_reason_label ?? '—'}</span>,
    },
    {
      key: 'bars',
      header: 'Số phiên giữ',
      align: 'right',
      render: (t) => <span className="tabular-nums">{t.bars_held}</span>,
    },
    {
      key: 'profit',
      header: 'Lãi lỗ',
      align: 'right',
      render: (t) =>
        t.profit_pct === null ? (
          <span className="text-ink-400">—</span>
        ) : (
          <span className={cn('font-semibold tabular-nums', toneOf(t.profit_pct))}>
            {t.profit_pct > 0 ? '+' : ''}
            {t.profit_pct}%
          </span>
        ),
    },
    {
      key: 'r',
      header: 'Bội số R',
      align: 'right',
      render: (t) =>
        t.r_multiple === null ? (
          <span className="text-ink-400">—</span>
        ) : (
          <span className={cn('tabular-nums', toneOf(t.r_multiple))}>{t.r_multiple}</span>
        ),
    },
  ];

  return (
    <Card padded={false}>
      <div className="border-b border-ink-200 px-4 py-3">
        <h3 className="font-semibold text-ink-900">Danh sách lệnh</h3>
        <p className="mt-0.5 text-xs text-ink-500">
          Mỗi dòng là một lần vào và thoát lệnh mà chiến lược sinh ra trên mã này.
        </p>
      </div>
      <Table
        columns={columns}
        rows={trades}
        rowKey={(t) => `${t.entry_date}-${t.exit_date ?? 'open'}`}
        maxHeight="24rem"
        emptyMessage="Chiến lược không sinh lệnh nào trong khoảng dữ liệu này."
        /* Một lần chạy nhiều năm dữ liệu có thể sinh hàng trăm lệnh — cuộn hết là không đọc được. */
        clientPageSize={20}
        mobileCard={(t) => (
          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-ink-900">{formatDate(t.entry_date)}</span>
              {t.profit_pct !== null && (
                <span className={cn('font-semibold tabular-nums', toneOf(t.profit_pct))}>
                  {t.profit_pct > 0 ? '+' : ''}
                  {t.profit_pct}%
                </span>
              )}
            </div>
            <p className="text-xs text-ink-500">
              {formatNumber(t.entry_price)}
              {t.is_open
                ? ' · đang mở'
                : ` → ${formatNumber(t.exit_price!)} · ${t.exit_reason_label} · ${t.bars_held} phiên`}
            </p>
          </div>
        )}
      />
    </Card>
  );
}
