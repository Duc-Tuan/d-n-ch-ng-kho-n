/**
 * Chụp lại bộ chỉ báo đang bật để gửi cho AI phân tích.
 *
 * Vì sao giao diện tính rồi gửi lên, thay vì máy chủ tự tính: công thức của cả 37 chỉ báo nằm
 * ở đây. Chép sang Python là nhân đôi, và hai bản sẽ trôi khỏi nhau — lúc đó con số mô hình
 * đọc không còn là con số người dùng đang nhìn trên biểu đồ, mà đó chính là thứ khiến nhận
 * định mất giá trị.
 *
 * Hai giới hạn được ép ngay tại đây, vì cả hai đều là lỗi im lặng nếu bỏ qua:
 *
 * * **Số điểm mỗi đường** — 60 phiên gần nhất là đủ để thấy xu hướng và các lần cắt nhau; gửi
 *   cả 400 phiên × nhiều chỉ báo thì kết quả MCP vượt ngưỡng và **bị cắt giữa chừng**, mô hình
 *   không hề biết là nó đang đọc dữ liệu thiếu.
 * * **Số ghi chú hình vẽ** — một chỉ báo như Ziv Ghost Pivot sinh cả nghìn nhãn trên 400 phiên.
 *   Chỉ những cái gần hiện tại mới có ý nghĩa với một nhận định cho phiên tới.
 */
import type { Candle } from '@/lib/indicators/math';
import { getIndicator, instanceLabel } from '@/lib/indicators/registry';
import type { IndicatorInstance, IndicatorShapes } from '@/lib/indicators/types';
import type { Candle as ApiCandle } from '@/types';

/** Số phiên gần nhất gửi kèm cho mỗi đường. */
const MAX_POINTS = 60;
/** Số ghi chú (vùng, đường, tín hiệu) tối đa của một chỉ báo. Khớp trần của schema máy chủ. */
const MAX_NOTES = 30;
/** Trần cho từng loại hình, để một loại không chiếm hết chỗ của các loại khác. */
const MAX_PER_SHAPE = 8;

export type IndicatorSnapshot = {
  id: string;
  name: string;
  label: string;
  placement: 'overlay' | 'pane';
  params: Record<string, string | number | boolean | null>;
  plots: { key: string; label: string; points: [string, number][] }[];
  notes: string[];
};

/** Giá qua JSON có thể về dạng chuỗi — ép số trước khi tính chỉ báo. */
function num(value: number | string | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Nến từ API → nến cho thư viện chỉ báo (thời gian là giây unix).
 *
 * Một chỗ đổi duy nhất cho cả biểu đồ lẫn ảnh chụp gửi AI: hai cách đổi khác nhau nghĩa là mô
 * hình đọc một chuỗi nến, người dùng nhìn một chuỗi khác.
 */
export function toIndicatorCandles(rows: ApiCandle[]): Candle[] {
  return rows.map((c) => ({
    time: Math.floor(new Date(c.trade_date).getTime() / 1000),
    open: num(c.open),
    high: num(c.high),
    low: num(c.low),
    close: num(c.close),
    volume: num(c.volume),
  }));
}

/** unix giây → `YYYY-MM-DD`. Nến ngày được dựng từ mốc 00:00 UTC nên không lệch ngày. */
function isoDate(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10);
}

/**
 * Làm gọn số trước khi gửi.
 *
 * Giá cổ phiếu và RSI cần phần thập phân; OBV hay khối lượng thì hàng triệu, giữ bốn chữ số
 * sau dấu phẩy ở đó chỉ tốn token mà không thêm một chút thông tin nào.
 */
function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.abs(value) >= 1000 ? Math.round(value) : Number(value.toFixed(4));
}

function shapeNotes(shapes: IndicatorShapes): string[] {
  const notes: string[] = [];
  const price = (value: number) => round(value);

  for (const box of (shapes.boxes ?? []).slice(-MAX_PER_SHAPE)) {
    const top = Math.max(box.from.price, box.to.price);
    const bottom = Math.min(box.from.price, box.to.price);
    notes.push(
      `${box.label || 'Vùng'}: ${price(bottom)}–${price(top)}, từ ${isoDate(box.from.time)}`,
    );
  }
  for (const line of (shapes.lines ?? []).slice(-MAX_PER_SHAPE)) {
    notes.push(
      `${line.label || 'Đường'}: ${price(line.from.price)} → ${price(line.to.price)}, ` +
        `từ ${isoDate(line.from.time)} đến ${isoDate(line.to.time)}`,
    );
  }
  for (const marker of (shapes.markers ?? []).slice(-MAX_PER_SHAPE)) {
    notes.push(`Tín hiệu ${marker.text || marker.shape} ngày ${isoDate(marker.time)}`);
  }
  for (const label of (shapes.labels ?? []).slice(-MAX_PER_SHAPE)) {
    // Nhãn nhiều dòng (ZigZag in giá và khối lượng) gộp lại thành một dòng cho dễ đọc.
    const text = label.text.split('\n').join(' · ');
    notes.push(`${text} tại ${price(label.price)} ngày ${isoDate(label.time)}`);
  }

  // Cắt từ đầu: phần cuối là phần gần hiện tại nhất, và đó là phần đáng giữ.
  return notes.slice(-MAX_NOTES);
}

/**
 * Bộ chỉ báo đang bật, ở dạng gửi lên máy chủ.
 *
 * Chỉ lấy chỉ báo **đang hiện**: người dùng bấm con mắt để tắt một đường nghĩa là họ không muốn
 * nhìn nó nữa, nên nhận định cũng không nên dựa vào nó.
 */
export function buildIndicatorSnapshot(
  instances: IndicatorInstance[],
  candles: Candle[],
): IndicatorSnapshot[] {
  if (!candles.length) return [];

  const snapshots: IndicatorSnapshot[] = [];

  for (const instance of instances) {
    if (!instance.visible) continue;
    const def = getIndicator(instance.defId);
    if (!def) continue;

    const result = def.compute(candles, instance.params);
    const plots: IndicatorSnapshot['plots'] = [];

    for (const plot of def.plots) {
      const style = { ...plot, ...instance.styleOverrides[plot.key] };
      if (style.hidden) continue;

      const values = result[plot.key] ?? [];
      const points: [string, number][] = [];
      const from = Math.max(0, values.length - MAX_POINTS);
      for (let i = from; i < values.length; i++) {
        const value = values[i];
        if (value === null || !Number.isFinite(value)) continue;
        points.push([isoDate(candles[i].time), round(value)]);
      }
      if (points.length) plots.push({ key: plot.key, label: plot.label, points });
    }

    let notes: string[] = [];
    try {
      const shapes = def.computeShapes?.(candles, instance.params);
      if (shapes) notes = shapeNotes(shapes);
    } catch {
      // Một chỉ báo vẽ hình lỗi không được phép chặn cả lượt phân tích: phần đường của nó vẫn
      // gửi đi được, và mô hình vẫn còn nến để đọc.
    }

    snapshots.push({
      id: def.id,
      name: def.name,
      label: instanceLabel(instance),
      placement: def.placement,
      params: instance.params as IndicatorSnapshot['params'],
      plots,
      notes,
    });
  }

  return snapshots;
}
