'use client';

import { useState } from 'react';

import {
  Badge,
  Button,
  Card,
  Input,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Spinner,
} from '@/components/ui';
import { useApiQuery, useDebounced, usePagination } from '@/hooks';
import { ADMIN } from '@/lib/api';
import { formatDateTime } from '@/lib/datetime';
import type { AuditLog, Page } from '@/types';

const ACTION_LABEL: Record<string, string> = {
  'customer.grant_package': 'Cấp/gia hạn gói',
  'customer.suspend': 'Tạm khoá tài khoản',
  'customer.unsuspend': 'Mở khoá tài khoản',
  'customer.close': 'Đóng vĩnh viễn',
  'customer.reopen': 'Mở lại tài khoản',
  'customer.reset_password': 'Gửi mã đặt lại mật khẩu',
  'customer.compliance_exempt': 'Miễn áp điều kiện IB',
  'customer.ib_approve': 'Duyệt liên kết TKCK',
  'article.create': 'Tạo bài viết',
  'article.update': 'Sửa bài viết',
  'article.publish': 'Xuất bản bài viết',
  'article.delete': 'Xoá bài viết',
  'document.upload': 'Tải lên tài liệu',
  'document.delete': 'Xoá tài liệu',
  'staff.create': 'Tạo nhân viên',
  'staff.update': 'Sửa nhân viên',
  'staff.role_change': 'Thay đổi phân quyền',
  'role.update': 'Sửa quyền vai trò',
  'strategy.create': 'Tạo chiến lược',
  'signal.create': 'Nhập tín hiệu',
  'signal.cancel': 'Huỷ tín hiệu',
  'legal.publish': 'Ban hành văn bản',
  'notification.broadcast': 'Gửi thông báo hàng loạt',
  'sync.run_manual': 'Chạy job thủ công',
};

/** Nhóm hành động nhạy cảm — tô đậm để dễ soát. */
const CRITICAL = new Set([
  'customer.close',
  'customer.suspend',
  'customer.compliance_exempt',
  'staff.role_change',
  'role.update',
  'article.delete',
  'document.delete',
]);

export default function AuditPage() {
  const [action, setAction] = useState('');
  const [targetId, setTargetId] = useState('');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const debouncedTarget = useDebounced(targetId);
  const { page, size, setPage, setSize, reset } = usePagination(30);

  const { data: actions } = useApiQuery<string[]>(`${ADMIN}/audit-logs/actions`);
  const { data, isLoading } = useApiQuery<Page<AuditLog>>(`${ADMIN}/audit-logs`, {
    page,
    size,
    action: action || undefined,
    target_id: debouncedTarget || undefined,
    q: search || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
  });

  const clearFilters = () => {
    setAction('');
    setTargetId('');
    setSearch('');
    setDateFrom('');
    setDateTo('');
    reset();
  };

  const hasFilter = Boolean(action || targetId || search || dateFrom || dateTo);

  return (
    <div className="flex h-full flex-col space-y-3">
      <PageHeader
        title="Nhật ký hệ thống"
        description="Toàn bộ thao tác thay đổi dữ liệu trên trang quản trị"
        infoTitle="Nhật ký ghi lại những gì"
        info={
          <p>
            Nhật ký ghi lại: ai thực hiện, hành động gì, trên đối tượng nào, giá trị trước và sau,
            lý do và địa chỉ IP. Đây là dữ liệu bắt buộc để đối soát và xử lý khiếu nại —{' '}
            <strong>không thể sửa hay xoá</strong>.
          </p>
        }
      />

      <div className="shrink-0 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_14rem_10rem_9rem_9rem_auto] lg:items-end">
        <SearchInput
          placeholder="Người thực hiện, lý do, IP…"
          value={search}
          onSearch={(value) => {
            setSearch(value);
            reset();
          }}
        />
        <Select
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            reset();
          }}
          placeholder="Tất cả hành động"
          options={(actions ?? []).map((a) => ({ value: a, label: ACTION_LABEL[a] ?? a }))}
        />
        <Input
          placeholder="ID đối tượng"
          value={targetId}
          onChange={(e) => {
            setTargetId(e.target.value);
            reset();
          }}
        />
        <Input
          type="date"
          aria-label="Từ ngày"
          value={dateFrom}
          onChange={(e) => {
            setDateFrom(e.target.value);
            reset();
          }}
        />
        <Input
          type="date"
          aria-label="Đến ngày"
          value={dateTo}
          onChange={(e) => {
            setDateTo(e.target.value);
            reset();
          }}
        />
        <Button variant="outline" disabled={!hasFilter} onClick={clearFilters}>
          Xoá lọc
        </Button>
      </div>

      {isLoading ? (
        <div className="py-16">
          <Spinner label="Đang tải nhật ký…" />
        </div>
      ) : (
        <>
          {/* Nhật ký cuộn trong khung của nó, không đẩy cả trang dài ra: bộ lọc phía trên và thanh
              phân trang phía dưới luôn ở trong tầm mắt khi đang soát. */}
          <Card padded={false} className="flex min-h-0 flex-1 flex-col">
            <ul className="min-h-0 flex-1 divide-y divide-ink-100 overflow-y-auto overscroll-contain">
              {(data?.items ?? []).map((log) => (
                <li key={log.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={CRITICAL.has(log.action) ? 'red' : 'blue'}>
                      {ACTION_LABEL[log.action] ?? log.action}
                    </Badge>
                    <span className="text-sm font-medium text-ink-900">
                      {log.actor_name ?? `#${log.actor_id}`}
                    </span>
                    {log.target_type && (
                      <span className="text-xs text-ink-500">
                        → {log.target_type} #{log.target_id}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-ink-400">
                      {formatDateTime(log.created_at)}
                      {log.ip && ` · ${log.ip}`}
                    </span>
                  </div>

                  {log.reason && (
                    <p className="mt-1.5 text-sm text-ink-700">
                      <span className="text-ink-500">Lý do:</span> {log.reason}
                    </p>
                  )}

                  {(log.old_value || log.new_value) && (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-xs text-ink-500">
                        Xem thay đổi
                      </summary>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {log.old_value && (
                          <div>
                            <p className="mb-1 text-xs font-medium text-ink-500">Trước</p>
                            <pre className="overflow-x-auto rounded bg-red-50 p-2 text-xs text-ink-700">
                              {JSON.stringify(log.old_value, null, 2)}
                            </pre>
                          </div>
                        )}
                        {log.new_value && (
                          <div>
                            <p className="mb-1 text-xs font-medium text-ink-500">Sau</p>
                            <pre className="overflow-x-auto rounded bg-green-50 p-2 text-xs text-ink-700">
                              {JSON.stringify(log.new_value, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ul>

            {!data?.items.length && (
              <p className="py-14 text-center text-sm text-ink-500">
                {hasFilter ? 'Không có bản ghi nào khớp bộ lọc' : 'Chưa có bản ghi nào'}
              </p>
            )}
          </Card>

          {data && (
            <Pagination
              page={data.page}
              pages={data.pages}
              total={data.total}
              size={data.size}
              onPageChange={setPage}
              onSizeChange={setSize}
            />
          )}
        </>
      )}
    </div>
  );
}
