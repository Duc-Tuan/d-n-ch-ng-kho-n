'use client';

/**
 * Lớp vẽ tay nằm trên biểu đồ giá: bắt chuột, dựng hình, kéo chỉnh.
 *
 * Canvas luôn `pointer-events: none` — nếu nó nhận chuột thì biểu đồ bên dưới mất khả năng kéo và
 * phóng to. Thay vào đó ta nghe sự kiện con trỏ trên **div bọc** (sự kiện của biểu đồ nổi lên tới
 * đó) và **tạm khoá** `handleScroll`/`handleScale` trong lúc người dùng đang vẽ hoặc đang kéo hình.
 *
 * Dùng Pointer Events chứ không phải Mouse Events: một đường xử lý chung cho chuột, bút và ngón
 * tay. Thiếu nó thì trên điện thoại mọi công cụ vẽ đều vô dụng.
 */
import type { ChartOptions, DeepPartial, IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import {
  applyMagnet,
  createDrawingMapper,
  logicalToTime,
  timeToLogical,
} from '@/lib/drawings/coords';
import { findDrawingAt } from '@/lib/drawings/hitTest';
import { drawDrawing, type Pixel, type RenderPalette } from '@/lib/drawings/renderer';
import { TOOL_META, type Drawing, type Point } from '@/lib/drawings/types';
import type { Candle } from '@/lib/indicators/math';

import { isChartLive } from './chartLifecycle';
import { chartColor, down, up } from './chartTheme';
import { DrawingTextModal } from './DrawingTextModal';
import type { DrawingStore } from './useDrawings';

interface DrawingCanvasProps {
  /** Div bọc biểu đồ — nơi bắt sự kiện con trỏ. Canvas chỉ là bề mặt vẽ. */
  hostRef: RefObject<HTMLDivElement | null>;
  chart: IChartApi | null;
  series: ISeriesApi<SeriesType> | null;
  candles: Candle[];
  width: number;
  height: number;
  /** Số chữ số thập phân của nhãn giá. */
  digits: number;
  store: DrawingStore;
  /**
   * Cấu hình kéo/phóng **bình thường** của biểu đồ, để trả lại đúng như cũ sau khi thao tác vẽ
   * xong. Đặt cứng `true` sẽ bật lại cả kéo dọc bằng ngón tay — thứ BR-846 đã tắt trên mobile.
   */
  restoreInteraction: DeepPartial<ChartOptions>;
}

type Interaction =
  | { kind: 'idle' }
  | { kind: 'creating'; points: Point[]; preview: Point | null }
  /**
   * Kéo cả hình. Điểm neo gốc giữ ở dạng **(chỉ số nến, giá)** chứ không phải (giây, giá).
   *
   * Cộng thẳng chênh lệch giây vào từng điểm là sai, và sai rất dễ thấy: một bước chuột qua kỳ
   * nghỉ lễ có thể là bảy ngày lịch, nên hình bị đẩy đi bảy nến trong khi con trỏ mới nhích một
   * nến — nó "nhảy" đi rồi mới về chỗ ở lần di chuột sau. Chỉ số nến thì cách đều nhau đúng bằng
   * khoảng cách trên màn hình, nên hình đi theo con trỏ từng nến một.
   */
  | {
      kind: 'dragging-body';
      id: string;
      origin: { logical: number; price: number }[];
      grabbedLogical: number;
      grabbedPrice: number;
    }
  | { kind: 'dragging-handle'; id: string; handleIndex: number }
  /** Kéo ghi chú dán trên khung — đo bằng pixel, vì nó neo theo khung chứ không theo nến. */
  | {
      kind: 'dragging-pin';
      id: string;
      originPin: { x: number; y: number };
      grabbedPixel: Pixel;
    };

/** Ghi chú đang chờ người dùng nhập nội dung — hình chỉ được tạo sau khi bấm Xong. */
type PendingText =
  | { kind: 'text'; point: Point }
  | { kind: 'note'; pin: { x: number; y: number } };

/** Màu đọc lúc chạy từ biến CSS — site khách nền tối, site quản trị nền sáng. */
function palette(): RenderPalette {
  return {
    labelBg: chartColor('surface', '255 255 255', 0.85),
    labelFg: chartColor('ink-900', '24 24 32'),
    muted: chartColor('ink-500', '113 113 127'),
    up: up(),
    down: down(),
  };
}

export function DrawingCanvas({
  hostRef,
  chart,
  series,
  candles,
  width,
  height,
  digits,
  store,
  restoreInteraction,
}: DrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const interactionRef = useRef<Interaction>({ kind: 'idle' });
  const [pendingText, setPendingText] = useState<PendingText | null>(null);

  // Sự kiện con trỏ được đăng ký một lần trên div bọc, nên chúng phải đọc trạng thái qua ref —
  // đóng gói giá trị lúc đăng ký sẽ khiến chúng làm việc với dữ liệu cũ mãi mãi.
  const storeRef = useRef(store);
  storeRef.current = store;
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };

  const { activeTool, drawings, selectedId, hideAll, lockAll } = store;

  const getMapper = useCallback(() => {
    // Cùng lý do như `ShapesLayer`: biểu đồ đã gỡ vẫn còn nguyên handle trong prop.
    if (!isChartLive(chart) || !series || !candlesRef.current.length) return null;
    return createDrawingMapper(chart, series, candlesRef.current);
  }, [chart, series]);

  /**
   * Bật/tắt kéo-phóng của biểu đồ khi ta đang chiếm quyền điều khiển con trỏ.
   *
   * Chỉ gọi `applyOptions` khi trạng thái **thật sự đổi**: mỗi lần gọi là một lượt dựng lại toàn
   * bộ biểu đồ, và trong khoảnh khắc đó trục thời gian chưa quy đổi được toạ độ. Gọi thừa ở mỗi
   * lần nhả chuột chỉ tạo thêm cơ hội cho những khoảnh khắc như vậy rơi vào giữa một cú kéo.
   */
  const interactiveRef = useRef(true);
  const setChartInteractive = useCallback(
    (enabled: boolean) => {
      if (!chart || interactiveRef.current === enabled) return;
      interactiveRef.current = enabled;
      chart.applyOptions(enabled ? restoreInteraction : { handleScroll: false, handleScale: false });
    },
    [chart, restoreInteraction],
  );

  // Biểu đồ dựng lại (đổi chiều cao, đổi thiết bị) thì nó quay về trạng thái kéo-phóng mặc định,
  // nên cờ ghi nhớ ở đây phải theo về cùng.
  useEffect(() => {
    interactiveRef.current = true;
  }, [chart]);

  const toPoint = useCallback(
    (pixel: Pixel): Point | null => {
      const mapper = getMapper();
      if (!mapper) return null;
      const time = mapper.toTime(pixel.x);
      const price = mapper.toPrice(pixel.y);
      // Thiếu một trong hai thì bỏ qua sự kiện này, đừng đoán: đoán sai một lần là hình nhảy đi
      // một nơi khác hẳn ngay giữa lúc người dùng đang kéo.
      if (time === null || price === null) return null;

      const point: Point = { time, price };
      return storeRef.current.magnet ? applyMagnet(point, candlesRef.current, mapper) : point;
    },
    [getMapper],
  );

  /* ── Vẽ lại canvas ────────────────────────────────────────────────────── */

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width: w, height: h } = sizeRef.current;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const mapper = getMapper();
    if (!mapper || !w || !h || storeRef.current.hideAll) return;

    const base = {
      ctx,
      mapper,
      width: w,
      height: h,
      digits,
      selected: false,
      palette: palette(),
    };

    for (const drawing of storeRef.current.drawings) {
      // Khoá tất cả: hình vẫn hiện nhưng không được phép nhận điểm neo, nên bỏ luôn phần chọn.
      const isSelected =
        !storeRef.current.lockAll && drawing.id === storeRef.current.selectedId;
      drawDrawing(drawing, { ...base, selected: isSelected });
    }

    // Hình đang vẽ dở: nối các điểm đã chốt với vị trí con trỏ.
    const interaction = interactionRef.current;
    if (interaction.kind === 'creating' && interaction.preview) {
      const preview: Drawing = {
        id: '__preview__',
        symbol: '__preview__',
        tool: storeRef.current.activeTool,
        points: [...interaction.points, interaction.preview],
        style: storeRef.current.defaultStyle,
        locked: false,
        visible: true,
      };
      drawDrawing(preview, base);
    }
  }, [getMapper, digits]);

  // Vẽ lại khi người dùng kéo hoặc phóng biểu đồ.
  useEffect(() => {
    if (!isChartLive(chart)) return;
    const timeScale = chart.timeScale();
    const onRangeChange = () => render();
    timeScale.subscribeVisibleLogicalRangeChange(onRangeChange);
    return () => timeScale.unsubscribeVisibleLogicalRangeChange(onRangeChange);
  }, [chart, render]);

  // Vẽ lại khi dữ liệu, kích thước hay trạng thái đổi.
  useEffect(() => {
    render();
  }, [render, drawings, activeTool, selectedId, hideAll, lockAll, candles, width, height]);

  /* ── Sự kiện con trỏ ──────────────────────────────────────────────────── */

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !isChartLive(chart) || !series) return;

    const pixelOf = (event: PointerEvent): Pixel => {
      const rect = host.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    /**
     * Sự kiện có rơi trúng một nút nổi **trên** biểu đồ không (thanh chỉnh kiểu, nhãn chỉ báo).
     *
     * Phải hỏi câu này trước mọi thứ khác: ta nghe `pointerdown` ở pha capture trên cả khung, nên
     * cú bấm vào nút "xoá" cũng chạy qua đây trước. Không có nó thì lớp vẽ hiểu là "bấm ra chỗ
     * trống" và bỏ chọn hình — thanh chỉnh kiểu biến mất ngay trước khi trình duyệt kịp bắn
     * `click`, và mọi nút trên thanh đều như hỏng.
     */
    const onOverlayUI = (event: PointerEvent): boolean =>
      Boolean((event.target as HTMLElement | null)?.closest?.('[data-chart-ui]'));

    const finishDrawing = (points: Point[]) => {
      const state = storeRef.current;
      const style = { ...state.defaultStyle };

      // Văn bản chưa tạo hình ngay: mở ô nhập trước, có nội dung rồi mới tạo. Tạo trước rồi hỏi
      // sau thì lúc người dùng bấm Huỷ, trên biểu đồ đã nằm sẵn một hình rỗng vô hình.
      if (state.activeTool === 'text') {
        setPendingText({ kind: 'text', point: points[0] });
        interactionRef.current = { kind: 'idle' };
        setChartInteractive(true);
        render();
        return;
      }

      const id = state.add({ tool: state.activeTool, points, style, locked: false, visible: true });
      interactionRef.current = { kind: 'idle' };

      // Vẽ xong là trả về con trỏ, giống TradingView: hầu như không ai vẽ hai đường xu hướng liền
      // nhau, mà thao tác ngay sau đó luôn là kéo biểu đồ hoặc chỉnh chính hình vừa vẽ. Không trả
      // về thì cú bấm kế tiếp lại đẻ ra một hình nữa.
      state.setActiveTool('cursor');
      if (id) state.select(id);
      setChartInteractive(true);
    };

    const onPointerDown = (event: PointerEvent) => {
      // Chuột: chỉ nút trái. Chạm và bút: `button === 0` khi mới đặt xuống.
      if (event.button !== 0 || onOverlayUI(event)) return;
      const pixel = pixelOf(event);
      const point = toPoint(pixel);
      const mapper = getMapper();
      if (!point || !mapper) return;

      const state = storeRef.current;
      const tool = state.activeTool;

      if (tool === 'cursor' || tool === 'crosshair') {
        if (state.lockAll || state.hideAll) return;

        const found = findDrawingAt(state.drawings, pixel, mapper, sizeRef.current);
        if (!found) {
          if (state.selectedId) state.select(null);
          return;
        }

        // Hình đã khoá: chọn được (để mở khoá ở thanh chỉnh kiểu) nhưng không kéo được, nên
        // không giành quyền điều khiển của biểu đồ.
        if (found.drawing.locked) {
          state.select(found.drawing.id);
          return;
        }

        // Đã tóm được hình → chặn biểu đồ kéo theo trong lúc chỉnh.
        event.preventDefault();
        event.stopPropagation();
        setChartInteractive(false);
        // Cảm ứng: giữ chuỗi pointer lại, nếu không trình duyệt sẽ cuộn trang ngay khi ngón tay
        // nhích và ta mất `pointermove` giữa chừng.
        host.style.touchAction = 'none';
        host.setPointerCapture(event.pointerId);
        state.select(found.drawing.id);
        const grabbedLogical = mapper.toLogical(pixel.x);
        interactionRef.current = found.drawing.pin
          ? {
              kind: 'dragging-pin',
              id: found.drawing.id,
              originPin: found.drawing.pin,
              grabbedPixel: pixel,
            }
          : found.hit.handleIndex !== null
            ? { kind: 'dragging-handle', id: found.drawing.id, handleIndex: found.hit.handleIndex }
            : grabbedLogical === null
              ? { kind: 'idle' }
              : {
                  kind: 'dragging-body',
                  id: found.drawing.id,
                  origin: found.drawing.points.map((p) => ({
                    logical: timeToLogical(candlesRef.current, p.time),
                    price: p.price,
                  })),
                  grabbedLogical,
                  grabbedPrice: point.price,
                };
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      // Ghi chú dán trên khung không đi qua trục thời gian: chỗ bấm được ghi lại theo **tỉ lệ
      // khung**, nên nó đứng yên khi biểu đồ kéo qua trái phải.
      if (tool === 'note') {
        const { width: w, height: h } = sizeRef.current;
        if (w && h) setPendingText({ kind: 'note', pin: { x: pixel.x / w, y: pixel.y / h } });
        interactionRef.current = { kind: 'idle' };
        return;
      }

      const meta = TOOL_META[tool];

      if (meta.points === 'freehand') {
        interactionRef.current = { kind: 'creating', points: [point], preview: point };
        return;
      }

      const current = interactionRef.current;
      const points = current.kind === 'creating' ? [...current.points, point] : [point];

      if (points.length >= meta.points) finishDrawing(points);
      else interactionRef.current = { kind: 'creating', points, preview: point };
      render();
    };

    const onPointerMove = (event: PointerEvent) => {
      // Rê chuột trên thanh chỉnh kiểu: giữ nguyên con trỏ mũi tên của nút, đừng đổi thành
      // "kéo được" hay dấu chữ thập của công cụ vẽ.
      if (onOverlayUI(event) && interactionRef.current.kind === 'idle') return;

      const pixel = pixelOf(event);
      const state = storeRef.current;

      // Ghi chú dán trên khung xử lý trước, và bằng pixel thuần: nó không cần trục thời gian, nên
      // đừng để một lượt quy đổi hụt làm đứng cả cú kéo.
      if (interactionRef.current.kind === 'dragging-pin') {
        const interaction = interactionRef.current;
        const { width: w, height: h } = sizeRef.current;
        if (!w || !h) return;
        const clamp = (value: number) => Math.max(0, Math.min(1, value));
        state.update(interaction.id, {
          pin: {
            x: clamp(interaction.originPin.x + (pixel.x - interaction.grabbedPixel.x) / w),
            y: clamp(interaction.originPin.y + (pixel.y - interaction.grabbedPixel.y) / h),
          },
        });
        return;
      }

      const mapper = getMapper();
      if (!mapper) return;
      const point = toPoint(pixel);
      if (!point) return;

      const interaction = interactionRef.current;

      switch (interaction.kind) {
        case 'creating':
          if (TOOL_META[state.activeTool].points === 'freehand' && event.buttons === 1) {
            interaction.points.push(point);
          }
          interaction.preview = point;
          render();
          break;

        case 'dragging-body': {
          const logical = mapper.toLogical(pixel.x);
          if (logical === null) break;

          const deltaLogical = logical - interaction.grabbedLogical;
          const deltaPrice = point.price - interaction.grabbedPrice;
          state.update(interaction.id, {
            points: interaction.origin.map((p) => ({
              time: logicalToTime(candlesRef.current, p.logical + deltaLogical),
              price: p.price + deltaPrice,
            })),
          });
          break;
        }

        case 'dragging-handle': {
          const target = state.drawings.find((d) => d.id === interaction.id);
          if (!target) break;
          state.update(interaction.id, {
            points: target.points.map((p, i) => (i === interaction.handleIndex ? point : p)),
          });
          break;
        }

        case 'idle': {
          const tool = state.activeTool;
          if (tool !== 'cursor' && tool !== 'crosshair') {
            host.style.cursor = 'crosshair';
            break;
          }
          if (state.lockAll) {
            host.style.cursor = 'default';
            break;
          }
          const found = findDrawingAt(state.drawings, pixel, mapper, sizeRef.current);
          host.style.cursor = !found
            ? 'default'
            : found.drawing.locked
              ? 'pointer'
              : found.hit.handleIndex !== null
                ? 'pointer'
                : 'move';
          break;
        }
      }
    };

    const onPointerUp = () => {
      const interaction = interactionRef.current;
      const tool = storeRef.current.activeTool;

      if (interaction.kind === 'creating' && TOOL_META[tool].points === 'freehand') {
        if (interaction.points.length > 1) finishDrawing(interaction.points);
        else {
          interactionRef.current = { kind: 'idle' };
          setChartInteractive(true);
        }
        return;
      }

      if (
        interaction.kind === 'dragging-body' ||
        interaction.kind === 'dragging-handle' ||
        interaction.kind === 'dragging-pin'
      ) {
        interactionRef.current = { kind: 'idle' };
        setChartInteractive(true);
        // Kéo xong ở chế độ con trỏ → trả cử chỉ chạm lại cho biểu đồ.
        if (tool === 'cursor' || tool === 'crosshair') host.style.touchAction = '';
      }
    };

    // `pointerdown` bắt ở pha **capture**: biểu đồ gắn listener trên các canvas con của nó, nghe ở
    // pha nổi lên thì nó đã bắt đầu kéo trước khi ta kịp `stopPropagation()`. Ngược lại
    // `pointermove` để nổi lên bình thường — biểu đồ cần nó để vẽ đường ngắm.
    host.addEventListener('pointerdown', onPointerDown, true);
    host.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    // Ngón tay rời màn vì cuộc gọi đến hay cử chỉ hệ thống → `pointerup` không bắn, thao tác sẽ
    // kẹt ở trạng thái đang kéo.
    window.addEventListener('pointercancel', onPointerUp);

    return () => {
      host.removeEventListener('pointerdown', onPointerDown, true);
      host.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [hostRef, chart, series, getMapper, toPoint, render, setChartInteractive]);

  /* ── Khoá kéo-phóng suốt thời gian đang cầm một công cụ vẽ ────────────── */

  useEffect(() => {
    const drawingMode = activeTool !== 'cursor' && activeTool !== 'crosshair';
    setChartInteractive(!drawingMode);
    if (!drawingMode) interactionRef.current = { kind: 'idle' };

    // Trên cảm ứng, trình duyệt nuốt chuỗi pointer để cuộn trang ngay khi ngón tay di chuyển.
    // `touch-action: none` trả sự kiện lại cho ta — chỉ bật lúc đang cầm công cụ vẽ, còn lại phải
    // để biểu đồ kéo và phóng bằng ngón tay.
    const host = hostRef.current;
    if (host) host.style.touchAction = drawingMode ? 'none' : '';

    return () => {
      setChartInteractive(true);
      if (host) host.style.touchAction = '';
    };
  }, [activeTool, setChartInteractive, hostRef]);

  /* ── Phím tắt ─────────────────────────────────────────────────────────── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const state = storeRef.current;

      if (event.key === 'Escape') {
        // Đang vẽ dở thì Escape chỉ huỷ hình đó, chưa trả về con trỏ — người dùng thường muốn vẽ
        // lại ngay bằng đúng công cụ vừa cầm.
        if (interactionRef.current.kind === 'creating') {
          interactionRef.current = { kind: 'idle' };
          render();
          return;
        }
        if (state.activeTool !== 'cursor') {
          state.setActiveTool('cursor');
          return;
        }
        if (state.selectedId) state.select(null);
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedId) {
        event.preventDefault();
        state.remove(state.selectedId);
        return;
      }

      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const shortcut: Record<string, () => void> = {
        t: () => state.setActiveTool('trendline'),
        h: () => state.setActiveTool('hline'),
        v: () => state.setActiveTool('vline'),
        f: () => state.setActiveTool('fib'),
        m: () => state.toggleMagnet(),
      };
      const run = shortcut[event.key.toLowerCase()];
      if (run) {
        event.preventDefault();
        run();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [render]);

  /** Tạo hình văn bản sau khi người dùng đã nhập xong nội dung. */
  const commitText = (text: string) => {
    if (!pendingText) return;
    const state = storeRef.current;
    const style = { ...state.defaultStyle, text };

    const id =
      pendingText.kind === 'note'
        ? state.add({
            tool: 'note',
            // Ghi chú dán không có điểm neo theo nến — vị trí nằm ở `pin`.
            points: [],
            pin: pendingText.pin,
            style,
            locked: false,
            visible: true,
          })
        : state.add({
            tool: 'text',
            points: [pendingText.point],
            style,
            locked: false,
            visible: true,
          });

    setPendingText(null);
    state.setActiveTool('cursor');
    if (id) state.select(id);
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{ width, height, pointerEvents: 'none' }}
        className="absolute inset-0 z-10"
      />

      <DrawingTextModal
        open={pendingText !== null}
        title={pendingText?.kind === 'note' ? 'Ghi chú dán trên khung' : 'Văn bản trên biểu đồ'}
        onSubmit={commitText}
        onCancel={() => {
          setPendingText(null);
          // Huỷ mà vẫn cầm công cụ thì cú bấm kế tiếp lại mở ô nhập lần nữa.
          storeRef.current.setActiveTool('cursor');
        }}
      />
    </>
  );
}
