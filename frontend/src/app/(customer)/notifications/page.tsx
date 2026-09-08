'use client';

/**
 * Màn thông báo đầy đủ của khách hàng.
 *
 * Cùng cách cư xử với hộp thông báo bên site quản trị: bấm vào một dòng thì đánh dấu đã đọc rồi
 * **đi tới màn chứa nội dung của nó** (đường dẫn do máy chủ tính — xem `notification_links.py`).
 * Dòng nào không dẫn đi đâu thì không vẽ mũi tên, để người đọc biết trước là bấm cũng không có
 * gì xảy ra.
 *
 * `?highlight=<id>` tô sáng đúng một dòng — dùng khi menu chuông không có đích cụ thể và phải
 * đẩy người dùng sang đây.
 */
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { Button, Card, EmptyState, Icon, Pagination, Spinner } from '@/components/ui';
import { useApiMutation, useApiQuery, usePagination, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDateTime, fromNow } from '@/lib/datetime';
import type { Message, NotificationItem, Page } from '@/types';

/** Chấm đầu dòng theo mức khẩn — cùng bộ màu với menu chuông và hộp thông báo nhân viên. */
const LEVEL_DOT: Record<string, string> = {
  info: 'bg-brand',
  warning: 'bg-tone-amber-fg',
  danger: 'bg-tone-red-fg',
};

function NotificationsContent() {
  const router = useRouter();
  const toast = useToast();
  const searchParams = useSearchParams();
  const highlight = Number(searchParams.get('highlight') ?? 0);
  const { page, size, setPage } = usePagination(20);

  const { data, isLoading, refresh } = useApiQuery<Page<NotificationItem>>(
    `${CUSTOMER}/notifications`,
    { page, size },
  );

  const markRead = useApiMutation<Message, number>((id) =>
    api.post<Message>(`${CUSTOMER}/notifications/${id}/read`),
  );
  const markAllRead = useApiMutation<Message, void>(() =>
    api.post<Message>(`${CUSTOMER}/notifications/read-all`),
  );

  const hasUnread = data?.items.some((n) => !n.read_at);

  async function open(item: NotificationItem) {
    if (!item.read_at) {
      // Không chờ `refresh()` trước khi chuyển màn: đánh dấu đã đọc là việc phụ, còn thứ người
      // dùng vừa yêu cầu là mở nội dung.
      const result = await markRead.mutate(item.id);
      if (result) refresh();
    }
    if (item.link) router.push(item.link);
  }

  return (
    <div className="flex h-full flex-col space-y-5">
      {/*
        Cùng bố cục với site quản trị: thanh công cụ và phân trang đứng yên, chỉ danh sách cuộn.
      */}
      {hasUnread && (
        <div className="flex shrink-0 justify-end">
          <Button
            size="sm"
            variant="outline"
            loading={markAllRead.loading}
            onClick={async () => {
              const result = await markAllRead.mutate();
              if (result) {
                toast.success(result.message);
                refresh();
              }
            }}
          >
            Đánh dấu đã đọc tất cả
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {isLoading ? (
          <div className="py-16">
            <Spinner label="Đang tải…" />
          </div>
        ) : !data?.items.length ? (
          <EmptyState title="Chưa có thông báo nào" />
        ) : (
          <Card padded={false}>
            <ul className="divide-y divide-ink-100">
              {data.items.map((notification) => (
                <li key={notification.id}>
                  <button
                    onClick={() => void open(notification)}
                    className={cn(
                      'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-50',
                      !notification.read_at && 'bg-ink-100/50',
                      notification.id === highlight && 'ring-2 ring-inset ring-ink-900',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                        notification.read_at
                          ? 'bg-transparent'
                          : (LEVEL_DOT[notification.level] ?? LEVEL_DOT.info),
                      )}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      {notification.subject && (
                        <p className="text-sm font-medium text-ink-900">{notification.subject}</p>
                      )}
                      {notification.body && (
                        <p className="mt-0.5 whitespace-pre-line text-sm text-ink-600">
                          {notification.body}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-ink-400">
                        {fromNow(notification.created_at)} ·{' '}
                        {formatDateTime(notification.created_at)}
                      </p>
                    </div>
                    {/* Mũi tên chỉ hiện khi bấm vào thật sự đi đâu đó. */}
                    {notification.link && (
                      <Icon
                        name="chevron-right"
                        size={16}
                        className="mt-1 shrink-0 text-ink-400"
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      {data && data.items.length > 0 && (
        <div className="shrink-0">
          <Pagination
            page={data.page}
            pages={data.pages}
            total={data.total}
            size={data.size}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  );
}

export default function NotificationsPage() {
  // `useSearchParams` bắt buộc phải nằm trong Suspense ở App Router, nếu không `next build` từ
  // chối dựng trang.
  return (
    <Suspense fallback={<Spinner label="Đang tải…" />}>
      <NotificationsContent />
    </Suspense>
  );
}
