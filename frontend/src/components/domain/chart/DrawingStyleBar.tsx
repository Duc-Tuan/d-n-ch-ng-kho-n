'use client';

/**
 * Thanh chỉnh kiểu, nổi lên giữa mép trên biểu đồ khi một hình vẽ đang được chọn.
 *
 * Đặt ngay trên biểu đồ chứ không mở hộp thoại: người dùng đổi màu hay độ dày để nhìn cho rõ hình
 * trong bối cảnh nến quanh nó — che mất biểu đồ thì không còn gì để so.
 *
 * Hình chữ (văn bản, ghi chú dán) có bộ tuỳ chọn **khác hẳn** các hình còn lại: cỡ chữ và phông
 * thay cho độ dày nét. Chúng nằm gọn trong một bảng nhỏ sau nút "Aa" chứ không trải hết ra thanh —
 * bốn cỡ chữ cộng ba phông cộng viền là mười ô, thanh sẽ dài quá nửa bề ngang biểu đồ.
 */
import { useState, type ReactNode } from 'react';

import { Icon, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  FONT_LABELS,
  FONT_SIZES,
  FONT_STACKS,
  type DrawingFont,
  type DrawingStyle,
} from '@/lib/drawings/types';

import { ColorPicker, Popover, Segmented } from './DrawingControls';
import { DrawingTextModal } from './DrawingTextModal';
import type { DrawingStore } from './useDrawings';

const LINE_STYLE_OPTIONS = [
  { value: 'solid' as const, label: '──', title: 'Nét liền' },
  { value: 'dashed' as const, label: '- -', title: 'Nét đứt' },
  { value: 'dotted' as const, label: '···', title: 'Nét chấm' },
];

/** Nút vuông 28px của thanh — dùng chung cho mọi hành động ở đây. */
function BarButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-md text-ink-600 hover:bg-ink-100',
          danger ? 'hover:text-danger' : 'hover:text-ink-900',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function PanelRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-ink-500">{label}</p>
      {children}
    </div>
  );
}

export function DrawingStyleBar({ store }: { store: DrawingStore }) {
  const [editingText, setEditingText] = useState(false);
  const drawing = store.drawings.find((item) => item.id === store.selectedId);

  // Khoá tất cả hoặc ẩn tất cả thì hình không nhận thao tác nữa, thanh này cũng không có việc gì.
  if (!drawing || store.lockAll || store.hideAll) return null;

  const patch = (style: Partial<DrawingStyle>) => store.updateStyle(drawing.id, style);

  const isText = drawing.tool === 'text' || drawing.tool === 'note';
  const font: DrawingFont = drawing.style.fontFamily ?? 'system';

  return (
    <div
      // `data-chart-ui` — lớp bắt chuột của công cụ vẽ nghe sự kiện trên cả khung biểu đồ, dấu này
      // để nó biết mà nhường: xem `onOverlayUI` trong `DrawingCanvas`.
      data-chart-ui
      className="absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg
                 border border-line bg-surface px-2 py-1.5 shadow-pop"
    >
      <ColorPicker value={drawing.style.color} onChange={(color) => patch({ color })} />

      {isText ? (
        <Popover
          panelClassName="p-3"
          button={({ onClick, open }) => (
            <Tooltip label="Cỡ chữ, phông chữ và viền" side="bottom">
              <button
                type="button"
                aria-label="Cỡ chữ và phông chữ"
                onClick={onClick}
                className={cn(
                  'flex h-7 items-center gap-1 rounded-md border border-line px-1.5 transition-colors',
                  open ? 'bg-primary/15 text-primary' : 'text-ink-700 hover:bg-ink-100',
                )}
              >
                {/* Nút tự mang phông và cỡ đang dùng: nhìn là biết đang ở đâu, khỏi mở ra xem. */}
                <span className="text-sm font-semibold" style={{ fontFamily: FONT_STACKS[font] }}>
                  Aa
                </span>
                <span className="text-[10px] tabular-nums text-ink-500">
                  {drawing.style.fontSize}
                </span>
              </button>
            </Tooltip>
          )}
          panel={() => (
            <div className="w-max space-y-2.5">
              <PanelRow label="Cỡ chữ">
                <Segmented
                  label="Cỡ chữ"
                  value={drawing.style.fontSize}
                  onChange={(fontSize) => patch({ fontSize })}
                  options={FONT_SIZES.map((size) => ({ value: size, label: String(size) }))}
                />
              </PanelRow>

              <PanelRow label="Phông chữ">
                <Segmented
                  label="Phông chữ"
                  value={font}
                  onChange={(fontFamily) => patch({ fontFamily })}
                  options={(Object.keys(FONT_LABELS) as DrawingFont[]).map((key) => ({
                    value: key,
                    label: <span style={{ fontFamily: FONT_STACKS[key] }}>{FONT_LABELS[key]}</span>,
                  }))}
                />
              </PanelRow>

              {/* Chỉ ghi chú dán mới có khung để viền; văn bản theo nến không vẽ khung nào. */}
              {drawing.tool === 'note' && (
                <>
                  <PanelRow label="Viền">
                    <Segmented
                      label="Độ dày viền"
                      value={drawing.style.lineWidth}
                      onChange={(lineWidth) => patch({ lineWidth })}
                      options={[
                        { value: 0, label: 'Không', title: 'Không viền' },
                        { value: 1, label: '1px' },
                        { value: 2, label: '2px' },
                        { value: 3, label: '3px' },
                      ]}
                    />
                  </PanelRow>

                  <PanelRow label="Kiểu nét">
                    <Segmented
                      label="Kiểu nét viền"
                      value={drawing.style.lineStyle}
                      onChange={(lineStyle) => patch({ lineStyle })}
                      options={LINE_STYLE_OPTIONS}
                    />
                  </PanelRow>
                </>
              )}
            </div>
          )}
        />
      ) : (
        <>
          <Segmented
            label="Độ dày nét"
            value={drawing.style.lineWidth}
            onChange={(lineWidth) => patch({ lineWidth })}
            options={[1, 2, 3, 4].map((width) => ({ value: width, label: `${width}px` }))}
          />

          <Segmented
            label="Kiểu nét"
            value={drawing.style.lineStyle}
            onChange={(lineStyle) => patch({ lineStyle })}
            options={LINE_STYLE_OPTIONS}
          />
        </>
      )}

      <div className="h-5 w-px bg-line" />

      {isText && (
        <BarButton label="Sửa nội dung" onClick={() => setEditingText(true)}>
          <Icon name="edit" size={15} />
        </BarButton>
      )}

      <BarButton label="Nhân bản" onClick={() => store.duplicate(drawing.id)}>
        <Icon name="copy" size={15} />
      </BarButton>

      <BarButton
        label={drawing.locked ? 'Mở khoá hình này' : 'Khoá hình này'}
        onClick={() => store.update(drawing.id, { locked: !drawing.locked })}
      >
        <Icon name={drawing.locked ? 'lock' : 'unlock'} size={15} />
      </BarButton>

      <BarButton label="Xoá hình này (Delete)" danger onClick={() => store.remove(drawing.id)}>
        <Icon name="trash" size={15} />
      </BarButton>

      <DrawingTextModal
        open={editingText}
        initial={drawing.style.text ?? ''}
        title={drawing.tool === 'note' ? 'Sửa ghi chú dán trên khung' : 'Sửa văn bản trên biểu đồ'}
        onSubmit={(text) => {
          store.updateStyle(drawing.id, { text });
          setEditingText(false);
        }}
        onCancel={() => setEditingText(false)}
      />
    </div>
  );
}
