'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Modal,
  PageHeader,
  Pagination,
  Select,
  Spinner,
  StatusBadge,
  TabPanel,
  Tabs,
  Textarea,
} from '@/components/ui';
import { useApiMutation, useApiQuery, usePagination, useStaffSession, useToast } from '@/hooks';
import { ADMIN, PUBLIC, api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/datetime';
import { formatCompactCurrency, formatCurrency } from '@/lib/format';
import {
  COMPLIANCE_STATUS,
  CUSTOMER_TYPE,
  IB_LINK_STATUS,
  PAYMENT_STATUS,
  SUBSCRIPTION_STATUS,
} from '@/lib/status';
import type { Message, NavPoint, Package, Page } from '@/types';

const TABS = [
  { key: 'profile', label: 'Thông tin & gói' },
  { key: 'subscriptions', label: 'Lịch sử gói' },
  { key: 'nav', label: 'Biểu đồ NAV' },
  { key: 'logins', label: 'Lịch sử đăng nhập' },
  { key: 'activity', label: 'Hoạt động' },
  { key: 'compliance', label: 'Nhật ký trạng thái' },
  { key: 'notes', label: 'Ghi chú chăm sóc' },
];

type Action = 'grant' | 'suspend' | 'unsuspend' | 'close' | 'reopen' | 'exempt' | 'reset' | null;

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const userId = Number(params.id);
  const toast = useToast();
  const { can, isSuperAdmin } = useStaffSession();

  const [tab, setTab] = useState('profile');
  const [action, setAction] = useState<Action>(null);

  const { data, isLoading, refresh } = useApiQuery<any>(`${ADMIN}/customers/${userId}`);

  if (isLoading) {
    return (
      <div className="py-20">
        <Spinner label="Đang tải hồ sơ…" />
      </div>
    );
  }

  if (!data) return <EmptyState title="Không tìm thấy khách hàng" />;

  const { customer, subscription, compliance, ib } = data;

  return (
    <div className="flex h-full flex-col space-y-3">
      <PageHeader
        breadcrumb={
          <Link href="/admin/customers" className="hover:text-ink-700">
            ← Danh sách khách hàng
          </Link>
        }
        title={customer.full_name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {customer.email}
            {customer.customer_code && <Badge tone="gray">{customer.customer_code}</Badge>}
            <StatusBadge map={CUSTOMER_TYPE} code={customer.customer_type} />
          </span>
        }
        action={
          <div className="flex flex-wrap gap-2">
            {can('customer.extend') && (
              <Button size="sm" onClick={() => setAction('grant')}>
                Cấp / gia hạn gói
              </Button>
            )}
            {can('customer.suspend') &&
              (customer.compliance_status === 'SUSPENDED' ? (
                <Button size="sm" variant="outline" onClick={() => setAction('unsuspend')}>
                  Mở khoá
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setAction('suspend')}>
                  Tạm khoá
                </Button>
              ))}
            {can('customer.exempt') && (
              <Button size="sm" variant="outline" onClick={() => setAction('exempt')}>
                {customer.compliance_exempt ? 'Bỏ miễn áp dụng' : 'Miễn điều kiện IB'}
              </Button>
            )}
            {can('customer.reset_password') && (
              <Button size="sm" variant="ghost" onClick={() => setAction('reset')}>
                Gửi mã đặt lại mật khẩu
              </Button>
            )}
            {isSuperAdmin &&
              (customer.compliance_status === 'CLOSED' ? (
                <Button size="sm" variant="outline" onClick={() => setAction('reopen')}>
                  Mở lại tài khoản
                </Button>
              ) : (
                <Button size="sm" variant="danger" onClick={() => setAction('close')}>
                  Đóng vĩnh viễn
                </Button>
              ))}
          </div>
        }
      />

      {/* Hai trục trạng thái hiển thị riêng — mục 0.2. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <p className="text-xs text-ink-500">Trạng thái gói</p>
          <div className="mt-1.5">
            <StatusBadge map={SUBSCRIPTION_STATUS} code={customer.subscription_status} />
          </div>
          {subscription?.is_frozen && (
            <p className="mt-1 text-xs text-amber-600">Đồng hồ đang đóng băng</p>
          )}
        </Card>
        <Card>
          <p className="text-xs text-ink-500">Điều kiện duy trì</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <StatusBadge map={COMPLIANCE_STATUS} code={customer.compliance_status} />
            {customer.compliance_exempt && <Badge tone="purple">Miễn áp dụng</Badge>}
          </div>
          {!compliance.applicable && (
            <p className="mt-1 text-xs text-ink-500">Không áp dụng với KH này</p>
          )}
        </Card>
        <Card>
          <p className="text-xs text-ink-500">NAV trung bình</p>
          <p className="mt-1.5 text-lg font-semibold tabular-nums">
            {compliance.has_nav_data ? formatCompactCurrency(compliance.nav_avg) : '—'}
          </p>
          <p className="text-xs text-ink-500">
            {compliance.has_nav_data
              ? `${compliance.nav_sessions} phiên`
              : 'Chưa có dữ liệu đồng bộ'}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-ink-500">Ngày hết hạn</p>
          <p className="mt-1.5 text-lg font-semibold">{formatDate(subscription?.expires_at)}</p>
          {subscription?.frozen_days > 0 && (
            <p className="text-xs text-ink-500">Đã bù {subscription.frozen_days} ngày</p>
          )}
        </Card>
      </div>

      {/* BR-301 — nhắc rõ khi thiếu dữ liệu, để nhân viên không hiểu nhầm là KH vi phạm. */}
      {compliance.applicable && !compliance.has_nav_data && (
        <Alert tone="info" title="Chưa có dữ liệu NAV">
          Hệ thống chưa nhận được dữ liệu NAV của tài khoản này. Job compliance{' '}
          <strong>không thay đổi trạng thái</strong> khi thiếu dữ liệu. Kiểm tra lại email trong
          Google Sheet nguồn.
        </Alert>
      )}

      {customer.compliance_status === 'SUSPENDED' && compliance.suspended_reason && (
        <Alert tone="danger" title={`Tạm khoá từ ${formatDate(compliance.suspended_at)}`}>
          {compliance.suspended_reason}
        </Alert>
      )}

      <Tabs items={TABS} active={tab} onChange={setTab} />

      <TabPanel active={tab} tabKey="profile" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Thông tin cá nhân" />
            <dl className="divide-y divide-ink-100 text-sm">
              <Row label="Họ tên" value={customer.full_name} />
              <Row label="Email" value={customer.email} />
              <Row label="Số điện thoại" value={customer.phone ?? '—'} />
              <Row label="Mã khách hàng" value={customer.customer_code ?? '—'} />
              <Row label="Ngày đăng ký" value={formatDate(customer.created_at)} />
              <Row label="Đăng nhập lần cuối" value={formatDateTime(customer.last_login_at)} />
            </dl>
          </Card>

          <Card>
            <CardHeader title="Tài khoản chứng khoán & IB" />
            <dl className="divide-y divide-ink-100 text-sm">
              <Row label="Số tài khoản" value={ib.account_no ?? 'Chưa liên kết'} />
              <Row
                label="Trạng thái liên kết"
                value={<StatusBadge map={IB_LINK_STATUS} code={ib.link_status} />}
              />
              <Row label="Hạn hoàn tất" value={formatDate(ib.deadline)} />
              <Row label="Môi giới phụ trách" value={ib.broker_name ?? '—'} />
              <Row label="SĐT môi giới" value={ib.broker_phone ?? '—'} />
            </dl>
            {ib.link_status === 'PENDING_LINK' && can('customer.extend') && (
              <Alert tone="warning" className="mt-3">
                Khách hàng đã khai số tài khoản nhưng hệ thống chưa đối chiếu được. Nếu đã xác minh
                thủ công, dùng nút “Duyệt liên kết” bên dưới.
              </Alert>
            )}
          </Card>

          <Card>
            <CardHeader title="Gói dịch vụ hiện tại" />
            <dl className="divide-y divide-ink-100 text-sm">
              <Row label="Gói" value={subscription?.package_name ?? '—'} />
              <Row label="Bắt đầu" value={formatDate(subscription?.starts_at)} />
              <Row label="Hết hạn" value={formatDate(subscription?.expires_at)} />
              <Row
                label="Thanh toán"
                value={<StatusBadge map={PAYMENT_STATUS} code={subscription?.payment_status} />}
              />
              <Row
                label="Ngày đã bù do đóng băng"
                value={subscription?.frozen_days ? `${subscription.frozen_days} ngày` : '0'}
              />
            </dl>
          </Card>

          <Card>
            <CardHeader title="Compliance" />
            <dl className="divide-y divide-ink-100 text-sm">
              <Row label="Áp dụng điều kiện" value={compliance.applicable ? 'Có' : 'Không'} />
              <Row label="Miễn áp dụng" value={compliance.exempt ? 'Có' : 'Không'} />
              {compliance.exempt_reason && (
                <Row label="Lý do miễn" value={compliance.exempt_reason} />
              )}
              <Row label="Cảnh báo tới" value={formatDate(compliance.warning_until)} />
              <Row label="Tạm khoá từ" value={formatDate(compliance.suspended_at)} />
            </dl>
          </Card>
        </div>
      </TabPanel>

      <TabPanel active={tab} tabKey="subscriptions" className="flex min-h-0 flex-1 flex-col">
        <SubscriptionHistory userId={userId} />
      </TabPanel>

      <TabPanel active={tab} tabKey="nav" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <NavHistory userId={userId} />
      </TabPanel>

      <TabPanel active={tab} tabKey="logins" className="flex min-h-0 flex-1 flex-col">
        <LoginHistory userId={userId} />
      </TabPanel>

      <TabPanel active={tab} tabKey="activity" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ActivityHistory userId={userId} />
      </TabPanel>

      <TabPanel active={tab} tabKey="compliance" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ComplianceEvents userId={userId} />
      </TabPanel>

      <TabPanel active={tab} tabKey="notes" className="flex min-h-0 flex-1 flex-col">
        <CustomerNotes userId={userId} canWrite={can('customer.note')} />
      </TabPanel>

      <ActionDialogs
        action={action}
        userId={userId}
        customer={customer}
        onClose={() => setAction(null)}
        onDone={(message) => {
          toast.success(message);
          setAction(null);
          refresh();
        }}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-right font-medium text-ink-900">{value}</dd>
    </div>
  );
}

