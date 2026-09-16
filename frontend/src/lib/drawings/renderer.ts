/**
 * Vẽ từng loại hình lên canvas phủ trên biểu đồ.
 *
 * `lightweight-charts` v4 không có API vẽ hình tuỳ ý, nên toàn bộ công cụ vẽ đều tự dựng bằng
 * Canvas 2D. Mỗi hàm dưới đây nhận điểm neo đã quy đổi sang pixel và chỉ lo phần nét vẽ — phần
 * quy đổi nằm ở `coords.ts`, phần bắt chuột nằm ở `hitTest.ts`.
 *
 * Màu chữ và nền nhãn **không viết cứng**: site khách hàng chạy nền tối, site quản trị nền sáng.
 * Chúng đi vào qua `palette` để cùng một hình đọc được ở cả hai nơi.
 */
import { dayjs } from '@/lib/datetime';

import type { DrawingMapper } from './coords';
import {
  FIB_EXT_LEVELS,
  FIB_LEVELS,
  FONT_STACKS,
  TOOL_META,
  type Drawing,
  type DrawingFont,
  type DrawingStyle,
  type Point,
} from './types';

export interface Pixel {
  x: number;
  y: number;
}

export interface RenderPalette {
  /** Nền hộp nhãn giá. */
  labelBg: string;
  /** Chữ trung tính — nhãn vị thế và ghi chú phụ. */
  labelFg: string;
  muted: string;
  up: string;
  down: string;
}

/**
 * Hai khung đo mà lớp vẽ phải phân biệt.
 *
 * Canvas phủ **trọn** khung biểu đồ, kể cả cột giá bên phải và trục thời gian bên dưới — nó phải
 * vậy thì ghi chú dán mới đặt được ở mọi chỗ người dùng nhìn thấy. Nhưng hình neo theo (nến, giá)
 * thì chỉ được sống trong vùng nến: cuộn về quá khứ là hình trôi sang phải, và nếu đo theo cả
 * khung thì nó bò lên nằm đè cột giá.
 */
export interface Frame {
  /** Cả khung. Đây là thang quy đổi của ghi chú dán (`pin`). */
  width: number;
  height: number;
  /** Vùng nến — đã trừ cột giá và trục thời gian. Mốc để mọi hình theo nến dừng lại. */
  pane: { width: number; height: number };
}

export interface RenderContext extends Frame {
  ctx: CanvasRenderingContext2D;
  mapper: DrawingMapper;
  /** Số chữ số thập phân khi in nhãn giá — mã giá 12,35 và mã giá 120.000 cần khác nhau. */
  digits: number;
  /** Khung trong ngày → nhãn mốc thời gian phải có giờ phút, khung ngày trở lên thì không. */
  intraday: boolean;
  selected: boolean;
  palette: RenderPalette;
}

const HANDLE_RADIUS = 4;

/** Đệm trong hộp chữ, và khoảng cách dòng tính theo cỡ chữ. */
const TEXT_PADDING = 6;
const LINE_HEIGHT = 1.35;

export const textFont = (fontSize: number, font: DrawingFont = 'system') =>
  `${fontSize}px ${FONT_STACKS[font] ?? FONT_STACKS.system}`;

/**
 * Ngữ cảnh canvas rời chỉ để **đo chữ**.
 *
 * Phép bắt chuột cần biết hộp ghi chú rộng bao nhiêu, mà nó không có canvas nào trong tay. Đo bằng
 * một ngữ cảnh riêng cho ra đúng con số mà lớp vẽ dùng, thay vì ước lượng theo số ký tự — chữ Việt
 * có dấu và chữ hoa rộng hẹp rất khác nhau, ước lượng là hộp bắt lệch hẳn khỏi chữ.
 */
let measureCtx: CanvasRenderingContext2D | null = null;
function measurer(): CanvasRenderingContext2D | null {
  if (measureCtx || typeof document === 'undefined') return measureCtx;
  measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}

/** Kích thước hộp chữ (đã tính đệm) cho một đoạn văn bản nhiều dòng. */
export function textBoxSize(
  text: string,
  fontSize: number,
  font: DrawingFont = 'system',
): { width: number; height: number } {
  const lines = text.split('\n');
  const ctx = measurer();
  let widest = 0;

  if (ctx) {
    ctx.font = textFont(fontSize, font);
    for (const line of lines) widest = Math.max(widest, ctx.measureText(line).width);
  } else {
    // Không có DOM (dựng phía máy chủ): ước lượng thô, chỉ để không vỡ.
    widest = Math.max(...lines.map((line) => line.length)) * fontSize * 0.55;
  }

  return {
    width: widest + TEXT_PADDING * 2,
    height: lines.length * fontSize * LINE_HEIGHT + TEXT_PADDING * 2,
  };
}

