'use client';

/**
 * Nhóm nút chọn **nhiều giá trị** — dùng cho bộ lọc dạng "chọn các trạng thái muốn gửi tới".
 *
 * Khác `Tabs` (chọn đúng một, đổi màn) và khác `Select` (chọn một, danh sách dài): ở đây người
 * dùng cần thấy hết lựa chọn cùng lúc và bật/tắt từng cái. Màn gửi thông báo thủ công đang dựng
 * tay khối này hai lần cho hai từ điển trạng thái khác nhau.
 */
import { cn } from '@/lib/cn';
import { type SelectOption } from '@/lib/status';
import { Button } from './Button';

export function ToggleGroup({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label?: string;
  options: SelectOption[];
  /** Các mã đang được chọn. */
  value: string[];
  onChange: (next: string[]) => void;
  className?: string;
}) {
  const toggle = (code: string) =>
    onChange(value.includes(code) ? value.filter((v) => v !== code) : [...value, code]);

  return (
    <div className={className}>
      {label && <p className="mb-1.5 text-sm font-medium text-ink-700">{label}</p>}
      <div className={cn('flex flex-wrap gap-2')} role="group" aria-label={label}>
        {options.map((option) => {
          const selected = value.includes(option.value);
          return (
            <Button
              key={option.value}
              size="sm"
              variant={selected ? 'primary' : 'outline'}
              aria-pressed={selected}
              onClick={() => toggle(option.value)}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
