/**
 * `analyze()` — gom toàn bộ trạng thái Quantum Multi-Engine vào **một** kết quả.
 *
 * Cả hai mục trong danh mục chỉ báo (lớp vẽ đè và cửa sổ Resonance) đều đọc từ đây, nên con số
 * trên bảng dashboard và hình vẽ trong cửa sổ không bao giờ nói hai chuyện khác nhau.
 */
import { num, type ParamValues } from '@/lib/indicators/types';
import type { Candle } from '@/lib/indicators/math';

import {
  marketType,
  momentumEngine,
  mtfMatrix,
  resonanceOf,
  timeframeOf,
  trendOf,
  volumeEngine,
  type Direction,
  type MtfRow,
  type Resonance,
  type Strength,
} from './engine';
import {
  computeSeries,
  findSignals,
  trackPositions,
  type Position,
  type QuantumSignal,
  type SignalSeries,
} from './signals';

/** Vùng Premium / Equilibrium / Discount của biên độ gần nhất. */
export interface ValueZones {
  high: number;
  low: number;
  equilibrium: number;
  /** Ranh giới dải cân bằng quanh điểm giữa. */
  eqTop: number;
  eqBottom: number;
  /** Giá hiện tại nằm ở đâu trong biên độ, 0 = đáy, 1 = đỉnh. */
  position: number;
  fromTime: number;
}

export interface QuantumState {
  timeframe: { seconds: number; label: string; index: number };
  momentum: { score: number; direction: Direction; strength: Strength };
  volume: { bullPct: number; bearPct: number; direction: Direction };
  trend: Direction;
  mtf: MtfRow[];
  resonance: Resonance;
  market: 'Trending' | 'Ranging';
  zones: ValueZones | null;
  series: SignalSeries;
  signals: QuantumSignal[];
  positions: Position[];
  /** Lệnh còn đang mở, nếu có. Đây là thứ đổ ra khối *Position Tracking*. */
  openPosition: Position | null;
  latest: QuantumSignal | null;
  /** Tín hiệu gần nhất cách hiện tại bao nhiêu cây nến. */
  barsSinceSignal: number | null;
}

export const QUANTUM_PARAMS = {
  fastLength: 12,
  slowLength: 26,
  volumeLookback: 50,
  zoneLookback: 60,
  minScore: 25,
  stopAtr: 2,
  target1Atr: 2,
  target2Atr: 4,
} as const;

function readParams(params: ParamValues) {
  const read = (key: keyof typeof QUANTUM_PARAMS) => {
    const value = num(params, key);
    return Number.isFinite(value) && value > 0 ? value : QUANTUM_PARAMS[key];
  };
  return {
    fastLength: read('fastLength'),
    slowLength: read('slowLength'),
    volumeLookback: read('volumeLookback'),
    zoneLookback: read('zoneLookback'),
    minScore: read('minScore'),
    stopAtr: read('stopAtr'),
    target1Atr: read('target1Atr'),
    target2Atr: read('target2Atr'),
  };
}

/**
 * Biên độ gần nhất, chia thành vùng đắt / cân bằng / rẻ.
 *
 * Dùng đỉnh–đáy của `lookback` nến gần nhất chứ không phải của toàn chuỗi: một mã từng lên đỉnh
 * ba năm trước thì biên độ toàn chuỗi kéo dài tới mức mọi giá hiện tại đều rơi vào vùng "rẻ",
 * và cả ba vùng hết mang thông tin.
 */
export function valueZones(candles: Candle[], lookback: number): ValueZones | null {
  const window = candles.slice(-Math.max(5, lookback));
  if (window.length < 5) return null;

  let high = -Infinity;
  let low = Infinity;
  for (const candle of window) {
    high = Math.max(high, candle.high);
    low = Math.min(low, candle.low);
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;

  const equilibrium = (high + low) / 2;
  const band = (high - low) * 0.05;
  const close = window[window.length - 1].close;

  return {
    high,
    low,
    equilibrium,
    eqTop: equilibrium + band,
    eqBottom: equilibrium - band,
    position: (close - low) / (high - low),
    fromTime: window[0].time,
  };
}

export function analyze(candles: Candle[], params: ParamValues): QuantumState {
  const options = readParams(params);
  const timeframe = timeframeOf(candles);

  const momentum = momentumEngine(candles, options.fastLength, options.slowLength);
  const volume = volumeEngine(candles, options.volumeLookback);
  const resonance = resonanceOf(momentum, volume, options.minScore);

  const series = computeSeries(candles, options);
  const signals = findSignals(candles, series, options.minScore);
  const positions = trackPositions(candles, signals, series, options);

  const openPosition = positions.find((p) => p.outcome === 'open') ?? null;
  const latest = signals.length ? signals[signals.length - 1] : null;

  return {
    timeframe,
    momentum: {
      score: momentum.score,
      direction: momentum.direction,
      strength: momentum.strength,
    },
    volume,
    trend: trendOf(candles, options.fastLength, options.slowLength),
    mtf: mtfMatrix(candles, options.fastLength, options.slowLength),
    resonance,
    market: marketType(candles, options.volumeLookback),
    zones: valueZones(candles, options.zoneLookback),
    series,
    signals,
    positions,
    openPosition,
    latest,
    barsSinceSignal: latest ? candles.length - 1 - latest.index : null,
  };
}

