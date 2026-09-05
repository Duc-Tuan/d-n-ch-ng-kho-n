'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  PageHeader,
  Pagination,
  Spinner,
} from '@/components/ui';
import { useApiMutation, useApiQuery, usePagination, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDateTime, fromNow } from '@/lib/datetime';
import type { Message, Page } from '@/types';

type StaffNotification = {
  id: number;
  code: string;
  subject: string | null;
  body: string | null;
  read_at: string | null;
  created_at: string;
  link: string | null;
  level: string;
};

const LEVEL_TONE: Record<string, 'gray' | 'blue' | 'amber' | 'red'> = {
  info: 'blue',
  warning: 'amber',
  danger: 'red',
};

const CODE_LABEL: Record<string, string> = {
  NEW_QUESTION: 'Câu hỏi mới',
  NEW_CUSTOMER: 'Khách hàng mới',
  NEW_PAYMENT: 'Thanh toán mới',
  COMPLIANCE_ALERT: 'Cảnh báo điều kiện',
  JOB_FAILED: 'Job thất bại',
  IB_LINK_REQUEST: 'Yêu cầu liên kết TKCK',
};

function InboxContent() {
  const router = useRouter();
  const toast = useToast();
  const searchParams = useSearchParams();
  const highlight = Number(searchParams.get('highlight') ?? 0);
  const { page, size, setPage, setSize } = usePagination(30);

  const { data, isLoading, refresh } = useApiQuery<Page<StaffNotification>>(
    `${ADMIN}/notifications-inbox`,
    { page, size },
  );

  const markRead = useApiMutation<Message, number>((id) =>
    api.post<Message>(`${ADMIN}/notifications-inbox/${id}/read`),
  );
  const markAll = useApiMutation<Message, void>(() =>
    api.post<Message>(`${ADMIN}/notifications-inbox/read-all`),
  );

  const hasUnread = data?.items.some((n) => !n.read_at);

  return (
    <div className="space-y-3">
      <PageHeader
        title="Hộp thông báo"
        description="Sự kiện vận hành cần người trực xử lý"
        action={
          hasUnread ? (
            <Button
              size="sm"
              variant="outline"
              loading={markAll.loading}
              onClick={async () => {
                const result = await markAll.mutate();
                if (result) {
                  toast.success(result.message);
                  refresh();
                }
              }}
            >
              Đánh dấu đã đọc tất cả
            </Button>
          ) : undefined
        }
      />

      {isLoading ? (
        <div className="py-16">
          <Spinner label="Đang tải…" />
        </div>
      ) : !data?.items.length ? (
        <EmptyState
          title="Chưa có thông báo nào"
          description="Câu hỏi mới của khách hàng và cảnh báo vận hành sẽ hiện tại đây."
        />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-ink-100">
            {data.items.map((item) => (
              <li key={item.id}>
                <button
                  onClick={async () => {
                    if (!item.read_at) {
                      await markRead.mutate(item.id);
                      refresh();
                    }
                    if (item.link) router.push(item.link);
                  }}
                  className={cn(
                    'flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-ink-50',
                    !item.read_at && 'bg-ink-50/60',
                    item.id === highlight && 'ring-2 ring-inset ring-ink-900',
                  )}
                >
                  <span
                    className={cn(
                      'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                      item.read_at ? 'bg-transparent' : 'bg-ink-900',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={LEVEL_TONE[item.level] ?? 'gray'}>
                        {CODE_LABEL[item.code] ?? item.code}
                      </Badge>
                      <span className="text-sm font-medium text-ink-900">{item.subject}</span>
                    </span>
                    {item.body && (
                      <span className="mt-1 block text-sm text-ink-600">{item.body}</span>
                    )}
                    <span className="mt-1 block text-xs text-ink-400">
                      {fromNow(item.created_at)} · {formatDateTime(item.created_at)}
                    </span>
                  </span>
                  {item.link && (
                    <Icon name="chevron-right" size={16} className="mt-1 shrink-0 text-ink-400" />
                  )}
                </button>
              </li>
            ))}
          </ul>

          {/* Dùng component chung thay cho cặp nút Trước/Sau tự chế: cùng cách hiển thị số bản
              ghi và cùng ô chọn số dòng như mọi màn danh sách khác. */}
          <div className="border-t border-ink-100 px-4">
            <Pagination
              page={data.page}
              pages={data.pages}
              total={data.total}
              size={data.size}
              onPageChange={setPage}
              onSizeChange={setSize}
            />
          </div>
        </Card>
      )}
    </div>
  );
}

export default function AdminInboxPage() {
  return (
    <Suspense fallback={<Spinner label="Đang tải…" />}>
      <InboxContent />
    </Suspense>
  );
}
