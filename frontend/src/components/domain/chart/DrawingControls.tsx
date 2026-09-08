'use client';

/**
 * Mấy mảnh giao diện nhỏ dùng chung giữa thanh công cụ vẽ và thanh chỉnh kiểu.
 *
 * `Popover` vẽ ra `document.body` bằng portal, **không** đặt tuyệt đối trong phần tử cha. Lý do
 * rất cụ thể: thanh công cụ trên màn hẹp là một dải `overflow-x-auto`, mà bảng chọn đặt trong nó
 * sẽ bị vùng cuộn xén mất — đúng chỗ cần đọc nhất. Đây cũng là cách `ui/Tooltip` đang làm.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/cn';
import { DRAWING_COLORS } from '@/lib/drawings/types';

const PANEL_GAP = 6;

export function Popover({
  button,
  panel,
  panelClassName,
}: {
  /** Nút mở. Nhận sẵn `onClick` và trạng thái mở để tô nền cho đúng. */
  button: (props: { onClick: () => void; open: boolean }) => ReactNode;
  panel: (close: () => void) => ReactNode;
  panelClassName?: string;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const close = useCallback(() => setPosition(null), []);

  const toggle = useCallback(() => {
    setPosition((current) => {
      if (current) return null;
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return null;

      // Thanh nằm dọc bên trái (md trở lên) → bảng mở sang phải. Thanh nằm ngang dưới biểu đồ
      // (màn hẹp) → mở lên trên, vì phía dưới thường đã sát mép màn hình.
      const horizontalBar = window.innerWidth < 768;
      const left = horizontalBar ? rect.left : rect.right + PANEL_GAP;
      const top = horizontalBar ? rect.top - PANEL_GAP : rect.top;
      return {
        left: Math.max(8, Math.min(left, window.innerWidth - 200)),
        top: Math.max(8, top),
      };
    });
  }, []);

  // Bấm ra ngoài, cuộn trang hoặc Esc đều đóng bảng. Không có phần này thì bảng treo lại giữa màn
  // hình sau khi người dùng đã chuyển sang việc khác.
  useEffect(() => {
    if (!position) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [position, close]);

  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        {button({ onClick: toggle, open: position !== null })}
      </span>

      {mounted &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              left: position.left,
              top: position.top,
              // Mở lên trên ở màn hẹp: neo mép dưới của bảng vào mép trên của nút.
              transform: window.innerWidth < 768 ? 'translateY(-100%)' : undefined,
            }}
            className={cn(
              'fixed z-50 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-pop',
              panelClassName,
            )}
          >
            {panel(close)}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Ô chọn màu: nút vuông tô màu hiện tại, mở ra bảng màu gợi ý kèm ô chọn tự do. */
export function ColorPicker({
  value,
  onChange,
  size = 20,
}: {
  value: string;
  onChange: (color: string) => void;
  size?: number;
}) {
  return (
    <Popover
      panelClassName="p-2"
      button={({ onClick, open }) => (
        <button
          type="button"
          onClick={onClick}
          aria-label="Chọn màu"
          className={cn(
            'rounded border border-line transition-transform hover:scale-105',
            open && 'ring-2 ring-primary',
          )}
          style={{ width: size, height: size, backgroundColor: value }}
        />
      )}
      panel={(close) => (
        <div className="w-max">
          <div className="grid grid-cols-4 gap-1.5">
            {DRAWING_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Màu ${color}`}
                onClick={() => {
                  onChange(color);
                  close();
                }}
                className={cn(
                  'h-6 w-6 rounded border border-line transition-transform hover:scale-110',
                  color.toLowerCase() === value.toLowerCase() && 'ring-2 ring-primary',
                )}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>

          {/* Bảng gợi ý chỉ có tám màu; ai cần màu khác thì dùng bộ chọn của trình duyệt. */}
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-ink-600">
            <input
              type="color"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              className="h-6 w-6 cursor-pointer rounded border border-line bg-transparent p-0"
            />
            Màu khác
          </label>
        </div>
      )}
    />
  );
}

/** Dải nút chọn một trong nhiều giá trị — dùng cho độ dày và kiểu nét. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="flex items-center rounded-md border border-line" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          title={option.title}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-7 min-w-8 px-1.5 text-xs transition-colors first:rounded-l-md last:rounded-r-md',
            option.value === value
              ? 'bg-primary text-primary-fg'
              : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
