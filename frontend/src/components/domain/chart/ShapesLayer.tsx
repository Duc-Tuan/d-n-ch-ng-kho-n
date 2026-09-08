'use client';

/**
 * Lớp vẽ hộp / đường / nhãn do chỉ báo sinh ra (Order Block, FVG, BOS-CHoCH, ZigZag, Fibonacci).
 *
 * lightweight-charts v4 không có API vẽ hình tuỳ ý, nên ta phủ một `canvas` lên trên biểu đồ và
 * tự quy đổi (thời gian, giá) → pixel. Canvas luôn `pointer-events: none` để không cướp chuột
 * của biểu đồ bên dưới — kéo, phóng, đường ngắm vẫn hoạt động bình thường.
 */
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import { useCallback, useEffect, useRef } from 'react';

import { createMapper } from '@/lib/indicators/coords';
import type { Candle } from '@/lib/indicators/math';
import {
  isSectionRow,
  type IndicatorGauge,
  type IndicatorShapes,
  type IndicatorTable,
} from '@/lib/indicators/types';

import { isChartLive } from './chartLifecycle';
import { chartColor } from './chartTheme';

const DASH: Record<string, number[]> = {
  solid: [],
  dashed: [6, 4],
  dotted: [2, 3],
};

export function ShapesLayer({
  chart,
  series,
  candles,
  width,
  height,
  shapes,
}: {
  chart: IChartApi | null;
  series: ISeriesApi<SeriesType> | null;
  candles: Candle[];
  width: number;
  height: number;
  shapes: IndicatorShapes;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Dữ liệu đọc qua ref: hàm vẽ được đăng ký một lần vào sự kiện kéo/phóng của biểu đồ, nên nó
  // không được phép "đóng gói" mất giá trị cũ.
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    // `isChartLive` chứ không phải `chart != null`: biểu đồ có thể đã bị gỡ mà prop vẫn giữ
    // nguyên handle cũ — xem `chartLifecycle`. Gọi vào đó là ném lỗi, không phải trả về rỗng.
    if (!canvas || !isChartLive(chart) || !series) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width: w, height: h } = sizeRef.current;
    if (!w || !h) return;

    // Vẽ theo mật độ điểm ảnh thật của màn hình, nếu không chữ và nét bị nhoè trên màn Retina.
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!candlesRef.current.length) return;
    const mapper = createMapper(chart, series, candlesRef.current);
    const { boxes = [], lines = [], labels = [] } = shapesRef.current;

    // Canvas phủ trọn khung, kể cả cột giá bên phải. Hình neo ở tương lai sẽ tràn lên cột giá
    // nếu không tự xén theo bề rộng vùng vẽ — biểu đồ tự xén phần của nó, ta phải làm tương tự.
    const paneWidth = chart.paneSize().width;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, paneWidth, h);
    ctx.clip();

    for (const box of boxes) {
      const x1 = mapper.toX(box.from.time);
      const x2 = mapper.toX(box.to.time);
      const y1 = mapper.toY(box.from.price);
      const y2 = mapper.toY(box.to.price);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;

      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const boxWidth = Math.abs(x2 - x1);
      const boxHeight = Math.abs(y2 - y1);
      if (left > paneWidth || left + boxWidth < 0) continue;

      ctx.fillStyle = box.fill;
      ctx.fillRect(left, top, boxWidth, boxHeight);

      if (box.border) {
        ctx.strokeStyle = box.border;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.strokeRect(left, top, boxWidth, boxHeight);
      }
      if (box.label) {
        drawLabel(
          ctx,
          box.label,
          left + 3,
          top + 8,
          box.labelColor ?? box.border ?? chartColor('ink-500', '113 113 127'),
        );
      }
    }

    for (const line of lines) {
      const x1 = mapper.toX(line.from.time);
      const x2 = mapper.toX(line.to.time);
      const y1 = mapper.toY(line.from.price);
      const y2 = mapper.toY(line.to.price);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > paneWidth) continue;

      ctx.strokeStyle = line.color;
      ctx.lineWidth = 1;
      ctx.setLineDash(DASH[line.lineStyle ?? 'solid'] ?? []);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      if (line.label) {
        // Thẻ nền đặc cho những đường mang **con số người dùng phải đọc chính xác** (Entry, SL,
        // TP): chúng nằm đè lên nến và lên hộp đã tô màu, chữ trần ở đó gần như không đọc nổi.
        drawLabel(ctx, line.label, x2 + 4 + (line.labelOffset ?? 0), y2, line.color, {
          align: 'left',
          fontSize: 10,
          background: !line.labelBackground,
          backgroundColor: line.labelBackground,
        });
      }
    }

    for (const label of labels) {
      const x = mapper.toX(label.time);
      const y = mapper.toY(label.price);
      if (x === null || y === null) continue;
      if (x < -40 || x > paneWidth + 40 || y < -20 || y > h + 20) continue;

      // `valign` tính theo giá: nhãn đỉnh nằm phía trên, nhãn đáy nằm phía dưới. Nhãn nhiều
      // dòng phải đẩy thêm nửa chiều cao khối chữ, nếu không nó đè lên nến.
      const fontSize = label.fontSize ?? 10;
      const rows = label.text.split('\n').length;
      const gap = 10 + ((rows - 1) * (fontSize + 3)) / 2;
      const offset = label.valign === 'above' ? -gap : label.valign === 'below' ? gap : 0;
      drawLabel(ctx, label.text, x, y + offset, label.color, {
        align: label.align ?? 'left',
        fontSize,
        background: label.background ?? false,
        backgroundColor: label.backgroundColor,
      });
    }

    // Bảng số liệu vẽ **sau cùng và trong cùng vùng xén**: nó là thứ đọc được ở mọi khoảng nhìn,
    // nên phải nằm trên mọi hộp và đường, nhưng vẫn không được tràn sang cột giá.
    // Bật hai chỉ báo cùng có bảng thì chúng xếp chồng lên nhau ở cùng một góc — dồn cái sau
    // xuống dưới cái trước thay vì để hai bảng đè nhau thành một mớ chữ không đọc được.
    for (const gauge of shapesRef.current.gauges ?? []) {
      drawGauge(ctx, gauge, paneWidth, h);
    }

    const cornerOffset = new Map<string, number>();
    for (const table of shapesRef.current.tables ?? []) {
      const corner = table.corner ?? 'bottom-right';
      const offset = cornerOffset.get(corner) ?? 0;
      cornerOffset.set(corner, offset + drawTable(ctx, table, paneWidth, h, offset) + 6);
    }

    ctx.restore();
  }, [chart, series]);

  // Kéo hoặc phóng thì toạ độ đổi hết — phải vẽ lại.
  useEffect(() => {
    if (!isChartLive(chart)) return;
    const timeScale = chart.timeScale();
    const handler = () => render();
    timeScale.subscribeVisibleLogicalRangeChange(handler);
    return () => timeScale.unsubscribeVisibleLogicalRangeChange(handler);
  }, [chart, render]);

  useEffect(() => {
    render();
  }, [render, shapes, candles, width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, pointerEvents: 'none' }}
      // Thư viện gán inline `z-index: 1..3` cho các canvas nội bộ của nó, và thẻ bọc biểu đồ
      // không tạo ngữ cảnh xếp lớp nên những z-index đó "thoát" ra ngoài. Lớp này phải > 3.
      className="absolute inset-0 z-[5]"
    />
  );
}

