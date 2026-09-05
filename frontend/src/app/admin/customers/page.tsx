'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { CreateCustomerModal } from '@/components/domain/CreateCustomerModal';

import {
  Badge,
  Button,
  Card,
  Checkbox,
  Icon,
  Modal,
  PageHeader,
  RowAction,
  SearchInput,
  Select,
  Spinner,
  StatusBadge,
  Table,
  type Column,
} from '@/components/ui';
import { useList, useStaffSession } from '@/hooks';
import { ADMIN, API_PREFIX } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/datetime';
import { formatCompactCurrency } from '@/lib/format';
import { COMPLIANCE_STATUS, CUSTOMER_TYPE, SUBSCRIPTION_STATUS, statusOptions } from '@/lib/status';
import type { CustomerListItem, Page } from '@/types';

const SUBSCRIPTION_OPTIONS = statusOptions(SUBSCRIPTION_STATUS);
const COMPLIANCE_OPTIONS = statusOptions(COMPLIANCE_STATUS);
const CUSTOMER_TYPE_OPTIONS = statusOptions(CUSTOMER_TYPE);

/** Các tiêu chí lọc ít dùng — nằm trong hộp thoại "Lọc nâng cao". */
type AdvancedFilters = {
  complianceStatus: string;
  customerType: string;
  expiringInDays: string;
  neverLoggedIn: boolean;
};

const EMPTY_ADVANCED: AdvancedFilters = {
  complianceStatus: '',
  customerType: '',
  expiringInDays: '',
  neverLoggedIn: false,
};