/**
 * Toạ độ pixel của một hình.
 *
 * Ghi chú dán trên khung (`pin`) quy từ **tỉ lệ khung**, không đi qua trục thời gian — đó chính là
 * lý do nó đứng yên khi người dùng kéo biểu đồ sang trái hay phải.
 */
function pixelsOf(
  drawing: Drawing,
  mapper: DrawingMapper,
  size: { width: number; height: number },
): Pixel[] | null {
  if (drawing.pin) return [{ x: drawing.pin.x * size.width, y: drawing.pin.y * size.height }];

  const pixels = toPixels(drawing.points, mapper);
  return pixels.some((p) => p === null) ? null : (pixels as Pixel[]);
}

/** Nhãn giá trên hình vẽ. Dùng `vi-VN` cho khớp với phần còn lại của giao diện. */
export function formatPrice(value: number, digits: number): string {
  return new Intl.NumberFormat('vi-VN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * Nhãn cho một mốc thời gian của hình vẽ.
 *
 * Đọc bằng **UTC** chứ không phải giờ máy. `toIndicatorCandles` đã cộng sẵn lệch múi giờ vào
 * `time` để thư viện — vốn luôn in nhãn theo UTC — hiện ra giờ Việt Nam; đọc lại bằng giờ địa
 * phương ở đây là cộng lệch lần thứ hai, và nhãn của ta lệch 7 tiếng so với trục ngay bên cạnh.
 */
export function formatBarTime(time: number, intraday: boolean): string {
  return dayjs.utc(time * 1000).format(intraday ? 'DD/MM HH:mm' : 'DD/MM/YYYY');
}

export function toPixels(points: Point[], mapper: DrawingMapper): (Pixel | null)[] {
  return points.map((p) => {
    const x = mapper.toX(p.time);
    const y = mapper.toY(p.price);
    return x === null || y === null ? null : { x, y };
  });
}

function applyStyle(ctx: CanvasRenderingContext2D, style: DrawingStyle) {
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.lineWidth;
  ctx.setLineDash(
    style.lineStyle === 'dashed' ? [6, 4] : style.lineStyle === 'dotted' ? [2, 3] : [],
  );
}

/** Pha độ mờ vào màu hex. Màu đã ở dạng `rgba(...)` thì giữ nguyên. */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('rgba')) return color;
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

/** Kéo dài đoạn AB cho tới khi ra khỏi canvas — dùng cho tia và đường kéo dài. */
function extendLine(a: Pixel, b: Pixel, width: number, height: number, bothWays: boolean) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return { start: a, end: b };

  // Nhân đủ lớn để chắc chắn vượt canvas theo mọi hướng.
  const scale = (Math.abs(width) + Math.abs(height)) * 2;
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;

  return {
    start: bothWays ? { x: a.x - ux * scale, y: a.y - uy * scale } : a,
    end: { x: b.x + ux * scale, y: b.y + uy * scale },
  };
}

