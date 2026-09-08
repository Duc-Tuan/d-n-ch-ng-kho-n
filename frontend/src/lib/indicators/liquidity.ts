/**
 * Vùng thanh khoản và kháng cự / hỗ trợ tự động.
 *
 * * `adaptive_sr` dựng các mức từ đỉnh–đáy cục bộ, gộp những mức sát nhau lại rồi giữ vài mức
 *   khoẻ nhất — thay vì kẻ tay một đường rồi quên cập nhật khi giá đã đi xa.
 * * `liquidity_heatmap` tô cả khung theo khối lượng đã dồn vào từng dải giá, để thấy ngay giá
 *   đang tiến vào vùng đông người hay vùng loãng.
 *
 * Cả hai đều **vẽ lại phần đuôi** khi có nến mới, vì đỉnh–đáy chỉ xác nhận được sau `pivotLen`
 * nến và khối lượng của phiên đang chạy còn thay đổi. Đó là hành vi đúng, không phải lỗi.
 */
import { atr, findPivots, medianInterval } from '@/lib/indicators/math';
import { compactVolume, volumeByPrice } from '@/lib/indicators/profiles';
import {
  bool,
  num,
  type IndicatorBox,
  type IndicatorDef,
  type IndicatorLabel,
  type IndicatorLine,
  type IndicatorMarker,
  type IndicatorTable,
} from '@/lib/indicators/types';

const C = {
  resistance: '#FF7043',
  support: '#26C6DA',
  pivot: '#2962FF',
  breakLine: 'rgba(120,123,134,0.85)',
  bull: '#089981',
  bear: '#F23645',
  ink: '#787B86',
};

const price = (value: number) => value.toLocaleString('vi-VN', { maximumFractionDigits: 2 });

/* ═══ Adaptive S/R [BigBeluga] ══════════════════════════════════════════ */

interface Level {
  price: number;
  /** Nến sinh ra mức này — đường chỉ kẻ từ đó trở đi, không kẻ ngược về quá khứ. */
  index: number;
  /** Số lần giá quay lại chạm mức. Mức nhiều lần chạm là mức đáng tin hơn. */
  touches: number;
  type: 'high' | 'low';
  /** Nến đầu tiên đóng cửa xuyên qua mức, nếu có. */
  brokenAt: number | null;
}

