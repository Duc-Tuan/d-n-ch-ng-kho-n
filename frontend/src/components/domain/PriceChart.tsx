'use client';

/**
 * Biểu đồ nến cho bảng giá.
 *
 * Dùng chung `lightweight-charts` với `StrategyChart` để hai màn có cùng cảm giác thao tác
 * (phóng to, kéo, tooltip) thay vì mỗi nơi một thư viện.
 *
 * YC9 — cuộn về quá khứ thì **tự tải thêm nến cũ**. Không có phần này, người dùng kéo tới mép
 * trái là hết dữ liệu và tưởng hệ thống chỉ có bấy nhiêu lịch sử.
 *
 * Chỉ báo kỹ thuật dùng chung danh mục ở `@/lib/indicators`. Chúng chia làm hai chỗ vẽ, và sự
 * khác nhau đó quyết định toàn bộ cấu trúc bên dưới:
 *
 * * **Vẽ đè lên nến** (MA, Bollinger, Ichimoku, SuperTrend, bộ SMC…) — thêm đường vào chính
 *   biểu đồ giá, còn hộp/đường/nhãn thì vẽ tay lên `ShapesLayer`.
 * * **Cửa sổ riêng** (RSI, MACD, ADX…) — mỗi cái là một biểu đồ độc lập xếp bên dưới, vì thang
 *   giá của chúng không liên quan gì tới giá cổ phiếu. `useChartSync` ghép chúng lại thành một
 *   khối: cùng khoảng nhìn, cùng đường ngắm, cùng bề rộng cột giá.
 */
import {
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button, Icon, IconButton } from '@/components/ui';
import { useIsMobile } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Candle as IndicatorCandle } from '@/lib/indicators/math';
import { getIndicator, instanceLabel } from '@/lib/indicators/registry';
import type {
  IndicatorDef,
  IndicatorInstance,
  IndicatorShapes,
  PlotDef,
} from '@/lib/indicators/types';
import { toIndicatorCandles } from '@/lib/indicators/snapshot';
import type { Candle, OhlcvResponse } from '@/types';

import { LINE_STYLE_MAP, baseChartOptions, down, up } from './chart/chartTheme';
import { IndicatorPane, PaneButton } from './chart/IndicatorPane';
import { IndicatorSettingsModal } from './chart/IndicatorSettingsModal';
import { IndicatorsModal } from './chart/IndicatorsModal';
import { ShapesLayer } from './chart/ShapesLayer';
import { useChartSync } from './chart/useChartSync';
import { useElementSize } from './chart/useElementSize';
import type { IndicatorStore } from './chart/useIndicators';

const RANGES = [
  { key: '3m', label: '3 tháng', bars: 63 },
  { key: '6m', label: '6 tháng', bars: 126 },
  { key: '1y', label: '1 năm', bars: 252 },
  { key: 'all', label: 'Tất cả', bars: 0 },
];

/** Số nến còn lại bên trái trước khi bắt đầu tải thêm — tải sớm để không thấy khoảng trắng. */
const LOAD_MORE_THRESHOLD = 20;
const LOAD_MORE_SIZE = 300;

/** Chiều cao một cửa sổ chỉ báo. Đủ để đọc RSI, không lấn quá nhiều phần nến. */
const PANE_HEIGHT = 120;

