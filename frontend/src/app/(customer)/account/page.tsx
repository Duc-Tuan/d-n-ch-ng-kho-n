'use client';

import Link from 'next/link';
import { useState } from 'react';

import {
  Alert,
  Button,
  Card,
  CardHeader,
  Input,
  Modal,
  PageHeader,
  StatusBadge,
  Table,
  type Column,
} from '@/components/ui';
import { fieldError, useApiMutation, useApiQuery, usePagination, useSession, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/datetime';
import { formatCurrency } from '@/lib/format';
import {
  COMPLIANCE_STATUS,
  CUSTOMER_TYPE,
  IB_LINK_STATUS,
  PAYMENT_STATUS,
  SUBSCRIPTION_STATUS,
} from '@/lib/status';
import type { Message, Page } from '@/types';

type SubscriptionHistoryItem = {
  id: number;
  package_name: string;
  starts_at: string;
  expires_at: string;
  amount: number;
  payment_status: string;
  frozen_days: number;
  created_by_type: string;
  note: string | null;
  created_at: string;
};

export default function AccountPage() {
  const toast = useToast();
  const { session, refresh, logout } = useSession();
  const user = session?.user;

  const [ibOpen, setIbOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const { page, size, setPage, setSize } = usePagination(10);
  const { data: history } = useApiQuery<Page<SubscriptionHistoryItem>>(
    `${CUSTOMER}/account/subscriptions`,
    { page, size },
  );

  const columns: Column<SubscriptionHistoryItem>[] = [
    { key: 'package', header: 'Gói', render: (r) => r.package_name },
    {
      key: 'period',
      header: 'Thời hạn',
      render: (r) => `${formatDate(r.starts_at)} – ${formatDate(r.expires_at)}`,
      hideOnMobile: true,
    },
    { key: 'amount', header: 'Số tiền', render: (r) => formatCurrency(r.amount), align: 'right' },
    {
      key: 'status',
      header: 'Thanh toán',
      render: (r) => <StatusBadge map={PAYMENT_STATUS} code={r.payment_status} />,
    },
    {
      key: 'frozen',
      header: 'Ngày bù',
      render: (r) => (r.frozen_days ? `+${r.frozen_days} ngày` : '—'),
      align: 'right',
      hideOnMobile: true,
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="Tài khoản" description="Thông tin cá nhân, gói dịch vụ và bảo mật" />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Thông tin cá nhân" />
          <dl className="divide-y divide-ink-100 text-sm">
            <Row label="Mã khách hàng" value={user?.customer_code ?? '—'} />
            <Row label="Họ tên" value={user?.full_name} />
            <Row label="Email" value={user?.email} />
            <Row label="Số điện thoại" value={user?.phone ?? '—'} />
            <Row
              label="Nhóm khách hàng"
              value={<StatusBadge map={CUSTOMER_TYPE} code={user?.customer_type} />}
            />
            <Row label="Ngày tham gia" value={formatDate(user?.created_at)} />
            <Row label="Đăng nhập lần cuối" value={formatDateTime(user?.last_login_at)} />
          </dl>
        </Card>

        <Card>
          <CardHeader
            title="Tài khoản chứng khoán"
            action={
              <Button size="sm" variant="outline" onClick={() => setIbOpen(true)}>
                {user?.securities_account_no ? 'Cập nhật' : 'Liên kết'}
              </Button>
            }
          />
          <dl className="divide-y divide-ink-100 text-sm">
            <Row label="Số tài khoản" value={user?.securities_account_no ?? 'Chưa liên kết'} />
            <Row
              label="Trạng thái liên kết"
              value={<StatusBadge map={IB_LINK_STATUS} code={user?.ib_link_status} />}
            />
            {user?.ib_link_deadline && (
              <Row label="Hạn hoàn tất" value={formatDate(user.ib_link_deadline)} />
            )}
            <Row
              label="Điều kiện duy trì"
              value={<StatusBadge map={COMPLIANCE_STATUS} code={user?.compliance_status} />}
            />
            <Row label="Giao dịch gần nhất" value={formatDate(user?.last_trade_date)} />
          </dl>
          <Link href="/account/compliance" className="mt-3 block">
            <Button variant="ghost" size="sm" fullWidth>
              Xem chi tiết điều kiện duy trì →
            </Button>
          </Link>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Gói dịch vụ hiện tại"
          action={
            <Link href="/pricing">
              <Button size="sm">Gia hạn / Nâng cấp</Button>
            </Link>
          }
        />
        {session?.subscription ? (
          <div className="grid gap-3 sm:grid-cols-4">
            <Metric label="Gói" value={session.subscription.package_name} />
            <Metric
              label="Trạng thái"
              value={<StatusBadge map={SUBSCRIPTION_STATUS} code={user?.subscription_status} />}
            />
            <Metric label="Hết hạn" value={formatDate(session.subscription.expires_at)} />
            <Metric
              label="Còn lại"
              value={
                session.subscription.is_frozen
                  ? 'Đang đóng băng'
                  : `${session.subscription.days_remaining ?? 0} ngày`
              }
            />
          </div>
        ) : (
          <p className="text-sm text-ink-500">Bạn chưa có gói dịch vụ nào.</p>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Lịch sử gói và thanh toán"
          description="Mỗi lần mua/gia hạn là một bản ghi độc lập, phục vụ đối soát."
        />
        <Table
          columns={columns}
          rows={history?.items ?? []}
          rowKey={(r) => r.id}
          emptyMessage="Chưa có giao dịch nào"
          pagination={
            history ? { page: history.page, size: history.size, total: history.total } : undefined
          }
          onPageChange={setPage}
          onPageSizeChange={setSize}
          mobileCard={(r: SubscriptionHistoryItem) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-medium">{r.package_name}</span>
                <StatusBadge map={PAYMENT_STATUS} code={r.payment_status} />
              </div>
              <p className="text-xs text-ink-500">
                {formatDate(r.starts_at)} – {formatDate(r.expires_at)}
              </p>
              <p className="text-sm font-medium">{formatCurrency(r.amount)}</p>
            </div>
          )}
        />
      </Card>

      <Card>
        <CardHeader title="Bảo mật" />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => setPasswordOpen(true)}>
            Đổi mật khẩu
          </Button>
          <Link href="/account/notifications">
            <Button variant="outline" fullWidth>
              Cài đặt thông báo
            </Button>
          </Link>
          <Button variant="ghost" onClick={logout}>
            Đăng xuất
          </Button>
        </div>
        {/* BR-111 — nêu rõ chính sách một phiên để KH không bất ngờ khi bị đăng xuất. */}
        <p className="mt-3 text-xs text-ink-500">
          Mỗi tài khoản chỉ duy trì một phiên đăng nhập tại một thời điểm. Khi đăng nhập trên thiết
          bị mới, thiết bị cũ sẽ tự động đăng xuất và bạn nhận được email thông báo.
        </p>
      </Card>

      <IbLinkModal
        open={ibOpen}
        onClose={() => setIbOpen(false)}
        defaultValue={user?.securities_account_no ?? ''}
        onSuccess={async (message) => {
          toast.success(message);
          await refresh();
          setIbOpen(false);
        }}
      />

      <ChangePasswordModal
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        onSuccess={(message) => {
          toast.success(message);
          setPasswordOpen(false);
          logout();
        }}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-right font-medium text-ink-900">{value}</dd>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-ink-50 p-3">
      <p className="text-xs text-ink-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-ink-900">{value}</p>
    </div>
  );
}

function IbLinkModal({
  open,
  onClose,
  defaultValue,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  defaultValue: string;
  onSuccess: (message: string) => void;
}) {
  const [accountNo, setAccountNo] = useState(defaultValue);

  const link = useApiMutation<Message, { securities_account_no: string }>((input) =>
    api.post<Message>(`${CUSTOMER}/account/ib-link`, input),
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Liên kết tài khoản chứng khoán"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={link.loading}
            disabled={accountNo.trim().length < 4}
            onClick={async () => {
              const result = await link.mutate({
                securities_account_no: accountNo.trim(),
              });
              if (result) onSuccess(result.message);
            }}
          >
            Lưu
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {link.error && <Alert tone="danger">{link.error.message}</Alert>}

        <Input
          label="Số tài khoản chứng khoán"
          placeholder="Ví dụ: 0123456789"
          required
          value={accountNo}
          onChange={(e) => setAccountNo(e.target.value)}
          hint="Số tài khoản mở dưới mã giới thiệu (IB) của chúng tôi."
          error={fieldError(link.error, 'securities_account_no')}
        />

        <Alert tone="info">
          Hệ thống sẽ đối chiếu số tài khoản với dữ liệu nguồn vào cuối ngày giao dịch. Bạn vẫn sử
          dụng dịch vụ bình thường trong thời gian chờ đối chiếu.
        </Alert>
      </div>
    </Modal>
  );
}

function ChangePasswordModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const change = useApiMutation<Message, { current_password: string; new_password: string }>(
    (input) => api.post<Message>(`${CUSTOMER}/auth/change-password`, input),
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Đổi mật khẩu"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={change.loading}
            onClick={async () => {
              setLocalError(null);
              if (next !== confirm) {
                setLocalError('Mật khẩu nhập lại không khớp');
                return;
              }
              const result = await change.mutate({ current_password: current, new_password: next });
              if (result) onSuccess(result.message);
            }}
          >
            Đổi mật khẩu
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {(change.error || localError) && (
          <Alert tone="danger">{localError ?? change.error?.message}</Alert>
        )}
        <Input
          label="Mật khẩu hiện tại"
          placeholder="Mật khẩu bạn đang dùng"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={fieldError(change.error, 'current_password')}
        />
        <Input
          label="Mật khẩu mới"
          placeholder="Nhập mật khẩu mới"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          hint="Tối thiểu 8 ký tự, gồm cả chữ và số."
          error={fieldError(change.error, 'new_password')}
        />
        <Input
          label="Nhập lại mật khẩu mới"
          placeholder="Gõ lại mật khẩu mới"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <Alert tone="warning">
          Sau khi đổi mật khẩu, bạn sẽ bị đăng xuất khỏi mọi thiết bị.
        </Alert>
      </div>
    </Modal>
  );
}
