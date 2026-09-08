/**
 * Quy đổi hai chiều giữa (thời gian, giá) và toạ độ pixel cho lớp công cụ vẽ.
 *
 * Chiều (thời gian, giá) → pixel đã có ở `@/lib/indicators/coords` cho lớp hình của chỉ báo, nên
 * dùng lại nguyên phần đó. Công cụ vẽ cần thêm **chiều ngược**: người dùng bấm ở đâu thì phải
 * biết đó là nến nào, giá bao nhiêu — cùng với `barSpacing` để bắt điểm neo và ngoại suy ra
 * ngoài vùng dữ liệu.
 */
import type { IChartApi, ISeriesApi, Logical, SeriesType } from 'lightweight-charts';

import { barInterval, timeToLogical, type CoordinateMapper } from '@/lib/indicators/coords';
import type { Candle } from '@/lib/indicators/math';

import type { Point } from './types';

export { timeToLogical };

export interface DrawingMapper extends CoordinateMapper {
  /** `null` khi biểu đồ chưa quy đổi được toạ độ — xem `createDrawingMapper`. */
  toTime: (x: number) => number | null;
  /**
   * x → **chỉ số nến**. Đây mới là thang đo để dời hình: khoảng cách giữa hai nến trên màn hình
   * luôn bằng nhau, còn khoảng cách theo giây thì không (cuối tuần, nghỉ lễ). Xem
   * `DrawingCanvas` chỗ kéo hình.
   */
  toLogical: (x: number) => number | null;
  toPrice: (y: number) => number | null;
  /** Khoảng cách pixel giữa hai nến — dùng cho bắt điểm và ngoại suy. */
  barSpacing: number;
}

/** Chỉ số nến (số thực) → thời gian. Ngược của `timeToLogical`. */
export function logicalToTime(candles: Candle[], logical: number): number {
  if (!candles.length) return 0;
  const interval = barInterval(candles);
  const lastIndex = candles.length - 1;

  if (logical <= 0) return Math.round(candles[0].time + logical * interval);
  if (logical >= lastIndex) {
    return Math.round(candles[lastIndex].time + (logical - lastIndex) * interval);
  }

  const low = Math.floor(logical);
  const fraction = logical - low;
  const span = candles[low + 1].time - candles[low].time;
  return Math.round(candles[low].time + fraction * span);
}

export function createDrawingMapper(
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  candles: Candle[],
): DrawingMapper {
  const timeScale = chart.timeScale();
  const visibleRange = timeScale.getVisibleLogicalRange();
  const width = chart.paneSize().width;
  const barSpacing =
    visibleRange && visibleRange.to > visibleRange.from
      ? width / (visibleRange.to - visibleRange.from)
      : 6;

  return {
    barSpacing,
    toX: (time) => timeScale.logicalToCoordinate(timeToLogical(candles, time) as Logical),
    toY: (price) => series.priceToCoordinate(price),
    /**
     * `coordinateToLogical` trả `null` mỗi khi trục thời gian tạm thời "rỗng" — chẳng hạn ngay
     * sau một `applyOptions`, trong lúc thư viện dựng lại trục.
     *
     * Không được lấp chỗ trống đó bằng `?? 0`: chỉ số logic 0 là **nến cũ nhất**, nên hình đang
     * kéo sẽ nhảy phắt về mép trái rồi mới quay lại theo con trỏ ở lần di chuột kế tiếp. Trả
     * `null` để bên gọi bỏ qua đúng một sự kiện, thứ mà mắt không kịp thấy.
     */
    toLogical: (x) => timeScale.coordinateToLogical(x),
    toTime: (x) => {
      const logical = timeScale.coordinateToLogical(x);
      return logical === null ? null : logicalToTime(candles, logical);
    },
    toPrice: (y) => series.coordinateToPrice(y) as number | null,
  };
}

/**
 * Nam châm: hút điểm neo về mức OHLC gần nhất của nến dưới con trỏ.
 *
 * Ngưỡng tính bằng **pixel** chứ không bằng giá, để cảm giác hút giống nhau ở mọi mức phóng to
 * và ở mọi mã — mã giá 12 và mã giá 120 nghìn không thể dùng chung ngưỡng theo giá.
 */
export function applyMagnet(
  point: Point,
  candles: Candle[],
  mapper: DrawingMapper,
  thresholdPx = 12,
): Point {
  if (!candles.length) return point;

  const index = Math.round(timeToLogical(candles, point.time));
  const candle = candles[Math.max(0, Math.min(candles.length - 1, index))];
  if (!candle) return point;

  const y = mapper.toY(point.price);
  if (y === null) return point;

  let best: { price: number; distance: number } | null = null;
  for (const price of [candle.open, candle.high, candle.low, candle.close]) {
    const candidateY = mapper.toY(price);
    if (candidateY === null) continue;
    const distance = Math.abs(candidateY - y);
    if (!best || distance < best.distance) best = { price, distance };
  }

  return best && best.distance <= thresholdPx ? { time: candle.time, price: best.price } : point;
}

/** Kéo thời gian về đúng phiên gần nhất (không đụng tới giá). */
export function snapTimeToBar(time: number, candles: Candle[]): number {
  if (!candles.length) return time;
  const index = Math.round(timeToLogical(candles, time));
  // Ngoài vùng dữ liệu thì giữ nguyên — không có phiên nào để bám vào.
  if (index < 0 || index > candles.length - 1) return time;
  return candles[index].time;
}