const adaptiveSr: IndicatorDef = {
  id: 'adaptive_sr',
  name: 'Adaptive S/R [BigBeluga]',
  short: 'Adaptive S/R',
  category: 'trend',
  placement: 'overlay',
  labelParams: ['pivotLen', 'maxLevels'],
  params: [
    { key: 'pivotLen', label: 'Độ sâu đỉnh/đáy (nến mỗi bên)', type: 'number', default: 5, min: 2, max: 50 },
    { key: 'lookback', label: 'Số phiên xét', type: 'number', default: 300, min: 30, max: 2000 },
    { key: 'maxLevels', label: 'Số mức giữ lại', type: 'number', default: 7, min: 1, max: 20 },
    { key: 'mergeAtr', label: 'Gộp mức cách nhau dưới (× ATR)', type: 'number', default: 0.5, min: 0.05, max: 5, step: 0.05 },
    { key: 'showBreaks', label: 'Đánh dấu điểm phá vỡ', type: 'boolean', default: true },
    { key: 'showPivots', label: 'Chấm tại đỉnh/đáy', type: 'boolean', default: true },
    { key: 'showTable', label: 'Hiện bảng tổng kết', type: 'boolean', default: true },
  ],
  plots: [],
  compute: () => ({}),
  computeShapes: (candles, p) => {
    const lines: IndicatorLine[] = [];
    const labels: IndicatorLabel[] = [];
    const markers: IndicatorMarker[] = [];
    const tables: IndicatorTable[] = [];
    if (candles.length < 20) return {};

    const pivotLen = num(p, 'pivotLen');
    const from = Math.max(0, candles.length - num(p, 'lookback'));
    const range = atr(candles, 14);
    const interval = medianInterval(candles);
    const last = candles[candles.length - 1];

    const pivots = findPivots(candles, pivotLen, pivotLen).filter((pivot) => pivot.index >= from);

    /* Gộp các mức sát nhau. Không gộp thì mỗi lần giá quét đi quét lại một vùng sẽ đẻ ra năm bảy
       đường gần trùng nhau, che kín vùng đó và không nói thêm được gì. */
    const levels: Level[] = [];
    for (const pivot of pivots) {
      const tolerance = (range[pivot.index] ?? 0) * num(p, 'mergeAtr');
      const near = levels.find(
        (level) => level.type === pivot.type && Math.abs(level.price - pivot.price) <= tolerance,
      );

      if (near) {
        // Trung bình động theo số lần chạm: mức "trôi" dần về vùng giá thật sự hay bị chặn.
        near.price = (near.price * near.touches + pivot.price) / (near.touches + 1);
        near.touches += 1;
      } else {
        levels.push({
          price: pivot.price,
          index: pivot.index,
          touches: 1,
          type: pivot.type,
          brokenAt: null,
        });
      }

      if (bool(p, 'showPivots')) {
        markers.push({
          time: candles[pivot.index].time,
          position: pivot.type === 'high' ? 'aboveBar' : 'belowBar',
          shape: 'circle',
          color: C.pivot,
        });
      }
    }

    // Mức khoẻ nhất trước: nhiều lần chạm, rồi mới đến mức mới hơn.
    levels.sort((a, b) => b.touches - a.touches || b.index - a.index);
    const kept = levels.slice(0, num(p, 'maxLevels'));

    /* Phá vỡ: nến đầu tiên **đóng cửa** vượt hẳn qua mức, tính từ sau khi mức được xác nhận.
       Dùng giá đóng cửa chứ không dùng bóng nến — bóng đâm qua rồi rút về là quét thanh khoản,
       không phải phá vỡ. */
    let lastBreak: { index: number; bullish: boolean } | null = null;
    for (const level of kept) {
      for (let i = level.index + pivotLen + 1; i < candles.length; i++) {
        const broken =
          level.type === 'high' ? candles[i].close > level.price : candles[i].close < level.price;
        if (!broken) continue;
        level.brokenAt = i;
        if (!lastBreak || i > lastBreak.index) {
          lastBreak = { index: i, bullish: level.type === 'high' };
        }
        break;
      }
    }

    const showBreaks = bool(p, 'showBreaks');
    for (const level of kept) {
      const above = level.price > last.close;
      const color = above ? C.resistance : C.support;
      const start = candles[level.index].time;

      if (level.brokenAt === null) {
        // Mức còn nguyên: kẻ tới mép phải, kèm nhãn giá — đây là mức đang có tác dụng.
        lines.push({
          from: { time: start, price: level.price },
          to: { time: last.time + interval * 10, price: level.price },
          color,
        });
        labels.push({
          time: last.time + interval * 10,
          price: level.price,
          text: price(level.price),
          color,
          align: 'right',
          valign: 'above',
          background: true,
        });
        continue;
      }

      if (!showBreaks) continue;

      // Mức đã mất: kẻ nét đứt tới đúng nến phá vỡ rồi dừng, để thấy nó từng chặn ở đâu.
      lines.push({
        from: { time: start, price: level.price },
        to: { time: candles[level.brokenAt].time, price: level.price },
        color: C.breakLine,
        lineStyle: 'dotted',
      });
      labels.push({
        time: candles[level.brokenAt].time,
        price: level.price,
        text: '< Phá vỡ',
        color: C.ink,
        align: 'left',
        valign: 'middle',
        fontSize: 9,
      });
    }

    if (bool(p, 'showTable')) {
      const active = kept.filter((level) => level.brokenAt === null);
      const above = active
        .filter((level) => level.price > last.close)
        .sort((a, b) => a.price - b.price)[0];
      const below = active
        .filter((level) => level.price <= last.close)
        .sort((a, b) => b.price - a.price)[0];

      tables.push({
        title: 'Bảng kháng cự / hỗ trợ',
        corner: 'bottom-right',
        rows: [
          { label: 'Kháng cự gần nhất', value: above ? price(above.price) : '—', color: C.resistance },
          { label: 'Hỗ trợ gần nhất', value: below ? price(below.price) : '—', color: C.support },
          {
            label: 'Phá vỡ gần nhất',
            value: lastBreak ? (lastBreak.bullish ? 'Tăng' : 'Giảm') : '—',
            color: lastBreak ? (lastBreak.bullish ? C.bull : C.bear) : undefined,
          },
          { label: 'Số mức còn hiệu lực', value: String(active.length) },
        ],
      });
    }

    return { lines, labels, markers, tables };
  },
};

