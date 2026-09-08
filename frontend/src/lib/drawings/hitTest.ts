/**
 * Bắt chuột lên hình vẽ: con trỏ đang chạm vào hình nào, và chạm vào điểm neo hay vào thân hình.
 *
 * Mọi phép đo đều làm trên **pixel**, không phải trên (thời gian, giá): ngưỡng bắt phải giống
 * nhau ở mọi mức phóng to và ở mọi mã, còn khoảng cách theo giá thì không.
 */
import type { DrawingMapper } from './coords';
import { textBoxSize, toPixels, type Pixel } from './renderer';
import type { Drawing } from './types';

/** Bán kính bắt điểm neo (px). Rộng hơn nét vẽ để dễ tóm bằng chuột và bằng ngón tay. */
const HANDLE_HIT_RADIUS = 8;
const LINE_HIT_TOLERANCE = 6;

export interface HitResult {
  /** Trúng điểm neo thứ mấy — dùng để kéo riêng điểm đó. */
  handleIndex: number | null;
  /** Trúng thân hình → kéo cả hình. */
  body: boolean;
}

function distanceToSegment(p: Pixel, a: Pixel, b: Pixel): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);

  // Chiếu p lên AB rồi kẹp t vào [0,1] để không bắt ra ngoài hai đầu đoạn.
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Khoảng cách tới đường thẳng vô hạn qua A,B — cho công cụ đường kéo dài. */
function distanceToLine(p: Pixel, a: Pixel, b: Pixel): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / length;
}

/** Khoảng cách tới tia xuất phát từ A đi qua B rồi kéo dài vô hạn. */
function distanceToRay(p: Pixel, a: Pixel, b: Pixel): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function insideRect(p: Pixel, a: Pixel, b: Pixel): boolean {
  return (
    p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) &&
    p.y <= Math.max(a.y, b.y)
  );
}

export function hitTest(
  drawing: Drawing,
  cursor: Pixel,
  mapper: DrawingMapper,
  canvas: { width: number; height: number },
): HitResult {
  const miss: HitResult = { handleIndex: null, body: false };
  if (!drawing.visible) return miss;

  // Ghi chú dán trên khung quy từ tỉ lệ khung, không đi qua trục thời gian — giống hệt lúc vẽ.
  let pts: Pixel[];
  if (drawing.pin) {
    pts = [{ x: drawing.pin.x * canvas.width, y: drawing.pin.y * canvas.height }];
  } else {
    const pixels = toPixels(drawing.points, mapper);
    if (pixels.some((p) => p === null)) return miss;
    pts = pixels as Pixel[];
  }
  if (!pts.length) return miss;

  // Hình đã khoá vẫn **bắt được** để người dùng chọn rồi mở khoá — chỉ không có điểm neo để kéo.
  // Bỏ hẳn nó khỏi phép bắt thì một hình lỡ khoá là khoá vĩnh viễn, không còn cách nào chạm tới.
  if (drawing.locked) return { handleIndex: null, body: hitBodyOf(drawing, cursor, pts, canvas) };

  // Điểm neo được ưu tiên hơn thân hình: chạm vào chỗ chồng nhau thì người dùng muốn chỉnh hình,
  // không phải dời cả hình đi.
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(cursor.x - pts[i].x, cursor.y - pts[i].y) <= HANDLE_HIT_RADIUS) {
      return { handleIndex: i, body: false };
    }
  }

  return { handleIndex: null, body: hitBodyOf(drawing, cursor, pts, canvas) };
}

/** Con trỏ có nằm trên **thân** hình không — phép đo riêng cho từng loại công cụ. */
function hitBodyOf(
  drawing: Drawing,
  cursor: Pixel,
  pts: Pixel[],
  canvas: { width: number; height: number },
): boolean {
  switch (drawing.tool) {
    case 'trendline':
    case 'arrow':
    case 'measure':
      return distanceToSegment(cursor, pts[0], pts[1]) <= LINE_HIT_TOLERANCE;

    case 'ray':
      return distanceToRay(cursor, pts[0], pts[1]) <= LINE_HIT_TOLERANCE;

    case 'extended':
      return distanceToLine(cursor, pts[0], pts[1]) <= LINE_HIT_TOLERANCE;

    case 'hline':
      return Math.abs(cursor.y - pts[0].y) <= LINE_HIT_TOLERANCE;

    case 'hray':
      return Math.abs(cursor.y - pts[0].y) <= LINE_HIT_TOLERANCE && cursor.x >= pts[0].x;

    case 'vline':
      return Math.abs(cursor.x - pts[0].x) <= LINE_HIT_TOLERANCE;

    case 'rect':
    case 'longpos':
    case 'shortpos':
      return insideRect(cursor, pts[0], pts[1]);

    case 'ellipse': {
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      const rx = Math.abs(pts[1].x - pts[0].x) / 2 || 1;
      const ry = Math.abs(pts[1].y - pts[0].y) / 2 || 1;
      return ((cursor.x - cx) / rx) ** 2 + ((cursor.y - cy) / ry) ** 2 <= 1;
    }

    case 'triangle':
    case 'channel':
      return pts.some(
        (_, i) => distanceToSegment(cursor, pts[i], pts[(i + 1) % pts.length]) <= LINE_HIT_TOLERANCE,
      );

    case 'fib':
    case 'fibext': {
      const top = Math.min(...pts.map((p) => p.y));
      const bottom = Math.max(...pts.map((p) => p.y));
      const left = Math.min(...pts.map((p) => p.x));
      // Fibonacci mở rộng kéo các mức tới hết bề ngang, nên vùng bắt cũng phải tới đó.
      const right = drawing.tool === 'fibext' ? canvas.width : Math.max(...pts.map((p) => p.x));
      return cursor.x >= left && cursor.x <= right && cursor.y >= top && cursor.y <= bottom;
    }

    case 'brush':
      return pts.some(
        (_, i) => i > 0 && distanceToSegment(cursor, pts[i - 1], pts[i]) <= LINE_HIT_TOLERANCE,
      );

    case 'text':
    case 'note': {
      // Bắt đúng hộp chữ đã vẽ. Hộp bị đẩy vào trong khi chạm mép, nên phải kẹp y hệt lớp vẽ,
      // nếu không vùng chạm nằm lệch khỏi chữ đúng ở những ghi chú sát mép.
      const text = drawing.style.text;
      if (!text) return false;
      const box = textBoxSize(text, drawing.style.fontSize, drawing.style.fontFamily);
      const x = Math.max(0, Math.min(pts[0].x, canvas.width - box.width));
      const y = Math.max(0, Math.min(pts[0].y, canvas.height - box.height));
      return (
        cursor.x >= x && cursor.x <= x + box.width && cursor.y >= y && cursor.y <= y + box.height
      );
    }

    default:
      return false;
  }
}

/** Tìm hình nằm trên cùng (vẽ sau thì đè lên trước) đang trúng con trỏ. */
export function findDrawingAt(
  drawings: Drawing[],
  cursor: Pixel,
  mapper: DrawingMapper,
  canvas: { width: number; height: number },
): { drawing: Drawing; hit: HitResult } | null {
  for (let i = drawings.length - 1; i >= 0; i--) {
    const hit = hitTest(drawings[i], cursor, mapper, canvas);
    if (hit.handleIndex !== null || hit.body) return { drawing: drawings[i], hit };
  }
  return null;
}