function line(ctx: CanvasRenderingContext2D, a: Pixel, b: Pixel) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function label(
  rc: RenderContext,
  text: string,
  x: number,
  y: number,
  color: string,
  fontSize = 11,
  align: CanvasTextAlign = 'left',
) {
  const { ctx } = rc;
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = `${fontSize}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';

  const metrics = ctx.measureText(text);
  const padding = 4;
  const boxX =
    align === 'right'
      ? x - metrics.width - padding * 2
      : align === 'center'
        ? x - metrics.width / 2 - padding
        : x - padding;

  // Nền mờ phía sau chữ: nhãn thường nằm chồng lên nến, không có nền thì không đọc nổi.
  ctx.fillStyle = rc.palette.labelBg;
  ctx.fillRect(
    boxX,
    y - fontSize / 2 - padding,
    metrics.width + padding * 2,
    fontSize + padding * 2,
  );

  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawHandles(ctx: CanvasRenderingContext2D, pixels: Pixel[], color: string) {
  ctx.save();
  ctx.setLineDash([]);
  pixels.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
  });
  ctx.restore();
}

/* ── Vẽ từng loại công cụ ───────────────────────────────────────────────── */

export function drawDrawing(drawing: Drawing, rc: RenderContext) {
  if (!drawing.visible) return;

  const pts = pixelsOf(drawing, rc.mapper, rc);
  if (!pts?.length) return;

  const { ctx, pane } = rc;
  const style = drawing.style;
  ctx.save();
  applyStyle(ctx, style);

  // Hình đang vẽ dở chưa đủ điểm neo: các nhánh bên dưới đọc `points[i]` theo số điểm của hình
  // hoàn chỉnh, nên chỉ nối tạm những điểm đã chốt.
  const required = TOOL_META[drawing.tool].points;
  if (required !== 'freehand' && pts.length < required) {
    applyStyle(ctx, { ...style, lineStyle: 'dashed' });
    for (let i = 1; i < pts.length; i++) line(ctx, pts[i - 1], pts[i]);
    ctx.restore();
    return;
  }

  switch (drawing.tool) {
    case 'trendline':
    case 'arrow':
      line(ctx, pts[0], pts[1]);
      if (drawing.tool === 'arrow') drawArrowHead(ctx, pts[0], pts[1], style.color);
      break;

    case 'ray': {
      const { start, end } = extendLine(pts[0], pts[1], pane.width, pane.height, false);
      line(ctx, start, end);
      break;
    }

    case 'extended': {
      const { start, end } = extendLine(pts[0], pts[1], pane.width, pane.height, true);
      line(ctx, start, end);
      break;
    }

    case 'hline':
      line(ctx, { x: 0, y: pts[0].y }, { x: pane.width, y: pts[0].y });
      label(
        rc,
        formatPrice(drawing.points[0].price, rc.digits),
        pane.width - 4,
        pts[0].y,
        style.color,
        style.fontSize,
        'right',
      );
      break;

    case 'hray':
      line(ctx, pts[0], { x: pane.width, y: pts[0].y });
      label(
        rc,
        formatPrice(drawing.points[0].price, rc.digits),
        pane.width - 4,
        pts[0].y,
        style.color,
        style.fontSize,
        'right',
      );
      break;

    case 'vline':
      line(ctx, { x: pts[0].x, y: 0 }, { x: pts[0].x, y: pane.height });
      break;

    case 'rect': {
      const [a, b] = pts;
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      ctx.fillStyle = withAlpha(style.color, style.fillOpacity);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      break;
    }

    case 'ellipse': {
      const [a, b] = pts;
      ctx.beginPath();
      ctx.ellipse(
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        Math.abs(b.x - a.x) / 2,
        Math.abs(b.y - a.y) / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = withAlpha(style.color, style.fillOpacity);
      ctx.fill();
      ctx.stroke();
      break;
    }

    case 'triangle': {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = withAlpha(style.color, style.fillOpacity);
      ctx.fill();
      ctx.stroke();
      break;
    }

    case 'channel': {
      // pts[0]→pts[1] là đường cơ sở; pts[2] quyết định độ rộng kênh theo trục giá.
      const [a, b, c] = pts;
      const offset = c.y - (a.y + (b.y - a.y) * ((c.x - a.x) / (b.x - a.x || 1)));
      const a2 = { x: a.x, y: a.y + offset };
      const b2 = { x: b.x, y: b.y + offset };

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b2.x, b2.y);
      ctx.lineTo(a2.x, a2.y);
      ctx.closePath();
      ctx.fillStyle = withAlpha(style.color, style.fillOpacity);
      ctx.fill();

      line(ctx, a, b);
      line(ctx, a2, b2);
      break;
    }

    case 'fib':
      drawFib(rc, drawing, pts, FIB_LEVELS, false);
      break;

    case 'fibext':
      drawFib(rc, drawing, pts, FIB_EXT_LEVELS, true);
      break;

    case 'longpos':
    case 'shortpos':
      drawPosition(rc, drawing, pts);
      break;

    case 'brush':
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      break;

    case 'text':
      if (style.text) drawTextBox(rc, pts[0], style.text, style, false);
      break;

    case 'note':
      // Viền quanh hộp để ghi chú dán trên khung tách hẳn khỏi nến phía sau — nó không thuộc về
      // một mốc thời gian nào, nên phải nhìn ra ngay là "dán lên trên", không phải "đánh dấu tại".
      if (style.text) drawTextBox(rc, pts[0], style.text, style, true);
      break;

    case 'measure':
      drawMeasure(rc, drawing, pts);
      break;
  }

  ctx.restore();

  // Điểm neo chỉ hiện khi hình được chọn và chưa khoá. Bút vẽ có hàng trăm điểm nên bỏ qua; hộp
  // chữ thì kéo được ở cả mặt hộp, mà điểm neo lại nằm lệch khi hộp bị đẩy vào trong ở sát mép.
  if (rc.selected && !drawing.locked && drawing.tool !== 'brush' && drawing.tool !== 'note') {
    drawHandles(ctx, pts, style.color);
  }
}

/**
 * Hộp chữ nhiều dòng, neo góc trên trái vào `at`.
 *
 * Hộp tự lùi vào trong khi chạm mép phải hoặc mép dưới **của vùng nến**: ghi chú dán ở sát mép mà
 * tràn ra ngoài thì mất luôn phần chữ — bị cột giá che, hoặc bị lớp xén cắt mất — và người dùng
 * không có cách nào kéo nó về vì phần chạm được cũng nằm ngoài.
 */
function drawTextBox(
  rc: RenderContext,
  at: Pixel,
  text: string,
  style: DrawingStyle,
  boxed: boolean,
) {
  const { ctx } = rc;
  const lines = text.split('\n');
  const { width: boxWidth, height: boxHeight } = textBoxSize(
    text,
    style.fontSize,
    style.fontFamily,
  );

  const x = Math.max(0, Math.min(at.x, rc.pane.width - boxWidth));
  const y = Math.max(0, Math.min(at.y, rc.pane.height - boxHeight));

  ctx.save();
  ctx.setLineDash([]);

  // Nền luôn là nền giao diện, không phải màu của hình: chữ cũng mang màu đó, tô nền cùng màu là
  // chữ chìm hẳn vào nền.
  ctx.fillStyle = rc.palette.labelBg;
  ctx.fillRect(x, y, boxWidth, boxHeight);

  // Viền lấy đúng độ dày và kiểu nét đã chọn ở thanh chỉnh kiểu. Độ dày 0 là **không viền** —
  // ghi chú đặt giữa vùng nến trống nhiều khi sạch hơn khi bỏ hẳn khung.
  if (boxed && style.lineWidth > 0) {
    applyStyle(ctx, style);
    ctx.strokeRect(x, y, boxWidth, boxHeight);
    ctx.setLineDash([]);
  }

  ctx.font = textFont(style.fontSize, style.fontFamily);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = style.color;
  lines.forEach((line, index) => {
    ctx.fillText(line, x + TEXT_PADDING, y + TEXT_PADDING + index * style.fontSize * LINE_HEIGHT);
  });

  ctx.restore();
}

function drawArrowHead(ctx: CanvasRenderingContext2D, from: Pixel, to: Pixel, color: string) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 10;
  ctx.save();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(
    to.x - size * Math.cos(angle - Math.PI / 6),
    to.y - size * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    to.x - size * Math.cos(angle + Math.PI / 6),
    to.y - size * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawFib(
  rc: RenderContext,
  drawing: Drawing,
  pts: Pixel[],
  levels: { ratio: number; color: string }[],
  extension: boolean,
) {
  const { ctx, pane } = rc;
  const points = drawing.points;

  // Thoái lui: các mức nằm **trong** đoạn P0→P1.
  // Mở rộng: lấy biên độ P0→P1 rồi chiếu tiếp từ điểm neo thứ ba.
  const basePrice = extension ? points[2].price : points[0].price;
  const range = points[1].price - points[0].price;

  const left = Math.min(...pts.map((p) => p.x));
  const right = extension ? pane.width : Math.max(...pts.map((p) => p.x));

  ctx.save();
  levels.forEach(({ ratio, color }, index) => {
    const price = extension ? basePrice + range * ratio : points[1].price - range * ratio;
    const y = rc.mapper.toY(price);
    if (y === null) return;

    // Tô nền dải giữa hai mức liền kề — nhìn ra vùng giá ngay mà không phải đọc số.
    if (index > 0) {
      const prevRatio = levels[index - 1].ratio;
      const prevPrice = extension
        ? basePrice + range * prevRatio
        : points[1].price - range * prevRatio;
      const prevY = rc.mapper.toY(prevPrice);
      if (prevY !== null) {
        ctx.fillStyle = withAlpha(color, drawing.style.fillOpacity * 0.4);
        ctx.fillRect(left, Math.min(y, prevY), right - left, Math.abs(y - prevY));
      }
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    line(ctx, { x: left, y }, { x: right, y });
    label(rc, `${ratio} (${formatPrice(price, rc.digits)})`, left + 4, y - 8, color, 10);
  });

  // Đường nối các điểm neo, để thấy rõ chiều đo.
  applyStyle(ctx, { ...drawing.style, lineStyle: 'dashed' });
  for (let i = 1; i < pts.length; i++) line(ctx, pts[i - 1], pts[i]);
  ctx.restore();
}

/**
 * Dự báo vị thế: điểm thứ nhất là giá mua vào, điểm thứ hai định vùng cắt lỗ. Vùng chốt lời cố
 * định theo tỉ lệ lời/lỗ 2:1 — kéo điểm thứ hai thì cả hai vùng co giãn theo.
 */
function drawPosition(rc: RenderContext, drawing: Drawing, pts: Pixel[]) {
  const { ctx, palette } = rc;
  const isLong = drawing.tool === 'longpos';
  const [entry, target] = drawing.points;

  const risk = Math.abs(target.price - entry.price);
  const stopPrice = isLong ? entry.price - risk : entry.price + risk;
  const targetPrice = isLong ? entry.price + risk * 2 : entry.price - risk * 2;

  const yEntry = rc.mapper.toY(entry.price);
  const yStop = rc.mapper.toY(stopPrice);
  const yTarget = rc.mapper.toY(targetPrice);
  if (yEntry === null || yStop === null || yTarget === null) return;

  const left = Math.min(pts[0].x, pts[1].x);
  const boxWidth = Math.max(Math.max(pts[0].x, pts[1].x) - left, 60);

  ctx.save();
  ctx.setLineDash([]);

  ctx.fillStyle = withAlpha(palette.up, 0.18);
  ctx.fillRect(left, Math.min(yEntry, yTarget), boxWidth, Math.abs(yTarget - yEntry));

  ctx.fillStyle = withAlpha(palette.down, 0.18);
  ctx.fillRect(left, Math.min(yEntry, yStop), boxWidth, Math.abs(yStop - yEntry));

  ctx.strokeStyle = palette.muted;
  ctx.lineWidth = 1;
  line(ctx, { x: left, y: yEntry }, { x: left + boxWidth, y: yEntry });

  label(rc, `Vào ${formatPrice(entry.price, rc.digits)}`, left + 4, yEntry - 8, palette.labelFg, 10);
  label(rc, `Chốt lời ${formatPrice(targetPrice, rc.digits)}`, left + 4, yTarget + 8, palette.up, 10);
  label(rc, `Cắt lỗ ${formatPrice(stopPrice, rc.digits)}`, left + 4, yStop - 8, palette.down, 10);
  label(rc, 'Lời/lỗ 2:1', left + boxWidth - 4, yEntry + 14, palette.muted, 10, 'right');

  ctx.restore();
}

function drawMeasure(rc: RenderContext, drawing: Drawing, pts: Pixel[]) {
  const { ctx, palette } = rc;
  const [a, b] = drawing.points;
  const delta = b.price - a.price;
  const percent = a.price === 0 ? 0 : (delta / a.price) * 100;
  const color = delta >= 0 ? palette.up : palette.down;

  ctx.save();
  ctx.fillStyle = withAlpha(color, 0.15);
  ctx.fillRect(
    Math.min(pts[0].x, pts[1].x),
    Math.min(pts[0].y, pts[1].y),
    Math.abs(pts[1].x - pts[0].x),
    Math.abs(pts[1].y - pts[0].y),
  );
  applyStyle(ctx, drawing.style);
  line(ctx, pts[0], pts[1]);

  // Khoảng cách theo **ngày lịch**: nến ngày là khung duy nhất của bảng giá, nên đây là con số
  // người dùng đọc được ngay mà không phải quy đổi.
  const days = Math.abs(Math.round((b.time - a.time) / 86_400));
  const text = `${delta >= 0 ? '+' : ''}${formatPrice(delta, rc.digits)} (${percent.toFixed(2)}%) · ${days} ngày`;
  label(rc, text, (pts[0].x + pts[1].x) / 2, Math.min(pts[0].y, pts[1].y) - 12, color, 11, 'center');
  ctx.restore();
}

/* ── Nhãn mốc trên hai trục ─────────────────────────────────────────────── */

/** Cao của một nhãn trục, và cỡ chữ trong đó. Khớp với `layout.fontSize` của biểu đồ. */
const AXIS_TAG_HEIGHT = 18;
const AXIS_TAG_FONT = 11;
/** Dải trục hẹp hơn chừng này coi như **không có** — xem `drawAxisTags`. */
const AXIS_MIN_BAND = 8;
/** Độ mờ của dải nối hai mốc. Phải nhạt hơn hẳn nhãn, nếu không nhãn chìm vào dải. */
const AXIS_SPAN_ALPHA = 0.22;

/** Đổi màu hình sang ba kênh RGB. `null` với những dạng màu không đọc được (tên màu CSS…). */
function toRgb(color: string): [number, number, number] | null {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    if (full.length < 6) return null;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const match = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Màu chữ đặt trên nền màu của hình: trắng hay gần đen, chọn theo độ sáng.
 *
 * Bảng màu hình vẽ có cả `#FF9800` lẫn `#131722` — một màu chữ cố định thì một trong hai đầu bảng
 * chắc chắn không đọc nổi.
 */
function readableInk(color: string): string {
  const rgb = toRgb(color);
  if (!rgb) return '#FFFFFF';
  // Trọng số theo cảm nhận của mắt (Rec. 709): xanh lá sáng hơn hẳn xanh dương ở cùng con số.
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return luminance > 150 ? '#131722' : '#FFFFFF';
}

/**
 * Vẽ một nhãn trục: nền đặc màu hình, chữ canh giữa cả hai chiều.
 *
 * Chiều cao đi vào từ ngoài chứ không lấy cứng `AXIS_TAG_HEIGHT`: nhãn trên trục thời gian phủ
 * trọn bề cao dải trục, còn nhãn trên cột giá thì không thể — chúng xếp chồng theo chiều dọc.
 */
function axisTag(
  ctx: CanvasRenderingContext2D,
  text: string,
  left: number,
  top: number,
  width: number,
  height: number,
  bg: string,
  fg: string,
) {
  ctx.fillStyle = bg;
  ctx.fillRect(left, top, width, height);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.fillText(text, left + width / 2, top + height / 2);
}

/**
 * Những điểm neo đáng dán nhãn.
 *
 * Bút vẽ có hàng trăm điểm — dán hết thì hai trục kín đặc và không đọc được gì. Nó chỉ cần đúng
 * hai mốc đầu và cuối, cũng chính là nghĩa của "bắt đầu — kết thúc".
 */
function tagAnchors(drawing: Drawing): Point[] {
  const pts = drawing.points;
  if (drawing.tool !== 'brush' || pts.length < 3) return pts;
  return [pts[0], pts[pts.length - 1]];
}

/** Kẹp một toạ độ vào trong vùng nến, để dải nối không tràn ra ngoài khi một đầu trôi khỏi màn. */
function clampTo(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

/**
 * Mốc thời gian và mốc giá của hình, dán lên cột giá và trục thời gian — như TradingView.
 *
 * Gọi **ngoài** lớp xén của `DrawingCanvas`: chỗ đứng của những nhãn này chính là hai dải trục
 * mà lớp xén cắt đi. Chỉ dán cho hình đang chọn hoặc đang vẽ dở; dán cho mọi hình thì một biểu đồ
 * mười đường kẻ là hai trục phủ kín nhãn.
 */
export function drawAxisTags(drawing: Drawing, rc: RenderContext) {
  // Ghi chú dán neo theo khung, không theo (nến, giá) — nó không có mốc nào để chỉ lên trục.
  if (!drawing.visible || drawing.pin) return;

  const anchors = tagAnchors(drawing);
  if (!anchors.length) return;

  const { ctx, pane } = rc;
  const bg = drawing.style.color;
  const fg = readableInk(bg);

  ctx.save();
  ctx.setLineDash([]);
  ctx.font = `${AXIS_TAG_FONT}px -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';

  // ── Cột giá ──
  // Đường dọc chỉ có một mốc thời gian, không có mức giá nào để chỉ.
  if (drawing.tool !== 'vline') {
    const band = rc.width - pane.width;
    const texts = anchors.map((anchor) => formatPrice(anchor.price, rc.digits));
    // Không có cột giá thì nép vào trong mép phải vùng nến, còn hơn vẽ ra ngoài canvas. Bề rộng
    // lấy theo nhãn dài nhất để mấy nhãn của cùng một hình thẳng hàng nhau.
    const width =
      band >= AXIS_MIN_BAND
        ? band
        : Math.max(...texts.map((text) => ctx.measureText(text).width)) + 10;
    const left = band >= AXIS_MIN_BAND ? pane.width : pane.width - width;

    const ys = anchors
      .map((anchor) => rc.mapper.toY(anchor.price))
      .filter((y): y is number => y !== null);

    // Dải nối hai mốc: cùng màu nhưng mờ hơn hẳn nhãn — nhìn là thấy ngay hình chiếm khoảng giá
    // nào, không phải đọc hai con số rồi tự trừ. Kẹp vào vùng nhìn thấy chứ không bỏ như nhãn:
    // một đầu trôi ra ngoài màn hình thì phần còn lại vẫn đáng hiện.
    if (ys.length > 1) {
      const top = clampTo(Math.min(...ys), pane.height);
      const bottom = clampTo(Math.max(...ys), pane.height);
      if (bottom - top > 0.5) {
        ctx.fillStyle = withAlpha(bg, AXIS_SPAN_ALPHA);
        ctx.fillRect(left, top, width, bottom - top);
      }
    }

    const seen = new Set<number>();
    anchors.forEach((anchor, index) => {
      const y = rc.mapper.toY(anchor.price);
      // Ngoài vùng giá đang nhìn thấy thì bỏ: nhãn kẹp vào mép sẽ chỉ sai mức giá.
      if (y === null || y < 0 || y > pane.height) return;
      // Hai điểm neo cùng một mức giá (hộp chữ nhật, kênh giá) chỉ cần một nhãn.
      if (seen.has(Math.round(y))) return;
      seen.add(Math.round(y));

      const top = Math.max(0, Math.min(y - AXIS_TAG_HEIGHT / 2, pane.height - AXIS_TAG_HEIGHT));
      axisTag(ctx, texts[index], left, top, width, AXIS_TAG_HEIGHT, bg, fg);
    });
  }

  // ── Trục thời gian ──
  // Đường ngang trải hết bề ngang: mốc thời gian của nó không mang nghĩa gì.
  if (drawing.tool !== 'hline') {
    const band = rc.height - pane.height;
    // Trục thời gian của biểu đồ giá bị tắt khi có cửa sổ chỉ báo — trục thật nằm dưới cửa sổ
    // cuối cùng, một biểu đồ khác hẳn. Lúc đó dán nhãn nép vào mép dưới vùng nến, cao vừa đủ
    // chữ; còn khi có trục thật thì nhãn và dải mờ cùng phủ trọn bề cao của nó.
    const hasAxis = band >= AXIS_TAG_HEIGHT;
    const top = hasAxis ? pane.height : pane.height - AXIS_TAG_HEIGHT - 2;
    const height = hasAxis ? band : AXIS_TAG_HEIGHT;

    const xs = anchors
      .map((anchor) => rc.mapper.toX(anchor.time))
      .filter((x): x is number => x !== null);

    if (xs.length > 1) {
      const from = clampTo(Math.min(...xs), pane.width);
      const to = clampTo(Math.max(...xs), pane.width);
      if (to - from > 0.5) {
        // Phủ trọn bề cao dải trục, y như dải bên cột giá phủ trọn bề rộng của nó — hai dải chỉ
        // cùng một hình, để chúng cao thấp khác nhau thì trông như hai thứ rời rạc.
        ctx.fillStyle = withAlpha(bg, AXIS_SPAN_ALPHA);
        ctx.fillRect(from, top, to - from, height);
      }
    }

    const seen = new Set<number>();
    for (const anchor of anchors) {
      const x = rc.mapper.toX(anchor.time);
      if (x === null || x < 0 || x > pane.width) continue;
      if (seen.has(Math.round(x))) continue;
      seen.add(Math.round(x));

      const text = formatBarTime(anchor.time, rc.intraday);
      const width = ctx.measureText(text).width + 10;
      const left = Math.max(0, Math.min(x - width / 2, pane.width - width));
      axisTag(ctx, text, left, top, width, height, bg, fg);
    }
  }

  ctx.restore();
}
