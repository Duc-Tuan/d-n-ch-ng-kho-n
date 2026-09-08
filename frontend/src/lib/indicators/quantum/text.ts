/**
 * Toàn bộ chữ **hiển thị** của bộ Quantum, gom về một chỗ và viết bằng tiếng Việt.
 *
 * Lõi tính toán vẫn giữ các hằng tiếng Anh (`BULL`, `Strong`, `Buy`, `Ranging`…) vì chúng là
 * **giá trị của kiểu**: chúng đi vào so sánh, vào `switch`, vào điều kiện mở lệnh. Dịch thẳng ở
 * đó thì mỗi lần muốn đổi một câu chữ trên bảng là một lần phải sửa vào đúng chỗ quyết định tín
 * hiệu — loại sửa mà TypeScript vẫn cho qua và chỉ vỡ khi chạy thật.
 *
 * Nên biên giới nằm ở đây: dưới file này là logic, trên file này là chữ cho người đọc.
 */
import { strengthOf, type Direction, type Resonance, type Strength } from './engine';
import type { PositionOutcome, SignalKind } from './signals';

/** Chiều in hoa cho cột "Xu hướng" của bảng đa khung — đúng kiểu nhấn của thiết kế gốc. */
export const DIRECTION_TEXT: Record<Direction, string> = { BULL: 'TĂNG', BEAR: 'GIẢM' };

/** Chiều viết thường, dùng trong câu văn ("Xu hướng động lượng: Tăng"). */
export const TREND_TEXT: Record<Direction, string> = { BULL: 'Tăng', BEAR: 'Giảm' };

export const STRENGTH_TEXT: Record<Strength, string> = {
  Weak: 'Yếu',
  Medium: 'Vừa',
  Strong: 'Mạnh',
};

/**
 * Diễn giải cho **bảng thông tin**. Thẻ đứng cạnh nến vẫn in nguyên `Buy` / `Sell` /
 * `Bullish` / `Bearish` — chữ chen giữa các cây nến phải thật ngắn, và đó cũng là bộ từ người
 * đọc biểu đồ đã quen mặt.
 */
export const SIGNAL_TEXT: Record<SignalKind, string> = {
  Buy: 'Mua',
  Sell: 'Bán',
  Bullish: 'Thiên mua',
  Bearish: 'Thiên bán',
};

export const MARKET_TEXT: Record<'Trending' | 'Ranging', string> = {
  Trending: 'Có xu hướng',
  Ranging: 'Đi ngang',
};

export const OUTCOME_TEXT: Record<PositionOutcome, string> = {
  open: 'Đang mở',
  stopped: 'Chạm dừng lỗ',
  target1: 'Chốt tại mục tiêu 1',
  target2: 'Chốt tại mục tiêu 2',
  reversed: 'Đóng do đảo chiều',
};

/** `19.1 (Yếu)` — điểm kèm xếp hạng, đúng cách bảng trong thiết kế gốc trình bày. */
export function scoreText(score: number): string {
  return `${score.toFixed(1)} (${STRENGTH_TEXT[strengthOf(score)]})`;
}

/** Thiên hướng thị trường ở bảng cộng hưởng. */
export function resonanceText(resonance: Resonance): string {
  if (!resonance.direction) return 'Chờ tín hiệu';
  return resonance.direction === 'BULL' ? 'Cộng hưởng tăng' : 'Cộng hưởng giảm';
}

/** Mức cộng hưởng tức thời ở bảng dữ liệu lõi. */
export function resonanceStateText(resonance: Resonance): string {
  if (!resonance.direction) return 'Không cộng hưởng';
  return resonance.high ? 'Cộng hưởng mạnh' : 'Cộng hưởng nhẹ';
}

/** "12 nến trước" — `null` khi cả chuỗi chưa có tín hiệu nào. */
export function barsAgoText(bars: number | null): string {
  return bars === null ? '—' : bars === 0 ? 'Nến hiện tại' : `${bars} nến trước`;
}
