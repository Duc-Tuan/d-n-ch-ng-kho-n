'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { statusMeta, type BadgeTone, type StatusMeta } from '@/lib/status';

/**
 * Mỗi sắc thái là một bộ ba biến, không phải màu cứng của Tailwind: chip pastel của bản sáng
 * (`bg-green-50`) đặt lên nền tối chói như một miếng giấy dán. Bản tối dùng nền đậm độ bão hoà
 * thấp kèm chữ sáng — cùng một thông tin, cùng một sắc, khác độ sáng.
 */
const TONE_CLASS: Record<BadgeTone, string> = {
  gray: 'bg-tone-gray-bg text-tone-gray-fg ring-tone-gray-line',
  blue: 'bg-tone-blue-bg text-tone-blue-fg ring-tone-blue-line',
  green: 'bg-tone-green-bg text-tone-green-fg ring-tone-green-line',
  amber: 'bg-tone-amber-bg text-tone-amber-fg ring-tone-amber-line',
  red: 'bg-tone-red-bg text-tone-red-fg ring-tone-red-line',
  cyan: 'bg-tone-cyan-bg text-tone-cyan-fg ring-tone-cyan-line',
  purple: 'bg-tone-purple-bg text-tone-purple-fg ring-tone-purple-line',
};

export function Badge({
  children,
  tone = 'gray',
  title,
  className,
  dot = false,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  title?: string;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1',
        'text-xs font-medium ring-1 ring-inset',
        TONE_CLASS[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

/**
 * Nhãn trạng thái đọc từ từ điển ở `lib/status`.
 *
 * `title` mang mô tả ý nghĩa — nhân viên mới hover là hiểu ngay, không phải tra tài liệu.
 * BR-821: mô tả cũng hiển thị được bằng chạm nhờ thuộc tính title trên mobile giữ nguyên nội dung.
 */
export function StatusBadge({
  map,
  code,
  className,
  showHint = true,
}: {
  map: Record<string, StatusMeta>;
  code: string | null | undefined;
  className?: string;
  showHint?: boolean;
}) {
  const meta = statusMeta(map, code);
  return (
    <Badge tone={meta.tone} title={showHint ? meta.hint : undefined} className={className} dot>
      {meta.label}
    </Badge>
  );
}