function CustomerList() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useStaffSession();

  const [search, setSearch] = useState('');
  const [subscriptionStatus, setSubscriptionStatus] = useState('');

  // `advanced` là bộ lọc đang áp dụng; `draft` là bản đang chỉnh trong hộp thoại. Tách hai bản
  // để mỗi lần đổi ô trong hộp thoại không bắn một lượt gọi API — chỉ bấm Áp dụng mới lọc.
  const [advanced, setAdvanced] = useState<AdvancedFilters>({
    ...EMPTY_ADVANCED,
    expiringInDays: searchParams.get('expiring_in_days') ?? '',
  });
  const [draft, setDraft] = useState<AdvancedFilters>(advanced);
  const [filterOpen, setFilterOpen] = useState(false);

  const [creating, setCreating] = useState(false);

  const list = useList<CustomerListItem>(`${ADMIN}/customers`, {
    q: search || undefined,
    subscription_status: subscriptionStatus || undefined,
    compliance_status: advanced.complianceStatus || undefined,
    customer_type: advanced.customerType || undefined,
    expiring_in_days: advanced.expiringInDays || undefined,
    never_logged_in: advanced.neverLoggedIn || undefined,
  });
  const { reset, refresh } = list;

  const activeChips: Array<{ key: keyof AdvancedFilters; label: string; cleared: string | boolean }> =
    [
      advanced.complianceStatus && {
        key: 'complianceStatus' as const,
        label: `Điều kiện: ${COMPLIANCE_STATUS[advanced.complianceStatus]?.label ?? advanced.complianceStatus}`,
        cleared: '',
      },
      advanced.customerType && {
        key: 'customerType' as const,
        label: `Nhóm: ${CUSTOMER_TYPE[advanced.customerType]?.label ?? advanced.customerType}`,
        cleared: '',
      },
      advanced.expiringInDays && {
        key: 'expiringInDays' as const,
        label: `Hết hạn trong ${advanced.expiringInDays} ngày`,
        cleared: '',
      },
      advanced.neverLoggedIn && {
        key: 'neverLoggedIn' as const,
        label: 'Chưa từng đăng nhập',
        cleared: false,
      },
    ].filter(Boolean) as Array<{
      key: keyof AdvancedFilters;
      label: string;
      cleared: string | boolean;
    }>;

  const activeAdvancedCount = activeChips.length;

  const columns: Column<CustomerListItem>[] = [
    {
      key: 'customer',
      header: 'Khách hàng',
      width: '15rem',
      // Ghim cột định danh vào mép trái — cuộn ngang vẫn biết đang xem hàng của ai.
      sticky: 'left',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink-900">{row.full_name}</p>
          <p className="truncate text-xs text-ink-500">{row.email}</p>
          {row.customer_code && <p className="text-xs text-ink-400">{row.customer_code}</p>}
        </div>
      ),
    },
    { key: 'phone', header: 'SĐT', render: (row) => row.phone ?? '—', hideOnMobile: true },
    {
      key: 'account_no',
      header: 'Số TKCK',
      render: (row) => row.securities_account_no ?? '—',
      hideOnMobile: true,
    },
    {
      key: 'type',
      header: 'Nhóm',
      render: (row) => <StatusBadge map={CUSTOMER_TYPE} code={row.customer_type} />,
      hideOnMobile: true,
    },
    { key: 'package', header: 'Gói', width: '15rem', render: (row) => row.package_name ?? '—' },
    {
      key: 'expires',
      header: 'Hết hạn',
      render: (row) => formatDate(row.expires_at),
      hideOnMobile: true,
    },
    {
      key: 'nav',
      header: 'NAV',
      align: 'right',
      width: '8rem',
      render: (row) => (
        <div>
          <p className="tabular-nums">{formatCompactCurrency(row.latest_nav)}</p>
          {row.latest_nav_date && (
            <p className="text-xs text-ink-400">{formatDate(row.latest_nav_date)}</p>
          )}
        </div>
      ),
      hideOnMobile: true,
    },
    {
      key: 'last_trade',
      header: 'GD gần nhất',
      render: (row) => formatDate(row.last_trade_date),
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Trạng thái',
      width: '11rem',
      render: (row) => (
        // Hai trục hiển thị riêng — đúng nguyên tắc mục 0.2, để phân biệt "hết hạn gói"
        // với "khoá do NAV", hai kịch bản chăm sóc hoàn toàn khác nhau.
        <div className="flex flex-col gap-1">
          <StatusBadge map={SUBSCRIPTION_STATUS} code={row.subscription_status} />
          <StatusBadge map={COMPLIANCE_STATUS} code={row.compliance_status} />
          {row.compliance_exempt && <Badge tone="purple">Miễn áp dụng</Badge>}
        </div>
      ),
    },
    {
      key: 'last_login',
      header: 'Đăng nhập cuối',
      render: (row) =>
        row.last_login_at ? (
          formatDateTime(row.last_login_at)
        ) : (
          <span className="text-amber-600">Chưa từng</span>
        ),
      hideOnMobile: true,
    },
    {
      key: 'action',
      header: 'Hành động',
      width: '7rem',
      align: 'right',
      // Cột hành động ghim mép phải — nút thao tác luôn nhìn thấy dù bảng rộng bao nhiêu.
      sticky: 'right',
      render: (row) => (
        <div className="flex justify-center gap-0.5">
          <RowAction
            label="Xem chi tiết khách hàng"
            icon={<Icon name="eye" size={16} />}
            onClick={() => router.push(`/admin/customers/${row.id}`)}
          />
        </div>
      ),
    },
  ];

  const exportUrl = `${API_PREFIX}${ADMIN}/customers/export${advanced.expiringInDays ? `?expiring_in_days=${advanced.expiringInDays}` : ''
    }`;

  return (
    <div className="flex h-full flex-col space-y-3">
      <PageHeader
        title="Quản lý khách hàng"
        description="Tra cứu, lọc và thao tác trên hồ sơ khách hàng"
        action={
          <div className="flex flex-wrap gap-2">
            {can('customer.export') && (
              <a href={exportUrl}>
                <Button variant="outline" size="sm" leftIcon={<Icon name="download" size={15} />}>
                  Xuất CSV
                </Button>
              </a>
            )}
            {/* YC7 — chỉ Quản trị tối cao và Chăm sóc khách hàng thấy nút này. */}
            {can('customer.create') && (
              <Button
                size="sm"
                leftIcon={<Icon name="plus" size={15} />}
                onClick={() => setCreating(true)}
              >
                Tạo tài khoản
              </Button>
            )}
          </div>
        }
      />

      {/*
        Hai bộ lọc dùng hằng ngày để ngoài; phần còn lại gom vào hộp thoại "Lọc nâng cao".
        Bày sáu ô lọc thường trực làm loãng thao tác chính là tra cứu, mà đa số lượt dùng chỉ cần
        gõ tên rồi xem. Hộp thoại có nút Áp dụng riêng nên chỉnh nhiều tiêu chí chỉ gọi API một lần.
      */}
      <div>
        {/*
          Bốn thành phần trên **một dòng**: ô tìm kiếm co giãn, ô trạng thái cố định 14rem, hai nút
          rộng theo nội dung. `items-end` để đáy hai nút thẳng hàng với đáy hai ô nhập — nút không
          có nhãn phía trên nên căn theo giữa sẽ bị lệch lên.
          Dưới `sm` vẫn xếp dọc: bốn thứ này không đặt vừa một dòng trên điện thoại.
        */}
        <div className="shrink-0 grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem_auto_auto] sm:items-end">
          <SearchInput
            placeholder="Email, tên, SĐT, số TKCK…"
            value={search}
            onSearch={(value) => {
              setSearch(value);
              reset();
            }}
          />
          <Select
            value={subscriptionStatus}
            onChange={(e) => {
              setSubscriptionStatus(e.target.value);
              reset();
            }}
            placeholder="Tất cả"
            options={SUBSCRIPTION_OPTIONS}
          />
          <Button
            variant={activeAdvancedCount ? 'primary' : 'outline'}
            leftIcon={<Icon name="filter" size={15} />}
            onClick={() => {
              setDraft(advanced);
              setFilterOpen(true);
            }}
          >
            Lọc nâng cao
            {activeAdvancedCount > 0 && ` (${activeAdvancedCount})`}
          </Button>
          <Link href="/admin/customers/warning" className="w-full sm:w-auto">
            <Button variant="outline" fullWidth leftIcon={<Icon name="warning" size={15} />}>
              Đang cảnh báo NAV
            </Button>
          </Link>
        </div>

        {/* Điều kiện nâng cao đang bật hiện thành thẻ gỡ được — bộ lọc giấu trong hộp thoại mà
            không báo ra ngoài là nguyên nhân kinh điển của “sao danh sách thiếu khách hàng”. */}
        {activeAdvancedCount > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {activeChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 py-1 pl-3 pr-1.5 text-xs text-ink-700"
              >
                {chip.label}
                <button
                  type="button"
                  aria-label={`Bỏ lọc ${chip.label}`}
                  className="rounded-full p-0.5 text-ink-500 transition-colors hover:bg-ink-200 hover:text-ink-900"
                  onClick={() => {
                    setAdvanced({ ...advanced, [chip.key]: chip.cleared });
                    reset();
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
            <button
              type="button"
              className="text-xs font-medium text-ink-500 underline underline-offset-2 hover:text-ink-900"
              onClick={() => {
                setAdvanced(EMPTY_ADVANCED);
                reset();
              }}
            >
              Xoá tất cả
            </button>
          </div>
        )}
      </div>

      <Modal
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        title="Lọc nâng cao"
        description="Chọn xong bấm Áp dụng để lọc danh sách."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(EMPTY_ADVANCED)}>
              Xoá bộ lọc
            </Button>
            <Button variant="outline" onClick={() => setFilterOpen(false)}>
              Huỷ
            </Button>
            <Button
              onClick={() => {
                setAdvanced(draft);
                setFilterOpen(false);
                reset();
              }}
            >
              Áp dụng
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Select
            label="Điều kiện duy trì"
            value={draft.complianceStatus}
            onChange={(e) => setDraft({ ...draft, complianceStatus: e.target.value })}
            placeholder="Tất cả"
            options={COMPLIANCE_OPTIONS}
          />
          <Select
            label="Nhóm khách hàng"
            value={draft.customerType}
            onChange={(e) => setDraft({ ...draft, customerType: e.target.value })}
            placeholder="Tất cả nhóm"
            options={CUSTOMER_TYPE_OPTIONS}
          />
          <Select
            label="Sắp hết hạn"
            value={draft.expiringInDays}
            onChange={(e) => setDraft({ ...draft, expiringInDays: e.target.value })}
            placeholder="Không lọc"
            options={[
              { value: '7', label: 'Trong 7 ngày' },
              { value: '15', label: 'Trong 15 ngày' },
              { value: '30', label: 'Trong 30 ngày' },
            ]}
          />
          <Checkbox
            checked={draft.neverLoggedIn}
            onChange={(e) => setDraft({ ...draft, neverLoggedIn: e.target.checked })}
            label={
              <span>
                Chưa từng đăng nhập
                <span className="block text-xs text-ink-500">
                  Tài khoản đã cấp nhưng khách hàng chưa vào lần nào — nhóm cần chăm sóc trước.
                </span>
              </span>
            }
          />
        </div>
      </Modal>

      <Table
        {...list.tableProps}
        columns={columns}
        rowKey={(row) => row.id}
        onRowClick={(row) => router.push(`/admin/customers/${row.id}`)}
        emptyMessage="Không tìm thấy khách hàng nào khớp bộ lọc"
        fill
        minWidth="78rem"
        mobileCard={(row) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium text-ink-900">{row.full_name}</p>
                <p className="text-xs text-ink-500">{row.email}</p>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <StatusBadge map={SUBSCRIPTION_STATUS} code={row.subscription_status} />
                <StatusBadge map={COMPLIANCE_STATUS} code={row.compliance_status} />
              </div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
              <span>{row.package_name ?? 'Chưa có gói'}</span>
              <span>Hết hạn {formatDate(row.expires_at)}</span>
              <span>NAV {formatCompactCurrency(row.latest_nav)}</span>
            </div>
          </div>
        )}
      />

      {creating && (
        <CreateCustomerModal onClose={() => setCreating(false)} onCreated={refresh} />
      )}
    </div>
  );
}

export default function CustomersPage() {
  return (
    <Suspense fallback={<Spinner label="Đang tải…" />}>
      <CustomerList />
    </Suspense>
  );
}
