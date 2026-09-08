'use client';

/**
 * Thanh công cụ vẽ — dọc bên trái biểu đồ như TradingView, chuyển thành dải ngang cuộn được trên
 * màn hẹp.
 *
 * Hai mươi công cụ trải phẳng ra thì thanh dài quá khung và phần dưới bị cắt mất, nên mỗi **nhóm**
 * chỉ chiếm một ô: ô hiện công cụ đang dùng của nhóm đó, mũi tên nhỏ ở góc mở danh sách còn lại.
 */
import { useState } from 'react';

import { Icon, Tooltip, type IconName } from '@/components/ui';
import { cn } from '@/lib/cn';
import { TOOL_META, type DrawingTool } from '@/lib/drawings/types';

import { ColorPicker, Popover } from './DrawingControls';
import type { DrawingStore } from './useDrawings';

const ICONS: Record<DrawingTool, IconName> = {
  cursor: 'cursor',
  crosshair: 'crosshair',
  trendline: 'line-diagonal',
  ray: 'ray',
  extended: 'line-extended',
  hline: 'line-h',
  hray: 'line-h-ray',
  vline: 'line-v',
  channel: 'channel',
  rect: 'square',
  ellipse: 'circle',
  triangle: 'triangle',
  fib: 'fibonacci',
  fibext: 'fibonacci',
  longpos: 'position-long',
  shortpos: 'position-short',
  text: 'text',
  note: 'note',
  arrow: 'arrow-up-right',
  brush: 'brush',
  measure: 'ruler',
};

const GROUPS: { label: string; tools: DrawingTool[] }[] = [
  { label: 'Con trỏ', tools: ['cursor', 'crosshair'] },
  { label: 'Đường', tools: ['trendline', 'ray', 'extended', 'hline', 'hray', 'vline', 'channel'] },
  { label: 'Hình', tools: ['rect', 'ellipse', 'triangle'] },
  { label: 'Fibonacci', tools: ['fib', 'fibext'] },
  { label: 'Dự báo vị thế', tools: ['longpos', 'shortpos'] },
  { label: 'Chú thích', tools: ['text', 'note', 'arrow', 'brush'] },
  { label: 'Đo lường', tools: ['measure'] },
];

/**
 * Vạch ngăn giữa các nhóm. Thanh ngang (màn hẹp) cần vạch **dọc**, thanh dọc (từ `md`) cần vạch
 * **ngang** — nên không dùng được một lớp cố định cho cả hai.
 */
function Divider() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-line md:mx-0 md:my-0.5 md:h-px md:w-5" />;
}

function ToolButton({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: IconName;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        aria-label={label}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
          active
            ? 'bg-primary/15 text-primary'
            : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900',
        )}
      >
        <Icon name={icon} size={17} />
      </button>
    </Tooltip>
  );
}

function ToolGroup({
  label,
  tools,
  activeTool,
  onPick,
}: {
  label: string;
  tools: DrawingTool[];
  activeTool: DrawingTool;
  onPick: (tool: DrawingTool) => void;
}) {
  /** Công cụ dùng gần nhất trong nhóm — bấm thẳng vào ô là chọn lại nó, khỏi mở menu. */
  const [recent, setRecent] = useState<DrawingTool>(tools[0]);

  const activeInGroup = tools.includes(activeTool);
  const shown = activeInGroup ? activeTool : recent;

  const pick = (tool: DrawingTool) => {
    setRecent(tool);
    onPick(tool);
  };

  return (
    <div className="relative flex shrink-0 flex-col items-center">
      <ToolButton
        active={activeInGroup}
        label={TOOL_META[shown].label}
        icon={ICONS[shown]}
        onClick={() => pick(shown)}
      />

      {tools.length > 1 && (
        <Popover
          panelClassName="min-w-48"
          button={({ onClick }) => (
            <button
              type="button"
              onClick={onClick}
              aria-label={`Mở nhóm ${label}`}
              className="absolute bottom-0 right-0 text-ink-400 hover:text-ink-900"
            >
              <Icon name="chevron-right" size={10} />
            </button>
          )}
          panel={(close) => (
            <>
              <p className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-ink-400">
                {label}
              </p>
              {tools.map((tool) => {
                const meta = TOOL_META[tool];
                return (
                  <button
                    key={tool}
                    type="button"
                    onClick={() => {
                      pick(tool);
                      close();
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors',
                      activeTool === tool
                        ? 'bg-primary/15 text-primary'
                        : 'text-ink-700 hover:bg-ink-100',
                    )}
                  >
                    <Icon name={ICONS[tool]} size={15} className="shrink-0" />
                    <span className="flex-1">{meta.label}</span>
                    {meta.shortcut && (
                      <span className="text-xs text-ink-400">{meta.shortcut}</span>
                    )}
                  </button>
                );
              })}
            </>
          )}
        />
      )}
    </div>
  );
}

