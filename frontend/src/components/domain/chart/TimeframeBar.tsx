'use client';

/**
 * Chọn khung thời gian: vài nút quen tay, phần còn lại nằm trong menu thả xuống.
 *
 * Bày cả mười một khung thành một hàng nút là cách nhanh nhất để làm hỏng thanh công cụ: trên
 * màn hình hẹp nó đẩy hàng khoảng nhìn và nút *Chỉ báo* xuống dòng thứ hai, và người dùng phải
 * đọc qua mười một nhãn để tìm cái mình cần — trong khi thực tế mỗi người chỉ dùng vài khung.
 * Cách này giống mọi phần mềm biểu đồ: ít nút sẵn, còn lại một cú bấm.
 *
 * Khung đang chọn **luôn nhìn thấy được**, kể cả khi nó không nằm trong nhóm quen tay: chọn 3
 * phút từ menu rồi thấy hàng nút không nút nào sáng thì người dùng không còn cách nào biết biểu
 * đồ đang ở khung nào.
 *
 * Danh mục khung **đọc từ máy chủ**, không viết cứng ở đây: bỏ một khung khỏi danh mục backend
 * mà hàng nút vẫn còn nó thì người dùng bấm vào và nhận một biểu đồ trắng, không kèm lời giải
 * thích nào. Trong lúc chờ máy chủ trả lời thì dùng tạm danh sách dự phòng bên dưới — hàng nút
 * nhấp nháy hiện ra rồi biến mất còn khó chịu hơn một danh sách tạm đúng trong 99% trường hợp.
 */
import { useMemo, useRef, useState } from 'react';

import { Icon } from '@/components/ui';
import { useApiQuery, useClickOutside } from '@/hooks';
import { CUSTOMER } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Timeframe } from '@/types';

/** Khung mặc định — cũng là khung mà chiến lược và backtest chạy trên đó. */
export const DEFAULT_TIMEFRAME = '1D';

/**
 * Khung hiện sẵn thành nút. Bốn cái, phủ bốn tầm nhìn khác nhau — trong phiên, trong tuần,
 * theo phiên, theo tuần — để phần lớn người dùng không phải mở menu lần nào.
 */
const QUICK_CODES = ['15m', '1h', '1D', '1W'];

/**
 * Danh sách dự phòng, khớp `app.services.market_data.timeframes`.
 *
 * Chỉ dùng khi lời gọi lấy danh mục khung chưa về hoặc hỏng. Sai lệch giữa hai bên chỉ ảnh
 * hưởng nhãn hiển thị: mã khung nào không có thật thì máy chủ trả lỗi rõ ràng chứ không im lặng.
 */
const FALLBACK: Timeframe[] = (
  [
    ['1m', '1 phút', 60],
    ['3m', '3 phút', 180],
    ['5m', '5 phút', 300],
    ['15m', '15 phút', 900],
    ['30m', '30 phút', 1800],
    ['1h', '1 giờ', 3600],
    ['2h', '2 giờ', 7200],
    ['4h', '4 giờ', 14400],
    ['1D', '1 ngày', 86400],
    ['1W', '1 tuần', 604800],
    ['1M', '1 tháng', 2592000],
  ] as const
).map(([code, label, seconds]) => ({
  code,
  label,
  short_label: code,
  seconds,
  intraday: seconds < 86400,
  derived: false,
  derive_from: null,
  retention_days: null,
}));

/** Danh mục khung đang dùng được. Tách ra để cả biểu đồ lẫn hàng nút cùng đọc một nguồn. */
export function useTimeframes(): Timeframe[] {
  const { data } = useApiQuery<Timeframe[]>(`${CUSTOMER}/market/timeframes`);
  return useMemo(() => (data?.length ? data : FALLBACK), [data]);
}

/** Gom khung thành nhóm cho menu — mười một dòng phẳng thì mắt phải đọc hết mới tìm được. */
const GROUPS: { label: string; match: (tf: Timeframe) => boolean }[] = [
  { label: 'Phút', match: (tf) => tf.seconds < 3600 },
  { label: 'Giờ', match: (tf) => tf.seconds >= 3600 && tf.seconds < 86400 },
  { label: 'Ngày trở lên', match: (tf) => tf.seconds >= 86400 },
];

export function TimeframeBar({
  value,
  onChange,
  items,
  disabled,
}: {
  value: string;
  onChange: (code: string) => void;
  items: Timeframe[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const closeRef = useRef(() => setOpen(false));
  closeRef.current = () => setOpen(false);
  const containerRef = useClickOutside<HTMLDivElement>(() => closeRef.current());

  /** Nút hiện sẵn: nhóm quen tay, cộng khung đang chọn nếu nó vừa được lấy từ menu ra. */
  const quick = useMemo(() => {
    const shown = items.filter((tf) => QUICK_CODES.includes(tf.code));
    if (!shown.some((tf) => tf.code === value)) {
      const active = items.find((tf) => tf.code === value);
      // Chèn theo đúng thứ tự độ dài nến, không nhét xuống cuối: hàng nút nhảy lộn xộn mỗi lần
      // đổi khung làm người dùng mất luôn cảm giác vị trí của nút mình vừa bấm.
      if (active) return [...shown, active].sort((a, b) => a.seconds - b.seconds);
    }
    return shown;
  }, [items, value]);

  const active = items.find((tf) => tf.code === value);

  return (
    <div ref={containerRef} className="relative flex shrink-0 items-center gap-0.5">
      {quick.map((tf) => (
        <button
          key={tf.code}
          type="button"
          disabled={disabled}
          aria-pressed={value === tf.code}
          title={tf.derived ? `${tf.label} — gộp từ khung ${tf.derive_from}` : tf.label}
          onClick={() => onChange(tf.code)}
          className={cn(
            'min-h-touch shrink-0 rounded-lg px-2.5 text-sm tabular-nums transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-50',
            value === tf.code
              ? 'bg-primary font-medium text-primary-fg'
              : 'text-ink-600 hover:bg-ink-100',
          )}
        >
          {tf.short_label}
        </button>
      ))}

      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Khung thời gian khác (đang chọn ${active?.label ?? value})`}
        title="Khung thời gian khác"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'min-h-touch flex shrink-0 items-center rounded-lg px-1.5 text-ink-600 transition-colors',
          'hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-50',
          open && 'bg-ink-100',
        )}
      >
        <Icon name="chevron-down" size={15} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 min-w-[12rem] rounded-lg border border-line bg-surface-raised py-1 shadow-pop"
        >
          {GROUPS.map((group) => {
            const rows = items.filter(group.match);
            if (!rows.length) return null;
            return (
              <div key={group.label} className="py-0.5">
                <p className="px-3 py-1 text-label font-medium uppercase text-ink-500">
                  {group.label}
                </p>
                {rows.map((tf) => (
                  <button
                    key={tf.code}
                    type="button"
                    role="menuitemradio"
                    aria-checked={value === tf.code}
                    onClick={() => {
                      onChange(tf.code);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
                      value === tf.code
                        ? 'bg-ink-100 font-medium text-ink-900'
                        : 'text-ink-700 hover:bg-ink-100',
                    )}
                  >
                    <span className="w-4 shrink-0 text-primary">
                      {value === tf.code && <Icon name="check" size={14} />}
                    </span>
                    <span className="w-8 shrink-0 tabular-nums">{tf.short_label}</span>
                    <span className="text-ink-500">{tf.label}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
