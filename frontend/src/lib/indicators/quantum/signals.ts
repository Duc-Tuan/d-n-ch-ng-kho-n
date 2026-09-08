/**
 * Bộ máy tín hiệu và theo dõi vị thế của Quantum Multi-Engine.
 *
 * > ⚠️ **Đây là công thức, không phải khuyến nghị đã qua kiểm duyệt.** Tín hiệu chính thức của
 * > hệ thống đi qua chiến lược → backtest → audit log và là dữ liệu bất biến (BR-83x). Những
 * > nhãn Buy/Sell vẽ ở đây chỉ là kết quả tính tại chỗ trên máy người dùng, đổi theo khung thời
 * > gian đang xem và theo tham số họ tự chỉnh. Phần mô tả chỉ báo và `Disclaimer` dưới biểu đồ
 * > phải nói rõ điều đó.
 *
 * Toàn bộ tính **một lượt trên cả chuỗi** (`O(n)`), không tính lại từ đầu ở mỗi cây nến. Cách
 * ngây thơ — cắt mảng rồi gọi lại engine cho từng nến — là `O(n²)`, và với 2.000 nến thì mỗi
 * lần kéo biểu đồ đứng hình vài giây.
 */
import { atr, ema, type Candle, type Series } from '@/lib/indicators/math';

import type { Direction } from './engine';

export type SignalKind = 'Buy' | 'Sell' | 'Bullish' | 'Bearish';

export interface QuantumSignal {
  index: number;
  time: number;
  kind: SignalKind;
  direction: Direction;
  /** Điểm tổng hợp của hai máy tại nến phát tín hiệu, 0–100. */
  score: number;
  price: number;
}

export interface PositionPlan {
  direction: Direction;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
}

export type PositionOutcome = 'open' | 'stopped' | 'target1' | 'target2' | 'reversed';

export interface Position extends PositionPlan {
  openedAt: number;
  openedIndex: number;
  closedIndex: number | null;
  outcome: PositionOutcome;
  /** Mức dừng lỗ đang có hiệu lực — dời về giá vào lệnh sau khi chạm mục tiêu 1. */
  currentStop: number;
  hitTarget1: boolean;
}

export interface SignalSeries {
  /** Điểm động lượng từng nến, 0–100. */
  score: Series;
  /** Chiều cộng hưởng từng nến; `null` là hai máy lệch chiều. */
  resonance: (Direction | null)[];
  /** Chênh lệch phân bổ khối lượng, âm khi bên bán dẫn — vẽ thành cột đỏ dưới đáy. */
  imbalance: Series;
  fast: Series;
  slow: Series;
  atr: Series;
}

/**
 * Độ nghiêng khối lượng theo cửa sổ trượt, tính một lượt bằng tổng tích luỹ.
 *
 * Cộng dồn rồi trừ hai đầu thay vì cộng lại cả cửa sổ ở mỗi nến: với cửa sổ 50 và 2.000 nến thì
 * cách kia là 100.000 phép cộng mỗi lần vẽ lại, và biểu đồ vẽ lại ở mỗi cú kéo chuột.
 */
export function rollingVolumeBalance(candles: Candle[], lookback: number): Series {
  const window = Math.max(2, lookback);
  const bull: number[] = [0];
  const bear: number[] = [0];

  for (const candle of candles) {
    const volume = Math.max(0, candle.volume);
    const up = candle.close > candle.open ? volume : candle.close < candle.open ? 0 : volume / 2;
    bull.push(bull[bull.length - 1] + up);
    bear.push(bear[bear.length - 1] + (volume - up));
  }

  const out: Series = [];
  for (let i = 0; i < candles.length; i++) {
    const from = Math.max(0, i + 1 - window);
    const b = bull[i + 1] - bull[from];
    const s = bear[i + 1] - bear[from];
    const total = b + s;
    // Thang −100…+100: dương là bên mua dẫn. Giữ dấu để vẽ được cột hai chiều.
    out.push(total ? Math.round(((b - s) / total) * 1000) / 10 : null);
  }
  return out;
}

/** Chuỗi trạng thái của hai máy ở **từng** cây nến. */
export function computeSeries(
  candles: Candle[],
  options: { fastLength: number; slowLength: number; volumeLookback: number },
): SignalSeries {
  const close = candles.map((c) => c.close);
  const fast = ema(close, options.fastLength);
  const slow = ema(close, options.slowLength);
  const range = atr(candles, Math.max(2, options.slowLength));
  const imbalance = rollingVolumeBalance(candles, options.volumeLookback);

  const score: Series = [];
  const resonance: (Direction | null)[] = [];

  for (let i = 0; i < candles.length; i++) {
    const f = fast[i];
    const s = slow[i];
    const r = range[i];
    const balance = imbalance[i];

    if (f === null || s === null || !r || balance === null) {
      score.push(null);
      resonance.push(null);
      continue;
    }

    const spread = (f - s) / r;
    score.push(Math.round(Math.abs(Math.tanh(spread)) * 1000) / 10);

    const momentumDir: Direction = spread >= 0 ? 'BULL' : 'BEAR';
    const volumeDir: Direction = balance >= 0 ? 'BULL' : 'BEAR';
    resonance.push(momentumDir === volumeDir ? momentumDir : null);
  }

  return { score, resonance, imbalance, fast, slow, atr: range };
}

