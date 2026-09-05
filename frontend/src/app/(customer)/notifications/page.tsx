'use client';

import { Button, Card, EmptyState, Pagination, Spinner } from '@/components/ui';
import { useApiMutation, useApiQuery, usePagination, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fromNow } from '@/lib/datetime';
import type { Message, NotificationItem, Page } from '@/types';

export default function NotificationsPage() {
  const toast = useToast();
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
                    onClick={async () => {
                      if (notification.read_at) return;
                      const result = await markRead.mutate(notification.id);
                      if (result) refresh();
                    }}
                    className={cn(
                      'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-50',
                      !notification.read_at && 'bg-ink-100/50',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                        notification.read_at ? 'bg-transparent' : 'bg-brand',
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
                        {fromNow(notification.created_at)}
                      </p>
                    </div>
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
