/**
 * Quy đổi (thời gian, giá) ↔ toạ độ pixel cho lớp vẽ hình của chỉ báo.
 *
 * Không dùng thẳng `timeScale().timeToCoordinate()`: hàm đó trả `null` với mọi mốc thời gian
 * không trùng một nến có thật, nên mọi thứ neo ra ngoài vùng dữ liệu — hộp Order Block kéo dài
 * sang phải, đường ngang chạy tới tương lai — sẽ không vẽ được. Thay vào đó quy time về **chỉ số
 * logic** (số thực, cho phép âm và vượt quá nến cuối) rồi dùng `logicalToCoordinate`, vốn ngoại
 * suy tuyến tính được.
 */
import type { IChartApi, ISeriesApi, Logical, SeriesType } from 'lightweight-charts';

import type { Candle } from '@/lib/indicators/math';

export interface CoordinateMapper {
  toX: (time: number) => number | null;
  toY: (price: number) => number | null;
}

/** Khoảng cách thời gian giữa hai nến. Lấy trung vị để nghỉ lễ và cuối tuần không kéo lệch. */
export function barInterval(candles: Candle[]): number {
  if (candles.length < 2) return 86_400;
  const diffs: number[] = [];
  for (let i = 1; i < Math.min(candles.length, 50); i++) {
    diffs.push(candles[i].time - candles[i - 1].time);
  }
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] || 86_400;
}

/** time → chỉ số nến (số thực). Ngoài biên thì ngoại suy theo `barInterval`. */
export function timeToLogical(candles: Candle[], time: number): number {
  if (!candles.length) return 0;
  const interval = barInterval(candles);

  if (time <= candles[0].time) return -(candles[0].time - time) / interval;

  const lastIndex = candles.length - 1;
  if (time >= candles[lastIndex].time) {
    return lastIndex + (time - candles[lastIndex].time) / interval;
  }

  let low = 0;
  let high = lastIndex;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (candles[mid].time <= time) low = mid;
    else high = mid;
  }
  const span = candles[high].time - candles[low].time;
  const fraction = span === 0 ? 0 : (time - candles[low].time) / span;
  return low + fraction;
}

export function createMapper(
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  candles: Candle[],
): CoordinateMapper {
  const timeScale = chart.timeScale();
  return {
    toX: (time) => timeScale.logicalToCoordinate(timeToLogical(candles, time) as Logical),
    toY: (price) => series.priceToCoordinate(price),
  };
}