interface LabelStyle {
  align: CanvasTextAlign;
  fontSize: number;
  background: boolean;
  /** Nền đặc (thẻ Mua/Bán): chữ được vẽ trắng cho tương phản. */
  backgroundColor?: string;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** `text` có thể chứa `\n`; khối chữ được canh giữa theo chiều dọc quanh `y`. */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  style: LabelStyle = { align: 'left', fontSize: 10, background: true },
) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = `${style.fontSize}px -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = style.align;

  const solid = Boolean(style.backgroundColor);
  const rows = text.split('\n');
  const lineHeight = style.fontSize + 3;
  const firstY = y - ((rows.length - 1) * lineHeight) / 2;

  if (solid || style.background) {
    const width = Math.max(...rows.map((row) => ctx.measureText(row).width));
    const padX = solid ? 5 : 2;
    const padY = solid ? 3 : 2;
    // Hộp nền phải bám theo `textAlign`, nếu không nhãn canh phải sẽ lệch hẳn khỏi chữ.
    const left =
      style.align === 'right'
        ? x - width - padX
        : style.align === 'center'
          ? x - width / 2 - padX
          : x - padX;

    const boxWidth = width + padX * 2;
    const boxHeight = rows.length * lineHeight - 3 + padY * 2;
    const top = y - boxHeight / 2;

    // Nền của nhãn phải đi theo nền biểu đồ, không phải một màu cố định: mảng trắng 82% từng
    // đúng khi biểu đồ còn nền sáng, đặt lên nền tối nó thành một miếng dán chói đè lên nến.
    ctx.fillStyle = solid ? style.backgroundColor! : chartColor('surface', '255 255 255', 0.82);
    if (solid) {
      roundedRect(ctx, left, top, boxWidth, boxHeight, 3);
      ctx.fill();
    } else {
      ctx.fillRect(left, top, boxWidth, boxHeight);
    }
  }

  ctx.fillStyle = solid ? chartColor('primary-fg', '255 255 255') : color;
  rows.forEach((row, i) => ctx.fillText(row, x, firstY + i * lineHeight));
  ctx.restore();
}

const TABLE_FONT = 11;
const TABLE_ROW_HEIGHT = 20;
/** Dòng tiêu đề khối thấp hơn dòng số liệu — nó là vạch ngăn, không phải một dòng dữ liệu. */
const TABLE_SECTION_HEIGHT = 17;
/** Bề rộng thanh bar mini. Đủ để phân biệt 1/5 với 5/5, không lấn chỗ của con số. */
const TABLE_BAR_WIDTH = 34;
const TABLE_BAR_HEIGHT = 5;
/** Khoảng cách giữa thanh bar và con số đứng sau nó. */
const TABLE_BAR_GAP = 6;
const TABLE_PAD = 8;
const TABLE_MARGIN = 10;

/**
 * Bảng số liệu dán ở một góc khung.
 *
 * Bề rộng đo theo nội dung thật chứ không đặt cứng: giá cổ phiếu Việt Nam in ra "68.500" nhưng
 * khối lượng thì "132.262M", hai cột đó chênh nhau rất nhiều tuỳ mã và tuỳ chỉ báo.
 */
/** Dải màu mặc định của thanh đo: lạnh → ấm, giống thang nhiệt của thiết kế gốc. */
const GAUGE_STOPS = ['#00E5FF', '#26A69A', '#CDDC39', '#FFC107', '#FF7043', '#AB47BC'];
const GAUGE_HEIGHT = 6;
const GAUGE_BOTTOM = 16;
const GAUGE_INSET = 0.28;

/**
 * Thanh đo nằm ngang ở đáy khung, kèm một mốc đánh dấu.
 *
 * Chiếm phần giữa khung chứ không kéo hết bề ngang: mép trái là chỗ giá mở đầu và mép phải là
 * chỗ nến mới nhất — hai chỗ người dùng nhìn nhiều nhất, phủ một dải màu lên đó là che mất đúng
 * phần đáng xem.
 */
function drawGauge(
  ctx: CanvasRenderingContext2D,
  gauge: IndicatorGauge,
  paneWidth: number,
  paneHeight: number,
): void {
  const left = paneWidth * GAUGE_INSET;
  const width = paneWidth * (1 - GAUGE_INSET) - TABLE_MARGIN;
  if (width < 60) return;

  const y = paneHeight - GAUGE_BOTTOM;
  const stops = gauge.stops?.length ? gauge.stops : GAUGE_STOPS;

  ctx.save();
  ctx.setLineDash([]);

  const gradient = ctx.createLinearGradient(left, 0, left + width, 0);
  stops.forEach((color, i) => gradient.addColorStop(i / Math.max(1, stops.length - 1), color));

  roundedRect(ctx, left, y, width, GAUGE_HEIGHT, GAUGE_HEIGHT / 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  const ratio = Math.min(1, Math.max(0, gauge.ratio));
  const markerX = left + width * ratio;

  // Mốc vẽ thành một tam giác nhỏ chĩa xuống: một vạch dọc mảnh trên nền nhiều màu rất dễ lẫn
  // vào chính dải màu bên dưới nó.
  ctx.beginPath();
  ctx.moveTo(markerX, y - 1);
  ctx.lineTo(markerX - 4, y - 7);
  ctx.lineTo(markerX + 4, y - 7);
  ctx.closePath();
  ctx.fillStyle = chartColor('ink-900', '24 24 32');
  ctx.fill();

  if (gauge.label) {
    drawLabel(ctx, gauge.label, markerX, y - 15, chartColor('ink-900', '24 24 32'), {
      align: 'center',
      fontSize: 9,
      background: true,
    });
  }

  ctx.restore();
}

function drawTable(
  ctx: CanvasRenderingContext2D,
  table: IndicatorTable,
  paneWidth: number,
  paneHeight: number,
  /** Đẩy ra khỏi mép bao nhiêu pixel — chỗ cho những bảng đã vẽ trước ở cùng góc. */
  stackOffset: number,
): number {
  ctx.save();
  ctx.setLineDash([]);
  ctx.textBaseline = 'middle';

  ctx.font = `600 ${TABLE_FONT}px -apple-system, system-ui, sans-serif`;
  const titleWidth = table.title ? ctx.measureText(table.title).width : 0;

  ctx.font = `${TABLE_FONT}px -apple-system, system-ui, sans-serif`;

  // Đo riêng từng loại dòng. Gộp chung thì một tiêu đề khối dài sẽ kéo cột nhãn rộng ra theo,
  // và bảng thừa ra một khoảng trắng ở giữa mà không có gì lấp.
  let labelWidth = 0;
  let valueWidth = 0;
  let sectionWidth = 0;
  let height = TABLE_PAD * 2 - 4 + (table.title ? TABLE_ROW_HEIGHT : 0);

  for (const row of table.rows) {
    if (isSectionRow(row)) {
      sectionWidth = Math.max(sectionWidth, ctx.measureText(row.section).width);
      height += TABLE_SECTION_HEIGHT;
      continue;
    }
    labelWidth = Math.max(labelWidth, ctx.measureText(row.label).width);
    const bar = row.bar ? TABLE_BAR_WIDTH + TABLE_BAR_GAP : 0;
    valueWidth = Math.max(valueWidth, ctx.measureText(row.value).width + bar);
    height += TABLE_ROW_HEIGHT;
  }

  const gap = 16;
  const width =
    Math.max(titleWidth, sectionWidth, labelWidth + gap + valueWidth) + TABLE_PAD * 2;

  const corner = table.corner ?? 'bottom-right';
  const x = corner.endsWith('right') ? paneWidth - width - TABLE_MARGIN : TABLE_MARGIN;
  const y = corner.startsWith('bottom')
    ? paneHeight - height - TABLE_MARGIN - stackOffset
    : TABLE_MARGIN + stackOffset;

  roundedRect(ctx, x, y, width, height, 5);
  ctx.fillStyle = chartColor('surface', '255 255 255', 0.94);
  ctx.fill();
  ctx.strokeStyle = chartColor('line', '217 217 222');
  ctx.lineWidth = 1;
  ctx.stroke();

  let cursor = y + TABLE_PAD + TABLE_ROW_HEIGHT / 2 - 2;

  if (table.title) {
    ctx.font = `600 ${TABLE_FONT}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = chartColor('ink-900', '24 24 32');
    ctx.fillText(table.title, x + TABLE_PAD, cursor);
    cursor += TABLE_ROW_HEIGHT;
  }

  ctx.font = `${TABLE_FONT}px -apple-system, system-ui, sans-serif`;
  for (const row of table.rows) {
    if (isSectionRow(row)) {
      // Tiêu đề khối: chữ nhỏ, in hoa, kèm một vạch mảnh kéo hết bề ngang còn lại. Vạch mới là
      // thứ mắt bám vào để tách nhóm — chỉ đổi kiểu chữ thôi thì mười lăm dòng vẫn dính liền.
      const top = cursor - TABLE_SECTION_HEIGHT / 2 + 2;
      ctx.textAlign = 'left';
      ctx.fillStyle = chartColor('ink-500', '113 113 127');
      ctx.font = `600 ${TABLE_FONT - 1}px -apple-system, system-ui, sans-serif`;
      const text = row.section.toUpperCase();
      ctx.fillText(text, x + TABLE_PAD, top + TABLE_SECTION_HEIGHT / 2);

      const lineFrom = x + TABLE_PAD + ctx.measureText(text).width + 6;
      const lineTo = x + width - TABLE_PAD;
      if (lineTo > lineFrom) {
        ctx.beginPath();
        ctx.moveTo(lineFrom, top + TABLE_SECTION_HEIGHT / 2);
        ctx.lineTo(lineTo, top + TABLE_SECTION_HEIGHT / 2);
        ctx.strokeStyle = chartColor('line', '217 217 222');
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.font = `${TABLE_FONT}px -apple-system, system-ui, sans-serif`;
      cursor += TABLE_SECTION_HEIGHT;
      continue;
    }

    // Dòng tiêu đề cột đặt tên cho hai cột bên dưới, nên nó phải nhạt hơn dữ liệu — cùng độ
    // đậm thì mắt đọc nó thành một dòng số liệu nữa và bảng mất hẳn cấu trúc cột.
    const muted = chartColor('ink-500', '113 113 127');
    if (row.header) {
      ctx.font = `600 ${TABLE_FONT - 1}px -apple-system, system-ui, sans-serif`;
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = muted;
    ctx.fillText(row.label, x + TABLE_PAD, cursor);

    ctx.textAlign = 'right';
    ctx.fillStyle = row.header ? muted : (row.color ?? chartColor('ink-900', '24 24 32'));
    ctx.fillText(row.value, x + width - TABLE_PAD, cursor);

    if (row.header) {
      ctx.font = `${TABLE_FONT}px -apple-system, system-ui, sans-serif`;
      cursor += TABLE_ROW_HEIGHT;
      continue;
    }

    if (row.bar) {
      const barRight = x + width - TABLE_PAD - ctx.measureText(row.value).width - TABLE_BAR_GAP;
      const barLeft = barRight - TABLE_BAR_WIDTH;
      const top = cursor - TABLE_BAR_HEIGHT / 2;

      // Rãnh nền luôn vẽ đủ bề rộng: không có nó thì một thanh ngắn và một thanh dài trông như
      // hai thang đo khác nhau, và tỉ lệ — thứ duy nhất đáng đọc ở đây — biến mất.
      roundedRect(ctx, barLeft, top, TABLE_BAR_WIDTH, TABLE_BAR_HEIGHT, TABLE_BAR_HEIGHT / 2);
      ctx.fillStyle = chartColor('ink-200', '228 228 233', 0.9);
      ctx.fill();

      const filled = TABLE_BAR_WIDTH * Math.min(1, Math.max(0, row.bar.ratio));
      if (filled > 0.5) {
        roundedRect(ctx, barLeft, top, filled, TABLE_BAR_HEIGHT, TABLE_BAR_HEIGHT / 2);
        ctx.fillStyle = row.bar.color;
        ctx.fill();
      }
    }

    cursor += TABLE_ROW_HEIGHT;
  }

  ctx.restore();
  return height;
}