/** Hộp thoại cho từng hành động — tất cả đều bắt buộc nhập lý do (mục 3.4, 3.6). */
function ActionDialogs({
  action,
  userId,
  customer,
  onClose,
  onDone,
}: {
  action: Action;
  userId: number;
  customer: any;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [packageId, setPackageId] = useState('');
  const [reason, setReason] = useState('');
  // Bảng giá công khai — không cần quyền riêng, và luôn khớp với gói đang bán.
  const { data: packages } = useApiQuery<Package[]>(action === 'grant' ? `${PUBLIC}/packages` : null);

  const call = useApiMutation<Message, { path: string; body: unknown }>(({ path, body }) =>
    api.post<Message>(path, body),
  );

  if (action === 'grant') {
    return (
      <Modal
        open
        onClose={onClose}
        title="Cấp / gia hạn gói thủ công"
        description="Thao tác này được ghi vào nhật ký hệ thống."
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button
              loading={call.loading}
              disabled={!packageId || reason.trim().length < 3}
              onClick={async () => {
                const result = await call.mutate({
                  path: `${ADMIN}/customers/${userId}/grant-package`,
                  body: { package_id: Number(packageId), reason: reason.trim() },
                });
                if (result) onDone(result.message);
              }}
            >
              Cấp gói
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {call.error && <Alert tone="danger">{call.error.message}</Alert>}
          <Select
            label="Gói dịch vụ"
            required
            value={packageId}
            onChange={(e) => setPackageId(e.target.value)}
            placeholder="— Chọn gói —"
            options={(packages ?? []).map((p) => ({
              value: p.id,
              label: `${p.name} — ${formatCurrency(p.price)}`,
            }))}
          />
          {/* BR-131 — nêu rõ hành vi cộng dồn để nhân viên không cấp nhầm. */}
          <Alert tone="info">
            Nếu gói hiện tại chưa hết hạn, thời gian mới sẽ được <strong>cộng dồn</strong> vào ngày
            hết hạn hiện tại ({formatDate(customer.expires_at)}), không ghi đè.
          </Alert>
          <Textarea
            label="Lý do"
            required
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            hint="Bắt buộc — sẽ được ghi vào nhật ký hệ thống kèm tên người thực hiện."
            placeholder="Ví dụ: Khách hàng đã chuyển khoản, đối soát ngày 01/08, mã GD …"
          />
        </div>
      </Modal>
    );
  }

  const configs: Record<
    Exclude<Action, null | 'grant'>,
    { title: string; message: string; path: string; danger?: boolean; confirmLabel: string }
  > = {
    suspend: {
      title: 'Tạm khoá tài khoản',
      message:
        'Khách hàng sẽ không đăng nhập được. Thời hạn gói sẽ được đóng băng và bù đủ khi mở khoá.',
      path: `${ADMIN}/customers/${userId}/suspend`,
      danger: true,
      confirmLabel: 'Tạm khoá',
    },
    unsuspend: {
      title: 'Mở khoá tài khoản',
      message:
        'Tài khoản được khôi phục và số ngày bị đóng băng sẽ được cộng bù vào ngày hết hạn.',
      path: `${ADMIN}/customers/${userId}/unsuspend`,
      confirmLabel: 'Mở khoá',
    },
    close: {
      title: 'Đóng vĩnh viễn tài khoản',
      message:
        'Đây là thao tác nghiêm trọng. Tài khoản sẽ không tự khôi phục được và chỉ Quản trị tối cao mới mở lại được.',
      path: `${ADMIN}/customers/${userId}/close`,
      danger: true,
      confirmLabel: 'Đóng vĩnh viễn',
    },
    reopen: {
      title: 'Mở lại tài khoản',
      message: 'Tài khoản sẽ trở lại trạng thái bình thường.',
      path: `${ADMIN}/customers/${userId}/reopen`,
      confirmLabel: 'Mở lại',
    },
    exempt: {
      title: customer.compliance_exempt ? 'Bỏ miễn điều kiện IB' : 'Miễn áp điều kiện IB',
      message: customer.compliance_exempt
        ? 'Khách hàng sẽ áp dụng lại điều kiện NAV và giao dịch từ lần chạy job tiếp theo.'
        : 'Khách hàng sẽ không bị áp điều kiện NAV và giao dịch. Dùng cho KH VIP hoặc trường hợp đặc biệt.',
      path: `${ADMIN}/customers/${userId}/exempt`,
      confirmLabel: 'Xác nhận',
    },
    reset: {
      title: 'Gửi mã đặt lại mật khẩu',
      message:
        'Hệ thống gửi mã về email của khách hàng. Quản trị viên không xem được và không đặt được mật khẩu thay khách hàng.',
      path: `${ADMIN}/customers/${userId}/reset-password`,
      confirmLabel: 'Gửi mã',
    },
  };

  if (!action) return null;
  const config = configs[action];

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={config.title}
      message={config.message}
      confirmLabel={config.confirmLabel}
      danger={config.danger}
      loading={call.loading}
      requireReason={action !== 'reset'}
      onConfirm={async (enteredReason) => {
        const body =
          action === 'exempt'
            ? { exempt: !customer.compliance_exempt, reason: enteredReason }
            : action === 'reset'
              ? {}
              : { reason: enteredReason };
        const result = await call.mutate({ path: config.path, body });
        if (result) onDone(result.message);
      }}
    />
  );
}

