'use client';

/**
 * YC7 — nhân viên tạo tài khoản hộ khách hàng.
 *
 * Khách hàng liên hệ trực tiếp (hotline, tại quầy), nhân viên xác minh danh tính rồi tạo tài
 * khoản. Mật khẩu do hệ thống sinh và gửi qua email — nhân viên **không được tự đặt mật khẩu**
 * (BR-520: quản trị viên không bao giờ biết mật khẩu của khách hàng).
 */
import { useState } from 'react';

import {
  Alert,
  Button,
  Checkbox,
  Icon,
  Input,
  Modal,
  Select,
} from '@/components/ui';
import { fieldError, useApiMutation, useApiQuery, useToast } from '@/hooks';
import { ADMIN, PUBLIC, api } from '@/lib/api';
import { formatCurrency } from '@/lib/format';
import type { Package } from '@/types';

type CreateResult = {
  id: number;
  email: string;
  customer_code: string | null;
  message: string;
  temp_password: string;
  note: string;
};

const EMPTY = {
  email: '',
  full_name: '',
  phone: '',
  customer_type: 'IB_LINKED',
  securities_account_no: '',
  broker_name: '',
  broker_code: '',
  broker_phone: '',
  package_id: '',
  skip_email_verification: true,
  reason: '',
};