export function PriceChart({
  symbol,
  candles: initialCandles,
  indicators,
  height = 420,
  attribution,
}: {
  /** Truyền `symbol` để bật tải thêm lịch sử khi cuộn. Bỏ trống thì chỉ hiển thị tĩnh. */
  symbol?: string;
  candles: Candle[];
  /**
   * Bộ chỉ báo, do màn cha giữ (`useIndicators`).
   *
   * Không tự giữ bên trong biểu đồ: nút AI phân tích ở màn bảng giá cần đúng bộ chỉ báo này để
   * gửi đi, mà nó nằm ngoài biểu đồ. Trạng thái nằm ở chỗ cả hai cùng với tới được.
   */
  indicators: IndicatorStore;
  height?: number;
  attribution?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  /** `instanceId__plotKey` → đường của chỉ báo vẽ đè, để cập nhật và gỡ đúng cái. */
  const overlaySeriesRef = useRef<Map<string, ISeriesApi<SeriesType>>>(new Map());

  const isMobile = useIsMobile();
  const size = useElementSize(hostRef);

  const [range, setRange] = useState('1y');
  const [fullscreen, setFullscreen] = useState(false);
  const [candles, setCandles] = useState<Candle[]>(initialCandles);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  /** Tăng mỗi lần biểu đồ được dựng lại. Series mới luôn **rỗng**, nên mọi effect nạp dữ liệu
   *  vào nó phải chạy lại — không có mốc này thì biểu đồ trắng cho tới lần đổi dữ liệu kế tiếp. */
  const [epoch, setEpoch] = useState(0);

  const sync = useChartSync();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);

  // Dùng ref trong callback của biểu đồ để không phải gắn lại sự kiện mỗi lần dữ liệu đổi.
  const stateRef = useRef({ candles, loadingMore, exhausted, symbol });
  stateRef.current = { candles, loadingMore, exhausted, symbol };

  // Đổi mã thì bắt đầu lại từ dữ liệu mới.
  useEffect(() => {
    setCandles(initialCandles);
    setExhausted(false);
  }, [initialCandles, symbol]);

  /* ── Toàn màn hình ─────────────────────────────────────────────────────── */

  /**
   * Xin toàn màn hình **của cả trang** (`documentElement`) chứ không của riêng khung biểu đồ.
   *
   * Modal chọn chỉ báo render qua portal gắn vào `<body>`, tức nằm ngoài khung biểu đồ. Nếu
   * phần tử toàn màn hình là khung đó, trình duyệt chỉ vẽ phần tử ấy và cây con của nó — bấm
   * "Chỉ báo" sẽ không thấy gì hiện ra.
   *
   * Trình duyệt có thể từ chối (Safari trên iPhone không cho phần tử thường vào toàn màn hình).
   * Lúc đó vẫn còn lớp phủ `fixed inset-0` bên dưới, nên biểu đồ vẫn chiếm trọn khung nhìn,
   * chỉ là thanh trình duyệt còn đó.
   */
  useEffect(() => {
    if (!fullscreen) return;

    document.documentElement.requestFullscreen?.()?.catch(() => {});

    // Người dùng có thể thoát toàn màn hình bằng Esc hay F11 mà không qua nút của mình —
    // phải nghe lại để lớp phủ đóng theo, không thì màn hình kẹt ở trạng thái nửa vời.
    const onChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener('fullscreenchange', onChange);

    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [fullscreen]);

  // Esc để thoát — nhưng nhường cho modal đang mở, vì Esc của nó phải đóng modal trước.
  useEffect(() => {
    if (!fullscreen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pickerOpen && !settingsId) setFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen, pickerOpen, settingsId]);

  // Khoá cuộn nền: lớp phủ che kín rồi, để trang phía sau cuộn được chỉ gây trôi vị trí khi thoát.
  useEffect(() => {
    if (!fullscreen) return;

    const { body } = document;
    const previous = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previous;
    };
  }, [fullscreen]);

  /** YC9 — tải thêm nến cũ hơn nến sớm nhất đang có. */
  const loadOlder = useCallback(async () => {
    const state = stateRef.current;
    if (!state.symbol || state.loadingMore || state.exhausted || !state.candles.length) return;

    setLoadingMore(true);
    try {
      const earliest = state.candles[0].trade_date;
      // Lùi một ngày để không lấy trùng nến đang có ở mép.
      const before = new Date(earliest);
      before.setDate(before.getDate() - 1);

      const response = await api.get<OhlcvResponse>(`${CUSTOMER}/market/ohlcv`, {
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
      // Hết dữ liệu hoặc lỗi mạng — dừng tải thêm, không báo lỗi ồn ào giữa thao tác cuộn.
      setExhausted(true);
    } finally {
      setLoadingMore(false);
    }
  }, []);

  /**
   * Áp khoảng đang chọn lên **vùng nhìn** của biểu đồ.
   *
   * Trước đây khoảng này cắt bớt mảng nến trước khi vẽ, kèm điều kiện "chỉ cắt khi số nến đã
   * tải không quá gấp đôi khoảng chọn". Màn bảng giá nạp sẵn 400 phiên, nên 3 tháng (63 phiên)
   * và 6 tháng (126 phiên) không bao giờ thoả điều kiện đó — bấm vào không có gì xảy ra. Nới
   * rộng khoảng cũng hỏng nốt: số nến vẽ tăng lên bị nhầm là "vừa nạp thêm lịch sử" nên vùng
   * nhìn được giữ nguyên thay vì mở ra.
   *
   * Giữ nguyên toàn bộ nến trong chuỗi và chỉ đổi vùng nhìn là cách các biểu đồ giá vẫn làm:
   * kéo ngược về quá khứ vẫn thấy phần ngoài khoảng, và nút khoảng luôn có tác dụng.
   */
  const applyRange = useCallback(
    (count: number) => {
      const chart = chartRef.current;
      if (!chart || !count) return;

      const span = RANGES.find((r) => r.key === range)?.bars ?? 0;
      if (!span || span >= count) {
        chart.timeScale().fitContent();
        return;
      }
      chart.timeScale().setVisibleLogicalRange({ from: count - span, to: count - 1 });
    },
    [range],
  );

  /** Nến ở dạng chỉ báo cần: thời gian là giây unix, mọi giá trị đã ép số. */
  const series = useMemo<IndicatorCandle[]>(() => toIndicatorCandles(candles), [candles]);

  const { bars, volumes } = useMemo(() => {
    const bars: CandlestickData<Time>[] = [];
    const volumes: HistogramData<Time>[] = [];

    for (const c of series) {
      const time = c.time as Time;
      bars.push({ time, open: c.open, high: c.high, low: c.low, close: c.close });
      volumes.push({
        time,
        value: c.volume,
        // Khối lượng tô theo chiều giá phiên đó — nhìn là biết phiên tăng hay giảm.
        color: c.close >= c.open ? up(0.33) : down(0.33),
      });
    }
    return { bars, volumes };
  }, [series]);

  /* ── Chỉ báo đang bật ──────────────────────────────────────────────────── */

  const activeOverlays = useMemo(
    () =>
      indicators.overlays
        .filter((instance) => instance.visible)
        .map((instance) => ({ instance, def: getIndicator(instance.defId) }))
        .filter((entry): entry is { instance: IndicatorInstance; def: IndicatorDef } =>
          Boolean(entry.def),
        ),
    [indicators.overlays],
  );

  const overlayData = useMemo(
    () =>
      activeOverlays.map(({ instance, def }) => ({
        instance,
        def,
        result: def.compute(series, instance.params),
      })),
    [activeOverlays, series],
  );

  /** Hộp, đường và nhãn của bộ SMC / ZigZag / UT Bot — gộp từ mọi chỉ báo đang bật. */
  const shapes = useMemo<IndicatorShapes>(() => {
    const boxes: NonNullable<IndicatorShapes['boxes']> = [];
    const lines: NonNullable<IndicatorShapes['lines']> = [];
    const markers: NonNullable<IndicatorShapes['markers']> = [];
    const labels: NonNullable<IndicatorShapes['labels']> = [];

    for (const { instance, def } of activeOverlays) {
      const out = def.computeShapes?.(series, instance.params);
      if (!out) continue;
      if (out.boxes) boxes.push(...out.boxes);
      if (out.lines) lines.push(...out.lines);
      if (out.markers) markers.push(...out.markers);
      if (out.labels) labels.push(...out.labels);
    }

    // `setMarkers` đòi thứ tự thời gian tăng dần, nếu không nó bỏ qua phần lệch.
    markers.sort((a, b) => a.time - b.time);
    return { boxes, lines, markers, labels };
  }, [activeOverlays, series]);

  /** Trục thời gian luôn nằm ở biểu đồ **cuối cùng còn hiện** — vẽ ở mọi cái là lặp ba lần. */
  const lastVisiblePane = indicators.panes.filter((item) => item.visible).at(-1)?.instanceId;

  /* ── Dựng biểu đồ giá ──────────────────────────────────────────────────── */

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      ...baseChartOptions(),
      height,
      // BR-846 — trên điện thoại không cho kéo dọc trong biểu đồ, tránh tranh chấp với cuộn trang.
      handleScroll: { vertTouchDrag: !isMobile },
      handleScale: { pinch: true },
    });

    const price = chart.addCandlestickSeries({
      upColor: up(),
      downColor: down(),
      borderVisible: false,
      wickUpColor: up(),
      wickDownColor: down(),
    });

    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chartRef.current = chart;
    priceRef.current = price;
    volumeRef.current = volume;
    sync.register(chart);
    sync.registerSeries(chart, price);
    setEpoch((value) => value + 1);

    // YC9 — cuộn tới gần mép trái thì nạp thêm lịch sử.
    const onRangeChange = (logicalRange: LogicalRange | null) => {
      if (logicalRange && logicalRange.from < LOAD_MORE_THRESHOLD) void loadOlder();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      sync.unregister(chart);
      chart.remove();
      chartRef.current = null;
      priceRef.current = null;
      volumeRef.current = null;
      overlaySeriesRef.current.clear();
    };
  }, [height, isMobile, loadOlder, sync]);

  // Bề rộng theo khung chứa chứ không theo cửa sổ trình duyệt: khung còn co giãn khi mở/đóng
  // một cửa sổ chỉ báo hay khi cột bảng giá bên trái đổi kích thước.
  useEffect(() => {
    if (size.width) chartRef.current?.applyOptions({ width: size.width });
  }, [size.width]);

  // Chiều cao cũng lấy từ khung chứa, không chỉ từ prop `height`: lúc toàn màn hình khung được
  // kéo giãn bằng CSS (`flex-1`) nên prop không đổi, mà biểu đồ thì phải cao lên theo.
  useEffect(() => {
    if (size.height) chartRef.current?.applyOptions({ height: size.height });
  }, [size.height]);

  useEffect(() => {
    chartRef.current?.applyOptions({ timeScale: { visible: !lastVisiblePane } });
  }, [lastVisiblePane]);

  // Khi nạp thêm lịch sử, giữ nguyên vùng người dùng đang nhìn thay vì nhảy về đầu.
  const previousCount = useRef(0);
  useEffect(() => {
    if (!priceRef.current) return;

    const grew = bars.length > previousCount.current && previousCount.current > 0;
    const savedRange = grew ? chartRef.current?.timeScale().getVisibleLogicalRange() : null;
    const added = bars.length - previousCount.current;

    priceRef.current.setData(bars);
    volumeRef.current?.setData(volumes);

    if (savedRange && added > 0) {
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from: savedRange.from + added,
        to: savedRange.to + added,
      });
    } else if (!grew) {
      // Lần vẽ đầu, và mỗi lần đổi khoảng: số nến không tăng nên nhánh này chạy.
      applyRange(bars.length);
    }

    previousCount.current = bars.length;
  }, [bars, volumes, applyRange, epoch]);

  /* ── Đường của chỉ báo vẽ đè ───────────────────────────────────────────── */

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const seriesMap = overlaySeriesRef.current;
    const activeKeys = new Set<string>();

    for (const { instance, def, result } of overlayData) {
      for (const plot of def.plots) {
        const style: PlotDef = { ...plot, ...instance.styleOverrides[plot.key] };
        if (style.hidden) continue;

        const key = `${instance.instanceId}__${plot.key}`;
        activeKeys.add(key);

        let line = seriesMap.get(key);
        if (!line) {
          line = chart.addLineSeries({
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          seriesMap.set(key, line);
        }

        line.applyOptions({
          color: style.color,
          lineWidth: style.lineWidth ?? 1,
          lineStyle: LINE_STYLE_MAP[style.lineStyle ?? 'solid'],
        });

        // Đường vẽ đè dùng chung trục giá với nến, nên bỏ hẳn nến chưa tính được là đúng —
        // khác với cửa sổ riêng, nơi phải đẩy vào khoảng trắng để trục thời gian khỏi lệch.
        const points: { time: UTCTimestamp; value: number }[] = [];
        const values = result[plot.key] ?? [];
        for (let i = 0; i < values.length; i++) {
          const value = values[i];
          if (value === null || !Number.isFinite(value)) continue;
          points.push({ time: series[i].time as UTCTimestamp, value });
        }
        line.setData(points);
      }
    }

    // Dọn đường của chỉ báo đã gỡ hoặc plot vừa bị ẩn.
    for (const [key, line] of seriesMap) {
      if (!activeKeys.has(key)) {
        chart.removeSeries(line);
        seriesMap.delete(key);
      }
    }
  }, [overlayData, series, epoch]);

  const markers = shapes.markers;
  useEffect(() => {
    priceRef.current?.setMarkers(
      (markers ?? []).map((marker) => ({
        time: marker.time as UTCTimestamp,
        position: marker.position,
        shape: marker.shape,
        color: marker.color,
        text: marker.text,
      })),
    );
  }, [markers, epoch]);

  // Cửa sổ chỉ báo đăng ký biểu đồ trước khi có dữ liệu, mà `setData` đầu tiên lại kéo khoảng
  // nhìn về mặc định của thư viện — phải áp lại sau khi chúng đã có nến.
  useEffect(() => {
    const id = requestAnimationFrame(() => sync.realign());
    return () => cancelAnimationFrame(id);
  }, [indicators.panes.length, series.length, sync]);

  const settingsInstance =
    indicators.indicators.find((item) => item.instanceId === settingsId) ?? null;

  return (
    <div
      className={cn(
        'space-y-3',
        fullscreen && 'fixed inset-0 z-50 flex flex-col bg-surface p-3 sm:p-4',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {/* Ra khỏi trang thì mất luôn phần đầu thẻ ghi mã đang xem — nhắc lại ở đây. */}
          {fullscreen && symbol && (
            <span className="mr-2 text-base font-semibold text-ink-900">{symbol}</span>
          )}

          {RANGES.map((item) => (
            <button
              key={item.key}
              onClick={() => setRange(item.key)}
              className={cn(
                'min-h-touch rounded-lg px-3 text-sm transition-colors',
                range === item.key
                  ? 'bg-primary font-medium text-primary-fg'
                  : 'text-ink-600 hover:bg-ink-100',
              )}
            >
              {item.label}
            </button>
          ))}

          <Button
            variant="outline"
            size="sm"
            className="ml-1"
            onClick={() => setPickerOpen(true)}
            leftIcon={<Icon name="chart" size={15} />}
          >
            Chỉ báo
            {indicators.indicators.length > 0 && (
              <span className="ml-1.5 rounded-full bg-ink-100 px-1.5 text-xs tabular-nums text-ink-700">
                {indicators.indicators.length}
              </span>
            )}
          </Button>
        </div>

        <span className="flex items-center gap-2 text-xs text-ink-500">
          {loadingMore ? (
            <>
              <Icon name="spinner" size={13} />
              Đang tải thêm lịch sử…
            </>
          ) : (
            <>
              {candles.length} phiên
              {exhausted && ' · đã tải hết lịch sử'}
            </>
          )}

          <IconButton
            size="sm"
            variant="outline"
            label={fullscreen ? 'Thu nhỏ biểu đồ (Esc)' : 'Phóng to toàn màn hình'}
            onClick={() => setFullscreen((on) => !on)}
          >
            <Icon name={fullscreen ? 'minimize' : 'maximize'} size={16} />
          </IconButton>
        </span>
      </div>

      <div
        className={cn(
          'overflow-hidden rounded-lg border border-ink-200',
          fullscreen && 'flex min-h-0 flex-1 flex-col',
        )}
      >
        <div
          ref={hostRef}
          className={cn('relative w-full', fullscreen && 'min-h-0 flex-1')}
          style={fullscreen ? undefined : { height }}
        >
          <div ref={containerRef} className="absolute inset-0" />

          {/* Nhãn các chỉ báo vẽ đè: tên, và nút chỉnh ngay tại chỗ đang nhìn thấy đường đó. */}
          {indicators.overlays.length > 0 && (
            <div className="pointer-events-none absolute left-2 top-1 z-10 flex flex-col gap-0.5">
              {indicators.overlays.map((instance) => (
                <span
                  key={instance.instanceId}
                  className="group pointer-events-auto flex w-fit items-center gap-1 rounded bg-surface/85 px-1 text-xs"
                >
                  <span className={cn('font-medium', instance.visible ? 'text-ink-700' : 'text-ink-400 line-through')}>
                    {instanceLabel(instance)}
                  </span>
                  <span className="flex items-center gap-0.5 opacity-50 transition-opacity group-hover:opacity-100">
                    <PaneButton
                      icon="settings"
                      label="Cài đặt chỉ báo"
                      onClick={() => setSettingsId(instance.instanceId)}
                    />
                    <PaneButton
                      icon={instance.visible ? 'eye' : 'eye-off'}
                      label={instance.visible ? 'Ẩn chỉ báo' : 'Hiện chỉ báo'}
                      onClick={() => indicators.toggleVisible(instance.instanceId)}
                    />
                    <PaneButton
                      icon="trash"
                      label="Bỏ chỉ báo"
                      danger
                      onClick={() => indicators.remove(instance.instanceId)}
                    />
                  </span>
                </span>
              ))}
            </div>
          )}

          <ShapesLayer
            chart={chartRef.current}
            series={priceRef.current}
            candles={series}
            width={size.width}
            height={size.height}
            shapes={shapes}
          />
        </div>

        {indicators.panes.map((instance) =>
          instance.visible ? (
            <IndicatorPane
              key={instance.instanceId}
              instance={instance}
              candles={series}
              height={PANE_HEIGHT}
              showTimeScale={instance.instanceId === lastVisiblePane}
              onChartReady={sync.register}
              onChartDestroy={sync.unregister}
              onSeriesReady={sync.registerSeries}
              onOpenSettings={setSettingsId}
              onToggleVisible={indicators.toggleVisible}
              onRemove={indicators.remove}
            />
          ) : (
            /* Ẩn thì gỡ hẳn biểu đồ cho đỡ tính toán, nhưng phải chừa một thanh mỏng — không
               thì không còn chỗ nào để bật hiện lại. */
            <div
              key={instance.instanceId}
              className="flex h-8 items-center gap-1 border-t border-ink-200 bg-ink-50 px-2 text-xs"
            >
              <span className="text-ink-400 line-through">{instanceLabel(instance)}</span>
              <span className="text-ink-400">— đang ẩn</span>
              <span className="ml-auto flex items-center gap-0.5">
                <PaneButton
                  icon="eye-off"
                  label="Hiện lại chỉ báo"
                  onClick={() => indicators.toggleVisible(instance.instanceId)}
                />
                <PaneButton
                  icon="trash"
                  label="Bỏ chỉ báo"
                  danger
                  onClick={() => indicators.remove(instance.instanceId)}
                />
              </span>
            </div>
          ),
        )}
      </div>

      {/* BR-836 — ghi rõ nguồn dữ liệu dưới biểu đồ.

          Kèm luôn ghi công thư viện vẽ: logo TradingView đã tắt ở `chartTheme` vì nó nổi đè lên
          góc dưới phải, đúng chỗ nến mới nhất. Giấy phép Apache-2.0 đòi giữ phần ghi công chứ
          không đòi giữ đúng cái logo — nên nó chuyển xuống đây thành một dòng chữ. */}
      <p className="text-xs text-ink-500">
        {attribution ? `${attribution} · ` : ''}
        Biểu đồ:{' '}
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 hover:text-ink-700 hover:underline"
        >
          TradingView Lightweight Charts™
        </a>
      </p>
      {symbol && !exhausted && (
        <p className="text-xs text-ink-400">Kéo biểu đồ sang trái để xem thêm lịch sử.</p>
      )}

      <IndicatorsModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        indicators={indicators.indicators}
        paneCount={indicators.panes.length}
        onAdd={indicators.add}
        onRemoveByDef={indicators.removeByDef}
      />

      <IndicatorSettingsModal
        instance={settingsInstance}
        onClose={() => setSettingsId(null)}
        onApplyParams={indicators.setParams}
        onPatchStyle={indicators.setStyle}
      />
    </div>
  );
}
