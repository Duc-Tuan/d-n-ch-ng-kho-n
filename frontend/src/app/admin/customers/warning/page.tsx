'use client';

import { useRouter } from 'next/navigation';

import {
  Badge,
  PageHeader,
  Table,
  type Column,
} from '@/components/ui';
import { useList } from '@/hooks';
import { ADMIN } from '@/lib/api';
import { formatDate } from '@/lib/datetime';
import { formatCompactCurrency } from '@/lib/format';
import type { CustomerListItem, Page } from '@/types';

/**
 * BR-302 — **màn hình tác nghiệp chính của đội môi giới**.
 *
 * Vòng cảnh báo 7 ngày vừa là nghĩa vụ với KH đã trả tiền, vừa là cơ hội bán hàng:
 * đây chính là lúc môi giới gọi điện để KH nạp thêm tiền hoặc giao dịch trở lại.
 * Danh sách sắp xếp theo số ngày còn lại tăng dần — ai sắp bị khoá thì gọi trước.
 */
export default function WarningCustomersPage() {
  const router = useRouter();
  const list = useList<CustomerListItem>(
    `${ADMIN}/customers/warning-list`,
    {},
    { initialSize: 30, swr: { refreshInterval: 300_000 } },
  );

  const columns: Column<CustomerListItem>[] = [
    {
      key: 'days',
      header: 'Còn lại',
      render: (row) => {
        const days = row.days_until_suspend;
        const urgent = days !== null && days !== undefined && days <= 2;
        return (
          <Badge tone={urgent ? 'red' : 'amber'}>
            {days === null || days === undefined ? '—' : `${days} ngày`}
          </Badge>
        );
      },
    },
    {
      key: 'customer',
      header: 'Khách hàng',
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-ink-900">{row.full_name}</p>
          <p className="text-xs text-ink-500">{row.customer_code ?? row.email}</p>
        </div>
      ),
    },
    {
      key: 'phone',
      header: 'Liên hệ',
      render: (row) =>
        row.phone ? (
          <a href={`tel:${row.phone}`} className="text-ink-900 hover:underline">
            {row.phone}
          </a>
        ) : (
          '—'
        ),
    },
    {
      key: 'nav',
      header: 'NAV hiện tại',
      align: 'right',
      render: (row) => (
        <span className="tabular-nums font-medium text-red-600">
          {formatCompactCurrency(row.latest_nav)}
        </span>
      ),
    },
    {
      key: 'last_trade',
      header: 'GD gần nhất',
      render: (row) => formatDate(row.last_trade_date),
      hideOnMobile: true,
    },
    {
      key: 'package',
      header: 'Gói',
      render: (row) => (
        <div>
          <p>{row.package_name ?? '—'}</p>
          <p className="text-xs text-ink-400">Hết hạn {formatDate(row.expires_at)}</p>
        </div>
      ),
      hideOnMobile: true,
    },
    {
      key: 'broker',
      header: 'Môi giới',
      render: (row) => row.broker_name ?? '—',
      hideOnMobile: true,
    },
  ];

  return (
    <div className="flex h-full flex-col space-y-3">
      <PageHeader
        title="Khách hàng đang cảnh báo"
        description="Danh sách cần liên hệ trước khi tài khoản bị tạm dừng"
        infoTitle="Đây là danh sách ưu tiên gọi điện"
        info={
          <>
            <p>
              Những khách hàng này đã trả tiền nhưng chưa đạt điều kiện duy trì. Liên hệ để họ nạp
              thêm tiền hoặc giao dịch trở lại — tài khoản sẽ tự khôi phục ngay khi đủ điều kiện,
              không cần thao tác thủ công. Ưu tiên gọi những người còn ít ngày nhất.
            </p>
            <p>
              <strong>Lưu ý khi trao đổi:</strong> trong thời gian tạm dừng, thời hạn gói được đóng
              băng và bù đủ khi khôi phục — khách hàng không mất ngày sử dụng nào. Nêu rõ điều này
              giúp giảm đáng kể khiếu nại.
            </p>
          </>
        }
      />

      <Table
        {...list.tableProps}
        columns={columns}
        rowKey={(row) => row.id}
        onRowClick={(row) => router.push(`/admin/customers/${row.id}`)}
        emptyMessage="Không có khách hàng nào đang trong trạng thái cảnh báo"
        fill
        minWidth="62rem"
        mobileCard={(row: CustomerListItem) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium text-ink-900">{row.full_name}</p>
                {row.phone && (
                  <a href={`tel:${row.phone}`} className="text-sm text-ink-900">
                    {row.phone}
                  </a>
                )}
              </div>
              <Badge
                tone={
                  row.days_until_suspend !== null &&
                  row.days_until_suspend !== undefined &&
                  row.days_until_suspend <= 2
                    ? 'red'
                    : 'amber'
                }
              >
                Còn {row.days_until_suspend ?? '—'} ngày
              </Badge>
            </div>
            <p className="text-sm text-ink-600">
              NAV: <span className="font-medium text-red-600">
                {formatCompactCurrency(row.latest_nav)}
              </span>{' '}
              · GD gần nhất: {formatDate(row.last_trade_date)}
            </p>
          </div>
        )}
      />
    </div>
  );
}