export function CreateCustomerModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [result, setResult] = useState<CreateResult | null>(null);

  const { data: packages } = useApiQuery<Package[]>(`${PUBLIC}/packages`);

  const create = useApiMutation<CreateResult, Record<string, unknown>>((body) =>
    api.post<CreateResult>(`${ADMIN}/customers/create`, body),
  );

  function set<K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Sau khi tạo xong hiện màn kết quả để nhân viên đọc mật khẩu cho khách qua điện thoại.
  if (result) {
    return (
      <Modal
        open
        onClose={() => {
          setResult(null);
          onCreated();
          onClose();
        }}
        title="Đã tạo tài khoản"
        size="md"
        footer={
          <Button
            fullWidth
            onClick={() => {
              setResult(null);
              onCreated();
              onClose();
            }}
          >
            Xong
          </Button>
        }
      >
        <div className="space-y-4">
          <Alert tone="success">{result.message}</Alert>

          <div className="rounded-lg border border-ink-200 bg-ink-50 p-4">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">Mã khách hàng</dt>
                <dd className="font-medium">{result.customer_code}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">Email đăng nhập</dt>
                <dd className="font-medium">{result.email}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-ink-200 pt-2">
                <dt className="text-ink-500">Mật khẩu tạm</dt>
                <dd className="flex items-center gap-2">
                  <code className="rounded bg-surface px-2 py-1 font-mono text-sm font-semibold">
                    {result.temp_password}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    leftIcon={<Icon name="copy" size={14} />}
                    onClick={() => {
                      navigator.clipboard.writeText(result.temp_password);
                      toast.success('Đã sao chép mật khẩu');
                    }}
                  >
                    Sao chép
                  </Button>
                </dd>
              </div>
            </dl>
          </div>

          <Alert tone="warning" title="Lưu ý khi bàn giao">
            Mật khẩu này chỉ hiển thị một lần tại đây. Đọc cho khách hàng qua điện thoại nếu email
            chưa tới, và {result.note.toLowerCase()}
          </Alert>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Tạo tài khoản khách hàng"
      description="Dùng khi khách hàng liên hệ trực tiếp và đã được xác minh danh tính."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={create.loading}
            disabled={
              !form.email.includes('@') ||
              form.full_name.trim().length < 2 ||
              form.phone.trim().length < 9 ||
              form.reason.trim().length < 3
            }
            onClick={async () => {
              const response = await create.mutate({
                email: form.email.trim(),
                full_name: form.full_name.trim(),
                phone: form.phone.trim(),
                customer_type: form.customer_type,
                securities_account_no: form.securities_account_no.trim() || null,
                broker_name: form.broker_name.trim() || null,
                broker_code: form.broker_code.trim() || null,
                broker_phone: form.broker_phone.trim() || null,
                package_id: form.package_id ? Number(form.package_id) : null,
                skip_email_verification: form.skip_email_verification,
                reason: form.reason.trim(),
              });
              if (response) setResult(response);
            }}
          >
            Tạo tài khoản
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {create.error && <Alert tone="danger">{create.error.message}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Họ và tên"
            placeholder="Nguyễn Văn An"
            required
            value={form.full_name}
            onChange={(e) => set('full_name', e.target.value)}
            error={fieldError(create.error, 'full_name')}
          />
          <Input
            label="Số điện thoại"
            required
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
            placeholder="0912345678"
            hint="Mỗi số chỉ dùng cho một tài khoản."
            error={fieldError(create.error, 'phone')}
          />
        </div>

        <Input
          label="Email"
          placeholder="khachhang@email.com"
          type="email"
          required
          value={form.email}
          onChange={(e) => set('email', e.target.value)}
          hint="Email là định danh đăng nhập và là khoá đối chiếu dữ liệu NAV."
          error={fieldError(create.error, 'email')}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Nhóm khách hàng"
            value={form.customer_type}
            onChange={(e) => set('customer_type', e.target.value)}
            options={[
              { value: 'IB_LINKED', label: 'Dưới IB — chịu điều kiện NAV/giao dịch' },
              { value: 'PAID_ONLY', label: 'Trả phí thuần — chỉ ràng buộc thời hạn' },
            ]}
          />
          {form.customer_type === 'IB_LINKED' && (
            <Input
              label="Số tài khoản chứng khoán"
              placeholder="Ví dụ: 0123456789"
              value={form.securities_account_no}
              onChange={(e) => set('securities_account_no', e.target.value)}
              hint="Bỏ trống nếu khách hàng chưa mở tài khoản."
            />
          )}
        </div>

        <div className="rounded-lg border border-ink-200 p-3">
          <p className="mb-3 text-sm font-medium text-ink-700">Môi giới phụ trách</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              label="Họ tên"
              placeholder="Tên nhân viên môi giới phụ trách"
              value={form.broker_name}
              onChange={(e) => set('broker_name', e.target.value)}
            />
            <Input
              label="Mã môi giới"
              placeholder="Ví dụ: MG001"
              value={form.broker_code}
              onChange={(e) => set('broker_code', e.target.value)}
            />
            <Input
              label="Điện thoại"
              placeholder="0912345678"
              value={form.broker_phone}
              onChange={(e) => set('broker_phone', e.target.value)}
            />
          </div>
          <p className="mt-2 text-xs text-ink-500">
            Thông tin này hiển thị cho khách hàng, và xuất hiện trong thông báo khi tài khoản bị
            cảnh báo NAV — để khách hàng biết liên hệ ai.
          </p>
        </div>

        <Select
          label="Cấp gói ngay"
          value={form.package_id}
          onChange={(e) => set('package_id', e.target.value)}
          placeholder="Không cấp — cho dùng thử 7 ngày"
          options={(packages ?? [])
            .filter((p) => !p.is_trial)
            .map((p) => ({ value: p.id, label: `${p.name} — ${formatCurrency(p.price)}` }))}
          hint="Chỉ chọn khi khách hàng đã thanh toán. Thao tác được ghi vào nhật ký hệ thống."
        />

        <Checkbox
          checked={form.skip_email_verification}
          onChange={(e) => set('skip_email_verification', e.target.checked)}
          label={
            <>
              Bỏ qua bước xác thực email
              <span className="block text-xs text-ink-500">
                Chọn khi bạn đã xác minh danh tính khách hàng trực tiếp. Khách hàng đăng nhập được
                ngay sau khi nhận email. Bỏ chọn thì khách hàng phải bấm link xác thực trước.
              </span>
            </>
          }
        />

        <Input
          label="Lý do tạo tài khoản"
          required
          value={form.reason}
          onChange={(e) => set('reason', e.target.value)}
          placeholder="Ví dụ: Khách liên hệ qua hotline, đã xác minh CCCD"
          hint="Bắt buộc — ghi vào nhật ký hệ thống cùng tên người thực hiện."
        />

        <Alert tone="info">
          Hệ thống sinh mật khẩu ngẫu nhiên và gửi qua email. Nhân viên không đặt được mật khẩu
          cho khách hàng.
        </Alert>
      </div>
    </Modal>
  );
}