/* ═══ Heatmap Liquidity Zones [BigBeluga] ═══════════════════════════════ */

/**
 * Pha màu vùng thanh khoản theo mật độ.
 *
 * Đi từ tím nhạt (loãng) sang vàng (đặc) — thang màu quen thuộc của bản đồ nhiệt, và quan trọng
 * hơn là **không trùng** với xanh/đỏ của nến, nên vùng nền không bị đọc nhầm thành tín hiệu
 * tăng giảm.
 */
function heatColor(share: number, opacity: number): string {
  const t = Math.min(1, Math.max(0, share));
  const r = Math.round(150 + (250 - 150) * t);
  const g = Math.round(140 + (215 - 140) * t);
  const b = Math.round(220 + (70 - 220) * t);
  return `rgba(${r},${g},${b},${(opacity * (0.25 + 0.75 * t)).toFixed(3)})`;
}

const liquidityHeatmap: IndicatorDef = {
  id: 'liquidity_heatmap',
  name: 'Heatmap Liquidity Zones [BigBeluga]',
  short: 'Liquidity Heatmap',
  category: 'volume',
  placement: 'overlay',
  labelParams: ['levels', 'lookback'],
  params: [
    { key: 'lookback', label: 'Số phiên xét', type: 'number', default: 300, min: 30, max: 2000 },
    { key: 'levels', label: 'Số dải giá', type: 'number', default: 40, min: 10, max: 150 },
    { key: 'threshold', label: 'Ngưỡng hiện dải (tỉ lệ so với dải đặc nhất)', type: 'number', default: 0.25, min: 0, max: 1, step: 0.05 },
    // Mặc định nhạt: lớp vẽ của chỉ báo nằm **trên** nến, tô đậm là nến chìm hẳn sau bản đồ
    // nhiệt — mất đúng thứ mà bản đồ nhiệt sinh ra để đối chiếu.
    { key: 'opacity', label: 'Độ đậm tối đa', type: 'number', default: 0.35, min: 0.05, max: 1, step: 0.05 },
    { key: 'extend', label: 'Kéo dài sang phải (số phiên)', type: 'number', default: 25, min: 0, max: 200 },
    { key: 'topLevels', label: 'Ghi giá cho mấy dải đặc nhất', type: 'number', default: 5, min: 0, max: 20 },
  ],
  plots: [],
  compute: () => ({}),
  computeShapes: (candles, p) => {
    const boxes: IndicatorBox[] = [];
    const labels: IndicatorLabel[] = [];
    if (candles.length < 10) return {};

    const end = candles.length;
    const start = Math.max(0, end - num(p, 'lookback'));
    const profile = volumeByPrice(candles, start, end, num(p, 'levels'));
    if (!profile.maxVolume) return {};

    const interval = medianInterval(candles);
    const left = candles[start].time;
    const right = candles[end - 1].time + interval * num(p, 'extend');
    const threshold = num(p, 'threshold');
    const opacity = num(p, 'opacity');

    for (const bucket of profile.buckets) {
      const share = bucket.volume / profile.maxVolume;
      if (share < threshold) continue;

      boxes.push({
        from: { time: left, price: bucket.low },
        to: { time: right, price: bucket.high },
        fill: heatColor(share, opacity),
      });
    }

    // Ghi giá cho vài dải đặc nhất: cả bản đồ nhiệt chỉ có vài mức đáng đặt lệnh quanh đó, còn
    // ghi hết bốn mươi dải thì cột số che mất phần nến.
    const top = [...profile.buckets]
      .sort((a, b) => b.volume - a.volume)
      .slice(0, num(p, 'topLevels'));

    for (const bucket of top) {
      labels.push({
        time: right,
        price: bucket.mid,
        text: `${price(bucket.mid)} · ${compactVolume(bucket.volume)}`,
        color: '#B8860B',
        align: 'right',
        valign: 'middle',
        fontSize: 9,
        background: true,
      });
    }

    return { boxes, labels };
  },
};

export const LIQUIDITY_INDICATORS: IndicatorDef[] = [adaptiveSr, liquidityHeatmap];
