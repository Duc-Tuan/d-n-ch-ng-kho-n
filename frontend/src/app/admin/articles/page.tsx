'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  Badge,
  Button,
  ConfirmDialog,
  Input,
  PageHeader,
  RowAction,
  Select,
  StatusBadge,
  Table,
  type Column,
  Icon,
} from '@/components/ui';
import { useAction, useConfirmAction, useDebounced, useList, useStaffSession } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { formatDateTime, toInputDateTime, fromInputDateTime } from '@/lib/datetime';
import { formatNumber } from '@/lib/format';
import { ARTICLE_STATUS, statusOptions } from '@/lib/status';
import type { Article, Message } from '@/types';

export default function AdminArticlesPage() {
  const router = useRouter();
  const { can } = useStaffSession();

  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);

  const list = useList<Article>(`${ADMIN}/articles`, {
    status: status || undefined,
    q: debouncedSearch || undefined,
  });

  const changeStatus = useAction<Message, { id: number; status: string }>(
    ({ id, status }) => api.post<Message>(`${ADMIN}/articles/${id}/status`, { status }),
    { onSuccess: list.refresh },
  );

  const remove = useConfirmAction<Article, Message>(
    (article, reason) => api.del<Message>(`${ADMIN}/articles/${article.id}`, { reason }),
    { onSuccess: list.refresh },
  );

  const columns: Column<Article>[] = [
    {
      key: 'title',
      header: 'Tiêu đề',
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-ink-900">{row.title}</p>
          <p className="text-xs text-ink-500">
            {row.category_name} · {row.slug}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      render: (row) => <StatusBadge map={ARTICLE_STATUS} code={row.status} />,
    },
    {
      key: 'min_package',
      header: 'Gói tối thiểu',
      render: (row) => (row.min_package_id ? <Badge tone="amber">Có giới hạn</Badge> : '—'),
      hideOnMobile: true,
    },
    {
      key: 'published',
      header: 'Xuất bản',
      render: (row) => formatDateTime(row.published_at),
      hideOnMobile: true,
    },
    {
      key: 'views',
      header: 'Lượt xem',
      render: (row) => formatNumber(row.view_count),
      align: 'right',
      hideOnMobile: true,
    },
    {
      key: 'actions',
      header: 'Hành động',
      width: '11rem',
      align: 'center',
      // Ghim mép phải: bảng cuộn ngang bao nhiêu thì cột thao tác vẫn nhìn thấy.
      sticky: 'right',
      render: (row) => (
        <div className="flex justify-center gap-0.5">
          <RowAction
            label="Sửa bài viết"
            icon={<Icon name="edit" size={16} />}
            onClick={() => router.push(`/admin/articles/${row.id}/edit`)}
          />

          {/* YC15 — xem bài đúng như khách hàng thấy, mở tab mới để không mất chỗ đang đứng. */}
          {row.status === 'PUBLISHED' && (
            <RowAction
              label="Xem như khách hàng"
              icon={<Icon name="eye" size={16} />}
              href={`/articles/${row.slug}`}
              external
            />
          )}

          {/* BR-500 — nhân viên soạn chỉ đưa lên PENDING_REVIEW; chỉ content.publish mới xuất bản. */}
          {row.status === 'DRAFT' && (
            <RowAction
              label="Gửi duyệt"
              icon={<Icon name="send" size={16} />}
              onClick={() => changeStatus.run({ id: row.id, status: 'PENDING_REVIEW' })}
            />
          )}

          {row.status === 'PENDING_REVIEW' && can('content.publish') && (
            <RowAction
              label="Xuất bản"
              icon={<Icon name="check" size={16} />}
              onClick={() => changeStatus.run({ id: row.id, status: 'PUBLISHED' })}
            />
          )}

          {can('content.delete') && (
            <RowAction
              label="Xoá bài viết"
              icon={<Icon name="trash" size={16} />}
              danger
              onClick={() => remove.ask(row)}
            />
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex h-full flex-col space-y-3">
      <PageHeader
        title="Bài viết"
        description="Soạn, gửi duyệt và xuất bản nội dung"
        infoTitle="Quy trình duyệt bài viết"
        /* BR-500 — nêu rõ quy trình để nhân viên không thắc mắc vì sao không xuất bản được. */
        info={
          <p>
            Quy trình duyệt: <strong>Nháp → Chờ duyệt → Đã xuất bản → Lưu trữ</strong>. Nội dung tư
            vấn chứng khoán ra công chúng cần một tầng kiểm duyệt, nên chỉ tài khoản có quyền xuất
            bản mới đưa bài lên được.
          </p>
        }
        action={
          can('content.create') ? (
            <Link href="/admin/articles/new">
              <Button>+ Tạo bài viết</Button>
            </Link>
          ) : undefined
        }
      />

      {/* Bộ lọc để trần, không bọc Card và không gắn nhãn — cùng chuẩn với màn Quản lý khách hàng. */}
      <div className="shrink-0 grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-end">
        <Input
          placeholder="Tiêu đề bài viết…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            list.reset();
          }}
          leftAddon={<Icon name="search" size={16} />}
        />
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            list.reset();
          }}
          placeholder="Tất cả trạng thái"
          options={statusOptions(ARTICLE_STATUS)}
        />
      </div>

      <Table
        {...list.tableProps}
        columns={columns}
        rowKey={(row) => row.id}
        emptyMessage="Chưa có bài viết nào khớp bộ lọc"
        fill
        minWidth="62rem"
      />

      <ConfirmDialog
        {...remove.dialogProps}
        title="Xoá bài viết"
        message={`Xoá bài "${remove.target?.title}"? Thao tác này được ghi vào nhật ký hệ thống.`}
        danger
        requireReason
      />
    </div>
  );
}