export function DrawingToolbar({ store }: { store: DrawingStore }) {
  const [confirmClear, setConfirmClear] = useState(false);

  return (
    // Màn hẹp: một dải ngang dưới biểu đồ, cuộn ngang được. Mọi bảng chọn đều mở qua portal nên
    // `overflow` ở đây không xén chúng.
    <aside
      className={cn(
        'flex shrink-0 items-center border-line bg-surface',
        // Màn hẹp thanh nằm **dưới** biểu đồ (`order-last`), nếu ở trên thì nó đẩy phần nến xuống
        // và ngón tay cầm điện thoại phải với qua cả biểu đồ mới tới được công cụ.
        'order-last w-full flex-row flex-nowrap gap-0.5 overflow-x-auto border-t px-1.5 py-1',
        'md:order-none',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        'md:w-12 md:flex-col md:gap-0 md:overflow-visible md:border-r md:border-t-0 md:px-0 md:py-1',
      )}
    >
      {GROUPS.map((group, index) => (
        <div key={group.label} className="flex shrink-0 flex-row items-center md:w-full md:flex-col">
          <ToolGroup
            label={group.label}
            tools={group.tools}
            activeTool={store.activeTool}
            onPick={store.setActiveTool}
          />
          {index < GROUPS.length - 1 && <Divider />}
        </div>
      ))}

      <Divider />

      <ToolButton
        active={store.magnet}
        label={`Nam châm hút giá OHLC (Alt+M)${store.magnet ? ' — đang bật' : ''}`}
        icon="magnet"
        onClick={store.toggleMagnet}
      />
      <ToolButton
        active={store.lockAll}
        label={store.lockAll ? 'Mở khoá hình vẽ' : 'Khoá toàn bộ hình vẽ'}
        icon={store.lockAll ? 'lock' : 'unlock'}
        onClick={store.toggleLockAll}
      />
      <ToolButton
        active={store.hideAll}
        label={store.hideAll ? 'Hiện lại hình vẽ' : 'Ẩn toàn bộ hình vẽ'}
        icon={store.hideAll ? 'eye-off' : 'eye'}
        onClick={store.toggleHideAll}
      />

      {/* Xoá sạch là thao tác không hoàn tác được, nên phải hỏi lại — nhưng hỏi ngay tại chỗ chứ
          không mở hộp thoại che mất biểu đồ đang xem. */}
      <Popover
        panelClassName="p-2 max-w-56"
        button={({ onClick }) => (
          <Tooltip label={`Xoá toàn bộ hình vẽ của mã này (${store.drawings.length})`}>
            <button
              type="button"
              disabled={!store.drawings.length}
              aria-label="Xoá toàn bộ hình vẽ"
              onClick={() => {
                setConfirmClear(true);
                onClick();
              }}
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
                'text-ink-500 hover:bg-ink-100 hover:text-danger',
                'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-500',
              )}
            >
              <Icon name="trash" size={17} />
            </button>
          </Tooltip>
        )}
        panel={(close) =>
          confirmClear ? (
            <div className="space-y-2 text-sm">
              <p className="text-ink-700">Xoá {store.drawings.length} hình vẽ của mã này?</p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmClear(false);
                    close();
                  }}
                  className="rounded-md px-2 py-1 text-ink-600 hover:bg-ink-100"
                >
                  Huỷ
                </button>
                <button
                  type="button"
                  onClick={() => {
                    store.clear();
                    setConfirmClear(false);
                    close();
                  }}
                  className="rounded-md bg-danger px-2 py-1 text-danger-fg hover:bg-danger-hover"
                >
                  Xoá
                </button>
              </div>
            </div>
          ) : null
        }
      />

      <Divider />

      {/* Màu mặc định cho hình vẽ tiếp theo. Độ dày và kiểu nét chỉnh ở thanh nổi lên khi đã chọn
          một hình cụ thể. */}
      <div className="shrink-0 px-1 py-0.5">
        <Tooltip label="Màu mặc định của hình vẽ">
          <ColorPicker
            value={store.defaultStyle.color}
            onChange={(color) => store.setDefaultStyle({ color })}
          />
        </Tooltip>
      </div>
    </aside>
  );
}
