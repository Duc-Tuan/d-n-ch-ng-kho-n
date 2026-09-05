'use client';

import Link from 'next/link';
import { useState } from 'react';

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  Modal,
  PageHeader,
  Spinner,
} from '@/components/ui';
import { fieldError, useApiMutation, useApiQuery, useSession, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/datetime';
import { formatCurrency } from '@/lib/format';
import type { Package } from '@/types';

type PurchaseResponse = {
  subscription_id: number;
  payment_ref: string;
  amount: number;
  payment_status: string;
  message: string;
  instruction: { method: string; note: string };
};

export default function PricingPage() {
  const toast = useToast();
  const { session, refresh } = useSession();
  const { data: packages, isLoading } = useApiQuery<Package[]>(`${CUSTOMER}/account/packages`);

  const [selected, setSelected] = useState<Package | null>(null);
  const [accountNo, setAccountNo] = useState(session?.user.securities_account_no ?? '');
  const [acceptRefund, setAcceptRefund] = useState(false);
  const [result, setResult] = useState<PurchaseResponse | null>(null);

  const purchase = useApiMutation<PurchaseResponse, Record<string, unknown>>((input) =>
    api.post<PurchaseResponse>(`${CUSTOMER}/account/purchase`, input),
  );

  const isIbCustomer = session?.user.customer_type === 'IB_LINKED';
  const currentTier = session?.subscription?.package_tier ?? 0;
  const access = session?.access;

  async function handlePurchase() {
    if (!selected) return;
    const response = await purchase.mutate({
      package_id: selected.id,
      securities_account_no: isIbCustomer ? accountNo.trim() : null,
      payment_method: 'BANK_TRANSFER',
      accept_refund_policy: acceptRefund,
    });
    if (response) {
      setResult(response);
      setSelected(null);
      await refresh();
    }
  }

  return (
    <div className="flex flex-1 flex-col space-y-4">
      <PageHeader
        title="Gói dịch vụ"
        description="Chọn gói phù hợp với nhu cầu sử dụng của bạn"
      />

      {/* BR-112 — nêu đúng lý do bị chặn và hành động tiếp theo. */}
      {access && !access.allowed && (
        <Alert
          tone={access.reason.startsWith('COMPLIANCE') ? 'danger' : 'warning'}
          title="Tài khoản đang bị hạn chế"
        >
          {access.message}
        </Alert>
      )}

      {session?.subscription && (
        <Card className="bg-ink-100/60">
          <p className="text-sm text-ink-700">
            Gói hiện tại: <strong>{session.subscription.package_name}</strong>, hết hạn{' '}
            <strong>{formatDate(session.subscription.expires_at)}</strong>
            {session.subscription.is_frozen && ' (đồng hồ đang tạm dừng đếm)'}.
          </p>
          {/* BR-131 — gia hạn trước hạn thì cộng dồn, KH cần biết để không chần chừ. */}
          <p className="mt-1 text-xs text-ink-600">
            Gia hạn khi gói chưa hết hạn: thời gian mới được cộng dồn vào ngày hết hạn hiện tại, bạn
            không bị mất ngày nào.
          </p>
        </Card>
      )}

      {isLoading ? (
        <div className="py-16">
          <Spinner label="Đang tải bảng giá…" />
        </div>
      ) : (
        /* `auto-rows-fr` + `flex-1`: lưới nhận hết phần trống còn lại và các thẻ gói cao bằng
           nhau, thay vì thẻ ngắn tũn nằm lửng giữa màn hình. */
        <div className="grid min-h-0 flex-1 auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {packages?.map((pkg) => {
            const isCurrent = session?.subscription?.package_code === pkg.code;
            const isUpgrade = pkg.tier > currentTier;

            return (
              <Card
                key={pkg.id}
                className={cn(
                  'flex h-full flex-col',
                  pkg.tier === 4 && 'border-ink-400 ring-1 ring-ink-200',
                )}
              >
                {pkg.tier === 4 && (
                  <span className="mb-2 self-start rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-fg">
                    Tiết kiệm nhất
                  </span>
                )}
                <h3 className="text-base font-semibold text-ink-900">{pkg.name}</h3>
                <p className="mt-2 text-2xl font-semibold text-ink-900">
                  {formatCurrency(pkg.price)}
                </p>
                <p className="mt-0.5 text-sm text-ink-500">
                  {pkg.duration_months} tháng sử dụng
                </p>

                {pkg.description && (
                  <p className="mt-3 flex-1 text-sm text-ink-600">{pkg.description}</p>
                )}

                <ul className="mt-3 space-y-1.5 text-sm text-ink-600">
                  <li className="flex gap-2">
                    <span className="text-tone-green-fg">✓</span>
                    Toàn bộ chức năng phân tích
                  </li>
                  <li className="flex gap-2">
                    <span className="text-tone-green-fg">✓</span>
                    {pkg.max_telegram_alerts < 0
                      ? 'Không giới hạn đăng ký nhận tín hiệu'
                      : `${pkg.max_telegram_alerts} lượt đăng ký nhận tín hiệu`}
                  </li>
                  <li className="flex gap-2">
                    <span className="text-tone-green-fg">✓</span>
                    {pkg.max_ai_questions_per_day} câu hỏi chuyên viên mỗi ngày
                  </li>
                </ul>

                <Button
                  className="mt-4"
                  fullWidth
                  variant={isCurrent ? 'outline' : 'primary'}
                  disabled={isCurrent}
                  onClick={() => {
                    setSelected(pkg);
                    setAcceptRefund(false);
                  }}
                >
                  {isCurrent ? 'Gói hiện tại' : isUpgrade ? 'Nâng cấp' : 'Gia hạn'}
                </Button>
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={`Đăng ký ${selected?.name ?? ''}`}
        description={selected ? formatCurrency(selected.price) : undefined}
        footer={
          <>
            <Button variant="outline" onClick={() => setSelected(null)}>
              Huỷ
            </Button>
            <Button
              loading={purchase.loading}
              disabled={!acceptRefund || (isIbCustomer && accountNo.trim().length < 4)}
              onClick={handlePurchase}
            >
              Tạo đơn hàng
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {purchase.error && <Alert tone="danger">{purchase.error.message}</Alert>}

          {/* BR-200 — tuyến IB bắt buộc khai số tài khoản chứng khoán khi mua gói. */}
          {isIbCustomer && (
            <Input
              label="Số tài khoản chứng khoán mở dưới IB"
              placeholder="Ví dụ: 0123456789"
              required
              value={accountNo}
              onChange={(e) => setAccountNo(e.target.value)}
              hint="Số tài khoản sẽ được đối chiếu với dữ liệu nguồn vào cuối ngày giao dịch."
              error={fieldError(purchase.error, 'securities_account_no')}
            />
          )}

          {isIbCustomer && (
            // BR-210 phương án B — cho vào ngay, hạn 15 ngày hoàn tất liên kết.
            <Alert tone="info">
              Bạn được sử dụng dịch vụ ngay sau khi thanh toán. Vui lòng hoàn tất liên kết tài khoản
              chứng khoán trong vòng 15 ngày. Nếu quá hạn, tài khoản sẽ tạm dừng nhưng{' '}
              <strong>thời hạn gói được đóng băng</strong> — bạn không mất ngày sử dụng nào.
            </Alert>
          )}

          <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs leading-relaxed text-ink-600">
            <p className="mb-1 font-medium text-ink-700">Tóm tắt chính sách hoàn tiền</p>
            <p>
              Dịch vụ không hoàn tiền sau khi gói đã kích hoạt. Nếu tài khoản bị tạm dừng do không
              đạt điều kiện duy trì, thời hạn gói được đóng băng và bù đủ khi khôi phục.{' '}
              <Link href="/legal/refund" target="_blank" className="text-ink-900 underline">
                Xem đầy đủ
              </Link>
              .
            </p>
          </div>

          {/* BR-800 — checkbox không tick sẵn; hệ thống lưu bằng chứng đồng ý đúng phiên bản văn bản. */}
          <Checkbox
            checked={acceptRefund}
            onChange={(e) => setAcceptRefund(e.target.checked)}
            label="Tôi đã đọc và đồng ý với Chính sách thanh toán & hoàn tiền và điều kiện duy trì tài khoản."
          />
        </div>
      </Modal>

      <Modal
        open={Boolean(result)}
        onClose={() => setResult(null)}
        title="Đơn hàng đã được tạo"
        footer={
          <Button onClick={() => setResult(null)} fullWidth>
            Đã hiểu
          </Button>
        }
      >
        {result && (
          <div className="space-y-3">
            <Alert tone="success">{result.message}</Alert>
            <dl className="divide-y divide-ink-100 text-sm">
              <div className="flex justify-between gap-3 py-2">
                <dt className="text-ink-500">Số tiền</dt>
                <dd className="font-medium">{formatCurrency(result.amount)}</dd>
              </div>
              <div className="flex justify-between gap-3 py-2">
                <dt className="text-ink-500">Nội dung chuyển khoản</dt>
                <dd className="font-mono font-medium">{result.payment_ref}</dd>
              </div>
            </dl>
            <p className="text-xs text-ink-500">
              Gói sẽ được kích hoạt ngay sau khi thanh toán được xác nhận. Bạn sẽ nhận email thông
              báo.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
