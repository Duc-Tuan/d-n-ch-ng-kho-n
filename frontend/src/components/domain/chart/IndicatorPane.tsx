'use client';

/**
 * Một cửa sổ chỉ báo (RSI, MACD, Khối lượng…) = một biểu đồ riêng xếp dưới biểu đồ giá.
 *
 * Việc ghép chúng lại thành một khối liền mạch — cùng khoảng nhìn, cùng đường ngắm, cùng bề
 * rộng cột giá — do `useChartSync` lo; ở đây chỉ dựng series và nhãn giá trị.
 */
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { Candle } from '@/lib/indicators/math';
import { getIndicator, instanceLabel } from '@/lib/indicators/registry';
import type { IndicatorInstance, PlotDef } from '@/lib/indicators/types';

import { LINE_STYLE_MAP, PRICE_SCALE_MIN_WIDTH, baseChartOptions, chartColors } from './chartTheme';
import { useElementSize } from './useElementSize';

function paneOptions(showTimeScale: boolean) {
  return baseChartOptions({
    timeScale: { visible: showTimeScale, borderVisible: showTimeScale },
    rightPriceScale: {
      borderColor: chartColors().border,
      scaleMargins: { top: 0.15, bottom: 0.15 },
      minimumWidth: PRICE_SCALE_MIN_WIDTH,
    },
    handleScale: { axisPressedMouseMove: false },
  });
}

