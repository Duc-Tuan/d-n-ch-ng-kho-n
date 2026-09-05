'use client';

import { useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  Input,
  PageHeader,
  Select,
  Textarea,
  ToggleGroup,
} from '@/components/ui';
import { useApiMutation, useApiQuery, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { formatNumber, formatPercent } from '@/lib/format';
import { COMPLIANCE_STATUS, SUBSCRIPTION_STATUS, statusOptions } from '@/lib/status';

/** BR-810 — ba kênh gửi thủ công, cùng thứ tự với mức độ gây phiền tăng dần. */
const CHANNEL_OPTIONS = [
  { value: 'IN_APP', label: 'Trong ứng dụng' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'SMS', label: 'SMS' },
];
import type { Message } from '@/types';

type Preview = {
  recipient_count: number;
  sample: Array<{ email: string; full_name: string; subscription_status: string }>;
  channels: string[];
  subject: string;
};

/**
 * BR-818 — gửi thông báo thủ công theo bộ lọc.
 *
 * Bắt buộc có bước **xem trước và xác nhận số người nhận** trước khi gửi.
 * Backend còn kiểm tra lại số người nhận có thay đổi giữa lúc xem trước và lúc gửi hay không.
 */
export default function BroadcastPage() {
  const toast = useToast();

  const [form, setForm] = useState({
    subject: '',
    body: '',
    channels: ['IN_APP'] as string[],
    filter_subscription_status: [] as string[],
    filter_compliance_status: [] as string[],
    filter_expiring_in_days: '',
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirming, setConfirming] = useState(false);

  const payload = {
    subject: form.subject,
    body: form.body,
    channels: form.channels,
    filter_subscription_status: form.filter_subscription_status.length
      ? form.filter_subscription_status
      : null,
    filter_compliance_status: form.filter_compliance_status.length
      ? form.filter_compliance_status
      : null,
    filter_expiring_in_days: form.filter_expiring_in_days
      ? Number(form.filter_expiring_in_days)
      : null,
  };

  const doPreview = useApiMutation<Preview, void>(() =>
    api.post<Preview>(`${ADMIN}/notifications/preview`, { ...payload, confirm: false }),
  );

  const send = useApiMutation<Message, void>(() =>
    api.post<Message>(`${ADMIN}/notifications/send`, {
      ...payload,
      confirm: true,
      confirmed_recipient_count: preview?.recipient_count ?? null,
    }),
  );

  const { data: stats } = useApiQuery<any>(`${ADMIN}/notifications/stats`, { days: 30 });

  function setList(
    key: 'channels' | 'filter_subscription_status' | 'filter_compliance_status',
    next: string[],
  ) {
    setForm((f) => ({ ...f, [key]: next }));
    setPreview(null);  // đổi tiêu chí thì bản xem trước cũ không còn đúng
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Gửi thông báo"
        description="Gửi thông báo tới nhóm khách hàng theo bộ lọc"
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Nội dung" />
            <div className="space-y-4">
              <Input
                label="Tiêu đề"
                placeholder="Tiêu đề hiển thị trong email và thông báo"
                required
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
              />
              <Textarea
                label="Nội dung"
                placeholder="Nội dung gửi tới khách hàng"
                required
                rows={6}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
              />

              <div>
                <ToggleGroup
                  label="Kênh gửi"
                  options={CHANNEL_OPTIONS}
                  value={form.channels}
                  onChange={(next) => setList('channels', next)}
                />
                {/* BR-810 — chọn kênh theo mức độ quan trọng, không bắn tất cả qua tất cả kênh. */}
                <p className="mt-1.5 text-xs text-ink-500">
                  Chọn kênh theo mức độ quan trọng của thông tin. SMS tốn chi phí và dễ gây phiền —
                  chỉ dùng cho nội dung khách hàng thiệt hại nếu bỏ lỡ.
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Bộ lọc người nhận" />
            <div className="space-y-4">
              <ToggleGroup
                label="Trạng thái gói"
                options={statusOptions(SUBSCRIPTION_STATUS)}
                value={form.filter_subscription_status}
                onChange={(next) => setList('filter_subscription_status', next)}
              />

              <ToggleGroup
                label="Điều kiện duy trì"
                options={statusOptions(COMPLIANCE_STATUS)}
                value={form.filter_compliance_status}
                onChange={(next) => setList('filter_compliance_status', next)}
              />

              <Select
                label="Sắp hết hạn trong"
                value={form.filter_expiring_in_days}
                onChange={(e) => {
                  setForm({ ...form, filter_expiring_in_days: e.target.value });
                  setPreview(null);
                }}
                placeholder="Không lọc theo hạn"
                options={[
                  { value: '3', label: '3 ngày' },
                  { value: '7', label: '7 ngày' },
                  { value: '15', label: '15 ngày' },
                  { value: '30', label: '30 ngày' },
                ]}
              />

              <p className="text-xs text-ink-500">
                Không chọn bộ lọc nào nghĩa là gửi cho <strong>toàn bộ khách hàng</strong>.
              </p>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Xem trước" />
            {preview ? (
              <div className="space-y-3">
                <div className="rounded-lg bg-ink-100 p-3 text-center">
                  <p className="text-xs text-ink-600">Số người nhận</p>
                  <p className="text-3xl font-semibold text-ink-900">
                    {formatNumber(preview.recipient_count)}
                  </p>
                </div>

                {preview.sample.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-ink-500">Ví dụ người nhận</p>
                    <ul className="space-y-1 text-xs text-ink-600">
                      {preview.sample.map((user) => (
                        <li key={user.email} className="truncate">
                          {user.full_name} · {user.email}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <Button
                  fullWidth
                  disabled={preview.recipient_count === 0}
                  onClick={() => setConfirming(true)}
                >
                  Gửi cho {formatNumber(preview.recipient_count)} khách hàng
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-ink-600">
                  Bấm xem trước để biết chính xác bao nhiêu khách hàng sẽ nhận được thông báo này.
                </p>
                <Button
                  fullWidth
                  variant="outline"
                  loading={doPreview.loading}
                  disabled={!form.subject || !form.body || form.channels.length === 0}
                  onClick={async () => {
                    const result = await doPreview.mutate();
                    if (result) setPreview(result);
                  }}
                >
                  Xem trước
                </Button>
                {doPreview.error && <Alert tone="danger">{doPreview.error.message}</Alert>}
              </div>
            )}
          </Card>

          {/* BR-819 — theo dõi hiệu quả từng mã thông báo. */}
          {stats?.items?.length > 0 && (
            <Card>
              <CardHeader
                title="Hiệu quả 30 ngày"
                description="Tỷ lệ đọc theo từng loại thông báo"
              />
              <ul className="space-y-2 text-sm">
                {stats.items
                  .filter((item: any) => item.channel === 'IN_APP')
                  .slice(0, 8)
                  .map((item: any) => (
                    <li key={`${item.code}-${item.channel}`} className="flex justify-between gap-2">
                      <span className="min-w-0 truncate text-ink-600">{item.code}</span>
                      <span className="shrink-0">
                        <Badge tone="gray">{formatNumber(item.total)} gửi</Badge>{' '}
                        {item.read_rate !== null && item.read_rate !== undefined && (
                          <Badge tone="green">{formatPercent(item.read_rate)} đọc</Badge>
                        )}
                      </span>
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Xác nhận gửi thông báo"
        message={
          <div className="space-y-2">
            <p>
              Gửi <strong>“{form.subject}”</strong> tới{' '}
              <strong>{formatNumber(preview?.recipient_count ?? 0)} khách hàng</strong> qua{' '}
              {form.channels.join(', ')}?
            </p>
            <p className="text-ink-600">
              Thao tác này không thể thu hồi và được ghi vào nhật ký hệ thống.
            </p>
          </div>
        }
        confirmLabel="Gửi ngay"
        danger
        loading={send.loading}
        onConfirm={async () => {
          const result = await send.mutate();
          if (result) {
            toast.success(result.message);
            setConfirming(false);
            setPreview(null);
            setForm({ ...form, subject: '', body: '' });
          } else {
            toast.error(send.error?.message ?? 'Gửi thất bại');
          }
        }}
      />
    </div>
  );
}
