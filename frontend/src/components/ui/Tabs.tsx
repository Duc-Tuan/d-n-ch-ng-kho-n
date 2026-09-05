'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export type TabItem = {
  key: string;
  label: ReactNode;
  /** Số đếm hiển thị bên cạnh nhãn (ví dụ: số câu hỏi quá hạn). */
  badge?: number | string;
};

/** Tab cuộn ngang trên mobile — không bao giờ ép xuống dòng làm vỡ layout. */
export function Tabs({
  items,
  active,
  onChange,
  className,
}: {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0', className)}>
      <div className="flex min-w-max gap-1 border-b border-line" role="tablist">
        {items.map((item) => {
          const isActive = item.key === active;
          return (
            <button
              key={item.key}
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(item.key)}
              className={cn(
                'flex min-h-touch items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'border-ink-900 text-ink-900'
                  : 'border-transparent text-ink-500 hover:border-line-strong hover:text-ink-800',
              )}
            >
              {item.label}
              {item.badge !== undefined && item.badge !== 0 && (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-xs',
                    isActive ? 'bg-ink-100 text-ink-900' : 'bg-ink-100 text-ink-600',
                  )}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TabPanel({
  active,
  tabKey,
  children,
  className,
}: {
  active: string;
  tabKey: string;
  children: ReactNode;
  /** Ví dụ `flex min-h-0 flex-1 flex-col` để nội dung tab lấp đầy chiều cao còn lại. */
  className?: string;
}) {
  if (active !== tabKey) return null;
  return (
    <div role="tabpanel" className={cn('pt-4', className)}>
      {children}
    </div>
  );
}