/** Số làm tròn cho nhãn giá trị trên đầu cửa sổ. */
function format(value: number, precision: number): string {
  return value.toLocaleString('vi-VN', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

export function IndicatorPane({
  instance,
  candles,
  height,
  showTimeScale,
  onChartReady,
  onChartDestroy,
  onSeriesReady,
  onOpenSettings,
  onToggleVisible,
  onRemove,
}: {
  instance: IndicatorInstance;
  candles: Candle[];
  height: number;
  /** Chỉ cửa sổ dưới cùng mới vẽ trục thời gian — vẽ ở mọi cửa sổ là ba lần cùng một dãy ngày. */
  showTimeScale: boolean;
  onChartReady: (chart: IChartApi) => void;
  onChartDestroy: (chart: IChartApi) => void;
  onSeriesReady: (chart: IChartApi, series: ISeriesApi<SeriesType>) => void;
  onOpenSettings: (instanceId: string) => void;
  onToggleVisible: (instanceId: string) => void;
  onRemove: (instanceId: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartDivRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<SeriesType>>>(new Map());
  const size = useElementSize(hostRef);

  const [hover, setHover] = useState<Record<string, number | null>>({});

  const def = getIndicator(instance.defId);
  const result = useMemo(
    () => (def ? def.compute(candles, instance.params) : {}),
    [def, candles, instance.params],
  );

  // Các callback đọc qua ref: chúng đổi tham chiếu mỗi lần render, mà biểu đồ chỉ được tạo một
  // lần — đưa vào deps là dựng lại biểu đồ liên tục.
  const handlers = useRef({ onChartReady, onChartDestroy, onSeriesReady });
  handlers.current = { onChartReady, onChartDestroy, onSeriesReady };

  useEffect(() => {
    const container = chartDivRef.current;
    if (!container || !def) return;

    const chart = createChart(container, paneOptions(showTimeScale));
    chartRef.current = chart;
    handlers.current.onChartReady(chart);

    return () => {
      handlers.current.onChartDestroy(chart);
      chart.remove();
      chartRef.current = null;
      seriesRef.current.clear();
    };
    // Trục thời gian bật/tắt bằng `applyOptions` bên dưới, không dựng lại biểu đồ.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def?.id]);

  useEffect(() => {
    chartRef.current?.applyOptions(paneOptions(showTimeScale));
  }, [showTimeScale]);

  useEffect(() => {
    if (size.width && size.height) {
      chartRef.current?.applyOptions({ width: size.width, height: size.height });
    }
  }, [size.width, size.height]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !def) return;

    const map = seriesRef.current;
    const activeKeys = new Set<string>();

    for (const plot of def.plots) {
      const style: PlotDef = { ...plot, ...instance.styleOverrides[plot.key] };
      if (style.hidden) continue;

      activeKeys.add(plot.key);
      let series = map.get(plot.key);

      if (!series) {
        series =
          style.type === 'histogram'
            ? chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false })
            : chart.addLineSeries({
                priceLineVisible: false,
                lastValueVisible: false,
                crosshairMarkerVisible: false,
              });
        map.set(plot.key, series);

        // Mức ngang cố định (RSI 70/30, CCI ±100) gắn vào series đầu tiên của cửa sổ.
        if (def.levels && map.size === 1) {
          for (const level of def.levels) {
            series.createPriceLine({
              price: level.value,
              color: level.color,
              lineWidth: 1,
              lineStyle: LINE_STYLE_MAP[level.lineStyle ?? 'dashed'],
              axisLabelVisible: false,
              title: level.label ?? '',
            });
          }
        }
      }

      const precision = def.precision ?? 2;
      series.applyOptions({
        priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision },
        ...(style.type === 'histogram'
          ? { color: style.color }
          : {
              color: style.color,
              lineWidth: style.lineWidth ?? 1,
              lineStyle: LINE_STYLE_MAP[style.lineStyle ?? 'solid'],
            }),
      } as never);

      /**
       * Nến chưa đủ dữ liệu phải đẩy vào dạng **khoảng trắng** (`{ time }` không kèm `value`),
       * tuyệt đối không được bỏ qua. Trục thời gian của mỗi biểu đồ dựng từ chính dữ liệu của
       * nó; bỏ mất mấy chục nến đầu thì chỉ số logic 0 của cửa sổ này là nến thứ 25 của biểu đồ
       * giá — mà khoảng nhìn và đường ngắm đồng bộ **theo chỉ số logic**, nên cửa sổ bị đẩy
       * lệch đúng bấy nhiêu nến.
       */
      const points: ({ time: UTCTimestamp } | { time: UTCTimestamp; value: number; color?: string })[] =
        [];
      const values = result[plot.key] ?? [];

      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        const time = candles[i].time as UTCTimestamp;
        if (value === null || !Number.isFinite(value)) {
          points.push({ time });
          continue;
        }
        const point: { time: UTCTimestamp; value: number; color?: string } = {
          time,
          value: style.plotAbs ? Math.abs(value) : value,
        };
        if (style.colorBySign) {
          point.color = value >= 0 ? style.colorBySign.positive : style.colorBySign.negative;
        } else if (style.colorByCandle) {
          const candle = candles[i];
          point.color =
            candle.close >= candle.open ? style.colorByCandle.up : style.colorByCandle.down;
        }
        points.push(point);
      }
      series.setData(points as never);
    }

    for (const [key, series] of map) {
      if (!activeKeys.has(key)) {
        chart.removeSeries(series);
        map.delete(key);
      }
    }

    const first = map.values().next().value as ISeriesApi<SeriesType> | undefined;

    // RSI/Stochastic phải khoá 0–100. v4 không cho đặt thẳng khoảng giá; cách duy nhất là ghi
    // đè `autoscaleInfoProvider` của một series trong cửa sổ.
    const range = def.fixedRange;
    if (range) {
      first?.applyOptions({
        autoscaleInfoProvider: () => ({
          priceRange: { minValue: range.min, maxValue: range.max },
        }),
      });
    }

    if (first) handlers.current.onSeriesReady(chart, first);
  }, [def, instance.styleOverrides, result, candles]);

  // Giá trị hiện dưới tên chỉ báo: theo đường ngắm nếu đang rê chuột, còn lại là phiên cuối.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !def) return;

    const handler = (param: { time?: unknown }) => {
      const index = param.time
        ? candles.findIndex((c) => c.time === (param.time as number))
        : candles.length - 1;
      if (index < 0) return;

      const next: Record<string, number | null> = {};
      for (const plot of def.plots) next[plot.key] = result[plot.key]?.[index] ?? null;
      setHover(next);
    };

    handler({});
    chart.subscribeCrosshairMove(handler);
    return () => chart.unsubscribeCrosshairMove(handler);
  }, [def, result, candles]);

  if (!def) return null;

  return (
    <div ref={hostRef} className="group relative w-full border-t border-ink-200" style={{ height }}>
      <div ref={chartDivRef} className="absolute inset-0" />

      <div className="pointer-events-auto absolute left-2 top-1 z-10 flex w-fit flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <span className="font-medium text-ink-700">{instanceLabel(instance)}</span>

        {def.plots.map((plot) => {
          const style = { ...plot, ...instance.styleOverrides[plot.key] };
          const value = hover[plot.key];
          if (style.hidden || value === undefined || value === null) return null;
          return (
            <span key={plot.key} className="flex items-center gap-1 tabular-nums text-ink-500">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: style.color }}
                aria-hidden
              />
              {format(style.plotAbs ? Math.abs(value) : value, def.precision ?? 2)}
            </span>
          );
        })}

        {/* Cụm nút mờ đi cho tới khi trỏ vào cửa sổ: chúng là thao tác phụ, không nên tranh
            sự chú ý với chính đường chỉ báo. Trên thiết bị cảm ứng không có `hover` nên luôn
            hiện mờ — vẫn bấm được. */}
        <span className="ml-1 flex items-center gap-0.5 opacity-50 transition-opacity group-hover:opacity-100">
          <PaneButton
            icon="settings"
            label="Cài đặt chỉ báo"
            onClick={() => onOpenSettings(instance.instanceId)}
          />
          <PaneButton
            icon={instance.visible ? 'eye' : 'eye-off'}
            label={instance.visible ? 'Ẩn chỉ báo' : 'Hiện chỉ báo'}
            onClick={() => onToggleVisible(instance.instanceId)}
          />
          <PaneButton
            icon="trash"
            label="Bỏ chỉ báo"
            danger
            onClick={() => onRemove(instance.instanceId)}
          />
        </span>
      </div>
    </div>
  );
}

export function PaneButton({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: 'settings' | 'eye' | 'eye-off' | 'trash';
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'rounded p-1 text-ink-500 transition-colors hover:bg-ink-100',
        danger ? 'hover:text-down' : 'hover:text-ink-900',
      )}
    >
      <Icon name={icon} size={13} />
    </button>
  );
}