/**
 * Tìm các nến phát tín hiệu.
 *
 * Mỗi lượt cộng hưởng sinh **tối đa hai** tín hiệu, và đó là điểm mấu chốt:
 *
 * * `Bullish`/`Bearish` ngay tại cây nến hai máy bắt đầu cùng chiều — mới chỉ là chú ý.
 * * `Buy`/`Sell` tại cây nến **đầu tiên** trong lượt đó mà điểm chạm ngưỡng — đây mới là điểm
 *   vào lệnh, và chính nó mở vị thế ở `trackPositions`.
 *
 * Bản trước chấm điểm ngay tại cây nến đổi chiều rồi mới quyết định mạnh hay yếu. Cách đó gần
 * như không bao giờ ra được `Buy`/`Sell`: đúng lúc cộng hưởng vừa đổi chiều thì hai đường trung
 * bình đang cắt nhau, chênh lệch của chúng bằng ~0, nên điểm cũng bằng ~0 và luôn thua ngưỡng.
 * Hậu quả là biểu đồ chỉ toàn thẻ "Thiên mua/Thiên bán", không lệnh nào mở, và cả khối kế hoạch
 * vào lệnh lẫn khối theo dõi vị thế của thiết kế không bao giờ hiện ra.
 *
 * Chỉ phát **một** `Buy` cho mỗi lượt: bỏ chốt `armed` đi thì một xu hướng kéo dài ba mươi phiên
 * đẻ ra ba mươi thẻ chồng lên nhau, che kín nến mà không nói thêm gì so với thẻ đầu tiên.
 */
export function findSignals(
  candles: Candle[],
  series: SignalSeries,
  minScore: number,
): QuantumSignal[] {
  const out: QuantumSignal[] = [];
  let previous: Direction | null = null;
  /** Lượt cộng hưởng hiện tại đã phát tín hiệu vào lệnh chưa. */
  let armed = false;

  for (let i = 0; i < candles.length; i++) {
    const direction = series.resonance[i];
    const score = series.score[i] ?? 0;

    if (!direction) {
      previous = null;
      armed = false;
      continue;
    }

    const strong = score >= minScore;
    const fresh = direction !== previous;

    if (fresh || (!armed && strong)) {
      const bull = direction === 'BULL';
      out.push({
        index: i,
        time: candles[i].time,
        direction,
        kind: strong ? (bull ? 'Buy' : 'Sell') : bull ? 'Bullish' : 'Bearish',
        score,
        price: candles[i].close,
      });
      if (strong) armed = true;
    }

    previous = direction;
  }

  return out;
}

/**
 * Diễn lại từng lệnh để biết nó đã chạm dừng lỗ, chạm mục tiêu, hay còn mở.
 *
 * Chỉ mở lệnh ở tín hiệu **mạnh** (`Buy`/`Sell`). Trong một cây nến mà cả dừng lỗ lẫn mục tiêu
 * cùng nằm trong biên độ thì tính là **chạm dừng lỗ trước** — dữ liệu nến ngày không cho biết
 * bên nào chạm trước, và đoán về phía có lợi cho mình là cách làm bảng kết quả đẹp lên một cách
 * giả tạo.
 */
export function trackPositions(
  candles: Candle[],
  signals: QuantumSignal[],
  series: SignalSeries,
  options: { stopAtr: number; target1Atr: number; target2Atr: number },
): Position[] {
  const positions: Position[] = [];

  for (let s = 0; s < signals.length; s++) {
    const signal = signals[s];
    if (signal.kind !== 'Buy' && signal.kind !== 'Sell') continue;

    const range = series.atr[signal.index];
    if (!range) continue;

    const long = signal.direction === 'BULL';
    const sign = long ? 1 : -1;
    const entry = signal.price;

    const position: Position = {
      direction: signal.direction,
      entry,
      stop: entry - sign * range * options.stopAtr,
      target1: entry + sign * range * options.target1Atr,
      target2: entry + sign * range * options.target2Atr,
      openedAt: signal.time,
      openedIndex: signal.index,
      closedIndex: null,
      outcome: 'open',
      currentStop: entry - sign * range * options.stopAtr,
      hitTarget1: false,
    };

    // Lệnh đóng khi có tín hiệu mạnh ngược chiều, kể cả chưa chạm mức nào.
    const reversal = signals.find(
      (other) =>
        other.index > signal.index &&
        other.direction !== signal.direction &&
        (other.kind === 'Buy' || other.kind === 'Sell'),
    );
    const limit = reversal ? reversal.index : candles.length - 1;

    for (let i = signal.index + 1; i <= limit; i++) {
      const candle = candles[i];
      const hitStop = long ? candle.low <= position.currentStop : candle.high >= position.currentStop;
      if (hitStop) {
        position.outcome = position.hitTarget1 ? 'target1' : 'stopped';
        position.closedIndex = i;
        break;
      }

      const hitTarget2 = long ? candle.high >= position.target2 : candle.low <= position.target2;
      if (hitTarget2) {
        position.outcome = 'target2';
        position.closedIndex = i;
        break;
      }

      const hitTarget1 = long ? candle.high >= position.target1 : candle.low <= position.target1;
      if (hitTarget1 && !position.hitTarget1) {
        position.hitTarget1 = true;
        // Dời dừng lỗ về giá vào lệnh: từ đây trở đi lệnh không còn khả năng lỗ.
        position.currentStop = entry;
      }
    }

    if (position.outcome === 'open' && reversal) {
      position.outcome = 'reversed';
      position.closedIndex = reversal.index;
    }

    positions.push(position);
  }

  return positions;
}
