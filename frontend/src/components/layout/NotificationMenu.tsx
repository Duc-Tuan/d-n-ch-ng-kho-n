'use client';

/**
 * Menu thông báo nhanh ở header.
 *
 * Xem nhanh vài thông báo chưa đọc ngay tại chỗ, **không rời trang đang làm việc**. Chỉ khi bấm
 * "Xem tất cả" mới chuyển sang màn thông báo riêng. Bấm vào một thông báo thì đánh dấu đã đọc và
 * đi tới nội dung liên quan.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import { Icon, Spinner } from '@/components/ui';
import { useApiQuery, useClickOutside } from '@/hooks';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fromNow } from '@/lib/datetime';
import type { NotificationItem, Page } from '@/types';

const PREVIEW_COUNT = 6;

export function NotificationMenu({
  basePath,
  listPath,
}: {
  /** Tiền tố API: `/customer` hoặc `/admin`. */
  basePath: string;
  /** Đường dẫn màn thông báo đầy đủ. */
  listPath: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useClickOutside<HTMLDivElement>(close);

  const { data: unread, refresh: refreshCount } = useApiQuery<{ count: number }>(
    `${basePath}/notifications/unread-count`,
    undefined,
    { refreshInterval: 60_000 },
  );

  // Chỉ tải danh sách khi người dùng thực sự mở menu — không tốn request nền.
  const { data, isLoading, refresh } = useApiQuery<Page<NotificationItem>>(
    open ? `${basePath}/notifications` : null,
    { size: PREVIEW_COUNT, unread_only: true },
  );

  const count = unread?.count ?? 0;
  const items = data?.items ?? [];

  async function openItem(item: NotificationItem) {
    close();
    if (!item.read_at) {
      try {
        await api.post(`${basePath}/notifications/${item.id}/read`);
        refresh();
        refreshCount();
      } catch {
        /* đánh dấu đã đọc thất bại không được chặn việc mở nội dung */
      }
    }
    router.push(`${listPath}?highlight=${item.id}`);
  }

  async function markAllRead() {
    try {
      await api.post(`${basePath}/notifications/read-all`);
      refresh();
      refreshCount();
    } catch {
      /* bỏ qua */
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={count > 0 ? `Thông báo (${count} chưa đọc)` : 'Thông báo'}
        className={cn(
          'relative flex h-touch w-touch items-center justify-center rounded-lg text-ink-600 transition-colors hover:bg-ink-100',
          open && 'bg-ink-100',
        )}
      >
        <Icon name="bell" size={20} />
        {count > 0 && (
          <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-danger-fg">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+0.375rem)] z-50 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface-raised shadow-pop animate-slide-up"
        >
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2.5">
            <p className="text-sm font-semibold text-ink-900">
              Thông báo chưa đọc{count > 0 && ` (${count})`}
            </p>
            {count > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs font-medium text-ink-600 hover:text-ink-900 hover:underline"
              >
                Đánh dấu đã đọc
              </button>
            )}
          </div>

          <div className="max-h-[24rem] overflow-y-auto overscroll-contain">
            {isLoading ? (
              <div className="py-8">
                <Spinner />
              </div>
            ) : !items.length ? (
              <div className="px-4 py-10 text-center">
                <Icon name="check" size={28} className="mx-auto mb-2 text-ink-300" />
                <p className="text-sm text-ink-500">Bạn đã đọc hết thông báo</p>
              </div>
            ) : (
              <ul className="divide-y divide-ink-100">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      onClick={() => openItem(item)}
                      className="flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-ink-50"
                    >
                      <span
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand"
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        {item.subject && (
                          <span className="block text-sm font-medium text-ink-900">
                            {item.subject}
                          </span>
                        )}
                        {item.body && (
                          <span className="mt-0.5 line-clamp-2 block text-xs text-ink-600">
                            {item.body}
                          </span>
                        )}
                        <span className="mt-1 block text-[11px] text-ink-400">
                          {fromNow(item.created_at)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            onClick={() => {
              close();
              router.push(listPath);
            }}
            className="flex min-h-touch w-full items-center justify-center gap-1.5 border-t border-ink-100 bg-ink-50/60 text-sm font-medium text-ink-800 transition-colors hover:bg-ink-100"
          >
            Xem tất cả thông báo
            <Icon name="chevron-right" size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