function SubscriptionHistory({ userId }: { userId: number }) {
  const toast = useToast();
  const { can } = useStaffSession();
  const { page, size, setPage, setSize } = usePagination(20);
  const { data, refresh } = useApiQuery<Page<any>>(
    `${ADMIN}/customers/${userId}/subscriptions`,
    { page, size },
  );
  const [deciding, setDeciding] = useState<any>(null);

  if (!data?.items.length) return <EmptyState title="Chưa có giao dịch nào" />;

  const pendingCount = data.items.filter((r: any) => r.payment_status === 'PENDING').length;

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-3">
      {/* Đơn khách tự tạo nằm ở PENDING cho tới khi có người đối chiếu sao kê — nói rõ ra để
          không ai tưởng khách đã có gói. */}
      {pendingCount > 0 && (
        <Alert tone="warning" title={`${pendingCount} đơn hàng đang chờ xác nhận thanh toán`}>
          Khách hàng đã tạo đơn và chuyển khoản theo hướng dẫn. Đối chiếu sao kê ngân hàng theo nội
          dung chuyển khoản, rồi bấm <strong>Xác nhận</strong> để kích hoạt gói. Trước khi xác nhận,
          khách <strong>chưa</strong> được cấp quyền sử dụng.
        </Alert>
      )}

    <Card padded={false} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 bg-ink-50">
            <tr>
              {['Gói', 'Bắt đầu', 'Hết hạn', 'Số tiền', 'Thanh toán', 'Ngày bù', 'Nguồn', 'Ghi chú', 'Hành động'].map(
                (h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2.5 text-left font-medium text-ink-600">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {data.items.map((row) => (
              <tr key={row.id}>
                <td className="px-3 py-2.5 font-medium">{row.package_name}</td>
                <td className="whitespace-nowrap px-3 py-2.5">{formatDate(row.starts_at)}</td>
                <td className="whitespace-nowrap px-3 py-2.5">{formatDate(row.expires_at)}</td>
                <td className="px-3 py-2.5 tabular-nums">{formatCurrency(row.amount)}</td>
                <td className="px-3 py-2.5">
                  <StatusBadge map={PAYMENT_STATUS} code={row.payment_status} />
                </td>
                <td className="px-3 py-2.5 tabular-nums">
                  {row.frozen_days ? `+${row.frozen_days}` : '—'}
                </td>
                <td className="px-3 py-2.5 text-xs text-ink-500">
                  {row.created_by_type === 'staff' ? 'Nhân viên cấp' : 'Khách tự mua'}
                </td>
                <td className="px-3 py-2.5 text-xs text-ink-500">{row.note ?? '—'}</td>
                <td className="px-3 py-2.5 text-right">
                  {row.payment_status === 'PENDING' && can('customer.extend') ? (
                    <Button size="sm" onClick={() => setDeciding(row)}>
                      Đối soát
                    </Button>
                  ) : (
                    <span className="text-xs text-ink-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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

      {deciding && (
        <PaymentDecisionModal
          userId={userId}
          subscription={deciding}
          onClose={() => setDeciding(null)}
          onDone={(message) => {
            toast.success(message);
            setDeciding(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Đối soát một đơn hàng khách tự tạo.
 *
 * Xác nhận là hành động **cấp quyền sử dụng có trả tiền** nên bắt buộc ghi nhật ký kèm lý do và
 * không có nút hoàn tác — bắt nhập ghi chú đối soát để sau này còn truy được ai xác nhận theo
 * chứng từ nào.
 */
function PaymentDecisionModal({
  userId,
  subscription,
  onClose,
  onDone,
}: {
  userId: number;
  subscription: any;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [status, setStatus] = useState('PAID');
  const [note, setNote] = useState('');

  const submit = useApiMutation<Message, { status: string; note: string | null }>((body) =>
    api.post<Message>(
      `${ADMIN}/customers/${userId}/subscriptions/${subscription.id}/payment`,
      body,
    ),
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={`Đối soát đơn: ${subscription.package_name}`}
      description={`Số tiền ${formatCurrency(subscription.amount)}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={submit.loading}
            disabled={note.trim().length < 3}
            onClick={async () => {
              const result = await submit.mutate({ status, note: note.trim() || null });
              if (result) onDone(result.message);
            }}
          >
            {status === 'PAID' ? 'Xác nhận đã nhận tiền' : 'Cập nhật trạng thái'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {submit.error && <Alert tone="danger">{submit.error.message}</Alert>}

        <Select
          label="Kết quả đối soát"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: 'PAID', label: 'Đã nhận tiền — kích hoạt gói' },
            { value: 'FAILED', label: 'Không nhận được tiền' },
            { value: 'CANCELLED', label: 'Khách huỷ đơn' },
            { value: 'REFUNDED', label: 'Đã hoàn tiền' },
          ]}
        />

        {status === 'PAID' ? (
          <Alert tone="info">
            Hạn dùng được tính lại từ <strong>thời điểm xác nhận</strong>, không phải lúc khách đặt
            đơn — khách không mất những ngày chờ đối soát. Nếu đang còn gói hiệu lực thì thời gian
            mới cộng dồn vào ngày hết hạn hiện tại (BR-131).
          </Alert>
        ) : (
          <Alert tone="warning">
            Đơn sẽ được đánh dấu không thành công. Trạng thái tài khoản khách hàng{' '}
            <strong>không đổi</strong> vì đơn này chưa từng cấp quyền gì. Bản ghi vẫn được giữ để
            đối soát.
          </Alert>
        )}

        <Textarea
          label="Ghi chú đối soát"
          placeholder="Ghi lại căn cứ đối soát để người sau tra lại được"
          required
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          hint="Ví dụ: đã khớp sao kê VCB ngày 05/08, nội dung SUB2608051230013."
        />
      </div>
    </Modal>
  );
}

function NavHistory({ userId }: { userId: number }) {
  const { data } = useApiQuery<NavPoint[]>(`${ADMIN}/customers/${userId}/nav-history`, {
    days: 180,
  });

  if (!data?.length) {
    return (
      <EmptyState
        title="Chưa có dữ liệu NAV"
        description="Tài khoản này chưa xuất hiện trong dữ liệu đồng bộ từ nguồn."
      />
    );
  }

  const values = data.map((p) => Number(p.nav));
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;

  return (
    <Card>
      <CardHeader
        title="Biểu đồ NAV"
        description={`${data.length} phiên · ${formatDate(data[0].trade_date)} → ${formatDate(
          data[data.length - 1].trade_date,
        )}`}
      />
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-40 w-full" role="img">
        <path
          d={values
            .map(
              (v, i) =>
                `${i === 0 ? 'M' : 'L'} ${(i / (values.length - 1)) * 100} ${
                  40 - ((v - min) / range) * 40
                }`,
            )
            .join(' ')}
          fill="none"
          stroke="#1f63dc"
          strokeWidth="0.8"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-2 flex justify-between text-xs text-ink-500">
        <span>Thấp nhất: {formatCompactCurrency(min)}</span>
        <span>Cao nhất: {formatCompactCurrency(max)}</span>
        <span>Mới nhất: {formatCompactCurrency(values[values.length - 1])}</span>
      </div>
    </Card>
  );
}

function LoginHistory({ userId }: { userId: number }) {
  const { page, size, setPage, setSize } = usePagination(20);
  const { data } = useApiQuery<Page<any>>(`${ADMIN}/customers/${userId}/login-logs`, {
    page,
    size,
  });

  if (!data?.items.length) return <EmptyState title="Chưa có lịch sử đăng nhập" />;

  return (
    <Card padded={false} className="flex min-h-0 flex-1 flex-col">
      <ul className="min-h-0 flex-1 divide-y divide-ink-100 overflow-y-auto overscroll-contain">
        {data.items.map((log) => (
          <li key={log.id} className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm text-ink-900">
                {log.ip ?? 'IP không xác định'}
                {log.note && <span className="ml-2 text-xs text-amber-600">{log.note}</span>}
              </p>
              <p className="mt-0.5 truncate text-xs text-ink-500">{log.user_agent ?? '—'}</p>
            </div>
            <div className="shrink-0 text-right">
              <Badge tone={log.result === 'SUCCESS' ? 'green' : 'red'}>{log.result}</Badge>
              <p className="mt-1 text-xs text-ink-400">{formatDateTime(log.created_at)}</p>
            </div>
          </li>
        ))}
      </ul>

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
  );
}

function ActivityHistory({ userId }: { userId: number }) {
  const { data } = useApiQuery<{ downloads: any[] }>(`${ADMIN}/customers/${userId}/activity`);

  if (!data?.downloads.length) return <EmptyState title="Chưa có hoạt động tải tài liệu" />;

  return (
    <Card padded={false}>
      <ul className="divide-y divide-ink-100">
        {data.downloads.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="min-w-0 truncate text-ink-900">{item.document_title}</span>
            <span className="shrink-0 text-right text-xs text-ink-500">
              {item.ip} · {formatDateTime(item.created_at)}
              {item.watermarked && <span className="ml-2 text-ink-900">có watermark</span>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ComplianceEvents({ userId }: { userId: number }) {
  const events = usePagination(20);
  const logs = usePagination(20);

  const { data } = useApiQuery<Page<any>>(`${ADMIN}/customers/${userId}/compliance-events`, {
    page: events.page,
    size: events.size,
  });
  const { data: audit } = useApiQuery<Page<any>>(`${ADMIN}/customers/${userId}/audit-logs`, {
    page: logs.page,
    size: logs.size,
  });

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Thay đổi trạng thái compliance"
          description="Ai đổi, khi nào, vì sao — kèm số liệu tại thời điểm đó."
        />
        {data?.items.length ? (
          <ul className="divide-y divide-ink-100">
            {data.items.map((event) => (
              <li key={event.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={
                      event.event === 'RESTORE' ? 'green' : event.event === 'SUSPEND' ? 'red' : 'amber'
                    }
                  >
                    {event.event}
                  </Badge>
                  <span className="text-xs text-ink-500">
                    {event.from_status} → {event.to_status}
                  </span>
                  <span className="text-xs text-ink-400">
                    {formatDateTime(event.created_at)} ·{' '}
                    {event.triggered_by === 'job' ? 'Tự động' : 'Nhân viên'}
                  </span>
                </div>
                {event.reason && <p className="mt-1 text-sm text-ink-700">{event.reason}</p>}
                {event.nav_avg_20 !== null && (
                  <p className="mt-0.5 text-xs text-ink-500">
                    NAV trung bình: {formatCurrency(event.nav_avg_20)} · Số ngày không giao dịch:{' '}
                    {event.days_since_last_trade ?? '—'}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-ink-500">Chưa có thay đổi nào</p>
        )}
        {data && (
          <Pagination
            page={data.page}
            pages={data.pages}
            total={data.total}
            size={data.size}
            onPageChange={events.setPage}
            onSizeChange={events.setSize}
          />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Nhật ký thao tác quản trị"
          description="Mọi thao tác admin thực hiện lên tài khoản này."
        />
        {audit?.items.length ? (
          <ul className="divide-y divide-ink-100">
            {audit.items.map((log) => (
              <li key={log.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="blue">{log.action}</Badge>
                  <span className="text-xs text-ink-500">
                    {log.actor_name} · {formatDateTime(log.created_at)} · {log.ip}
                  </span>
                </div>
                {log.reason && <p className="mt-1 text-ink-700">Lý do: {log.reason}</p>}
                {log.new_value && (
                  <pre className="mt-1 overflow-x-auto rounded bg-ink-50 p-2 text-xs text-ink-600">
                    {JSON.stringify(log.new_value, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-ink-500">Chưa có thao tác nào</p>
        )}
        {audit && (
          <Pagination
            page={audit.page}
            pages={audit.pages}
            total={audit.total}
            size={audit.size}
            onPageChange={logs.setPage}
            onSizeChange={logs.setSize}
          />
        )}
      </Card>
    </div>
  );
}

function CustomerNotes({ userId, canWrite }: { userId: number; canWrite: boolean }) {
  const toast = useToast();
  const [content, setContent] = useState('');
  const { page, size, setPage, setSize } = usePagination(20);
  const { data, refresh } = useApiQuery<Page<any>>(`${ADMIN}/customers/${userId}/notes`, {
    page,
    size,
  });

  const addNote = useApiMutation<Message, { content: string }>((input) =>
    api.post<Message>(`${ADMIN}/customers/${userId}/notes`, input),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-3">
      {canWrite && (
        <Card className="shrink-0">
          <Textarea
            label="Thêm ghi chú chăm sóc"
            rows={3}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Ví dụ: Đã gọi lúc 10:00, khách hẹn nạp thêm tiền trong tuần này."
          />
          <Button
            className="mt-3"
            size="sm"
            loading={addNote.loading}
            disabled={content.trim().length < 1}
            onClick={async () => {
              const result = await addNote.mutate({ content: content.trim() });
              if (result) {
                toast.success(result.message);
                setContent('');
                refresh();
              }
            }}
          >
            Lưu ghi chú
          </Button>
        </Card>
      )}

      {data?.items.length ? (
        <Card padded={false} className="flex min-h-0 flex-1 flex-col">
          <ul className="min-h-0 flex-1 divide-y divide-ink-100 overflow-y-auto overscroll-contain">
            {data.items.map((note) => (
              <li key={note.id} className="px-4 py-3">
                <p className="whitespace-pre-line text-sm text-ink-800">{note.content}</p>
                <p className="mt-1 text-xs text-ink-500">
                  {note.staff_name ?? `Nhân viên #${note.staff_id}`} ·{' '}
                  {formatDateTime(note.created_at)}
                </p>
              </li>
            ))}
          </ul>
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
      ) : (
        <EmptyState title="Chưa có ghi chú chăm sóc nào" />
      )}
    </div>
  );
}
