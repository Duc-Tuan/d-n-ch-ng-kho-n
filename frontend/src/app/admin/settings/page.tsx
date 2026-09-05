'use client';

import { useEffect, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Icon,
  Input,
  PageHeader,
  Spinner,
  Textarea,
} from '@/components/ui';
import { useApiMutation, useApiQuery, useStaffSession, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { formatDateTime } from '@/lib/datetime';
import type { Message } from '@/types';

type SettingItem = {
  key: string;
  label: string;
  group: string;
  group_label: string;
  description: string | null;
  value_type: string;
  is_secret: boolean;
  value: string;
  has_value: boolean;
  /** Giá trị đang dùng đến từ đâu: bảng cấu hình, file .env, hay chưa đặt. */
  source: 'database' | 'env' | 'none';
  updated_at: string | null;
};

type SettingsResponse = {
  groups: Array<{ group: string; label: string; items: SettingItem[] }>;
};

type SheetTestResult = {
  ok: boolean;
  message: string;
  hint?: string;
  rows_read?: number;
  rows_valid?: number;
  sample?: Array<{ email: string; account_no: string; nav: number }>;
  invalid?: Array<{ row: number; email: string; error: string }>;
};

const SOURCE_LABEL: Record<SettingItem['source'], { text: string; tone: 'green' | 'gray' | 'amber' }> = {
  database: { text: 'Đặt trên giao diện', tone: 'green' },
  env: { text: 'Lấy từ file .env', tone: 'gray' },
  none: { text: 'Chưa đặt', tone: 'amber' },
};

export default function SettingsPage() {
  const toast = useToast();
  const { isSuperAdmin } = useStaffSession();

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [testResult, setTestResult] = useState<SheetTestResult | null>(null);

  const { data, isLoading, refresh } = useApiQuery<SettingsResponse>(`${ADMIN}/settings`);

  // Nạp giá trị hiện tại vào form một lần, sau đó để người dùng tự sửa.
  useEffect(() => {
    if (!data) return;
    const initial: Record<string, string> = {};
    for (const group of data.groups) {
      for (const item of group.items) {
        // Ô bí mật để trống — nhập mới thì mới ghi đè, để trống là giữ nguyên.
        initial[item.key] = item.is_secret ? '' : item.value;
      }
    }
    setDraft(initial);
  }, [data]);

  const save = useApiMutation<Message, { values: Record<string, string>; reason: string }>((body) =>
    api.put<Message>(`${ADMIN}/settings`, body),
  );

  const testSheet = useApiMutation<SheetTestResult, void>(() =>
    api.post<SheetTestResult>(`${ADMIN}/settings/test-google-sheet`),
  );

  if (!isSuperAdmin) {
    return (
      <div className="space-y-4">
        <PageHeader title="Cấu hình hệ thống" />
        <Alert tone="warning" title="Không đủ quyền">
          Cấu hình ở đây chạm tới bí mật hệ thống (bot token, mật khẩu email) và ngưỡng khoá tài
          khoản khách hàng, nên chỉ Quản trị tối cao được sửa.
        </Alert>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="py-20">
        <Spinner label="Đang tải cấu hình…" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        infoTitle="Cấu hình này ghi đè file .env"
        info={
          <>
            <p>
              Giá trị đặt tại đây <strong>ghi đè</strong> giá trị trong file <code>.env</code>. Để
              trống thì hệ thống dùng lại giá trị trong <code>.env</code>. Mỗi lần lưu đều ghi vào
              nhật ký hệ thống kèm lý do — riêng nội dung token và mật khẩu thì không ghi.
            </p>
            <p className="text-amber-700">
              <strong>Lưu ý về ngưỡng điều kiện duy trì.</strong> Đổi ngưỡng NAV hoặc số ngày không
              giao dịch sẽ ảnh hưởng tới toàn bộ khách hàng ở lần chạy job tiếp theo. Điều khoản sử
              dụng đang ghi cụ thể các con số này — sửa ở đây thì phải ban hành phiên bản điều
              khoản mới tương ứng, nếu không sẽ không có cơ sở để khoá tài khoản của khách đã trả
              tiền.
            </p>
          </>
        }
        title="Cấu hình hệ thống"
        description="Sửa được ngay trên giao diện, không cần truy cập máy chủ"
      />

      {data?.groups.map((group) => (
        <Card key={group.group}>
          <CardHeader
            title={group.label}
            action={
              group.group === 'google_sheet' ? (
                <Button
                  size="sm"
                  variant="outline"
                  loading={testSheet.loading}
                  leftIcon={<Icon name="refresh" size={15} />}
                  onClick={async () => {
                    const result = await testSheet.mutate();
                    setTestResult(result ?? null);
                    if (!result) toast.error(testSheet.error?.message ?? 'Không kiểm tra được');
                  }}
                >
                  Thử đọc sheet
                </Button>
              ) : undefined
            }
          />

          <div className="space-y-4">
            {group.items.map((item) => (
              <div key={item.key}>
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <label className="text-sm font-medium text-ink-700">{item.label}</label>
                  <Badge tone={SOURCE_LABEL[item.source].tone}>
                    {SOURCE_LABEL[item.source].text}
                  </Badge>
                  {item.updated_at && (
                    <span className="text-xs text-ink-400">
                      Sửa lần cuối {formatDateTime(item.updated_at)}
                    </span>
                  )}
                </div>
                <Input
                  type={item.value_type === 'number' ? 'number' : 'text'}
                  value={draft[item.key] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [item.key]: e.target.value })}
                  placeholder={
                    item.is_secret
                      ? item.has_value
                        ? `${item.value} — để trống nếu giữ nguyên`
                        : 'Chưa đặt'
                      : undefined
                  }
                  hint={item.description ?? undefined}
                />
              </div>
            ))}
          </div>

          {/* Kết quả thử đọc sheet hiển thị ngay dưới nhóm cấu hình liên quan. */}
          {group.group === 'google_sheet' && testResult && (
            <Alert
              tone={testResult.ok ? 'success' : 'danger'}
              title={testResult.ok ? 'Đọc sheet thành công' : 'Không đọc được sheet'}
              className="mt-4"
            >
              <p>{testResult.message}</p>
              {testResult.hint && <p className="mt-1 text-xs">{testResult.hint}</p>}

              {testResult.sample && testResult.sample.length > 0 && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-ink-500">
                        <th className="pr-3">Email</th>
                        <th className="pr-3">Số TK</th>
                        <th className="text-right">NAV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {testResult.sample.map((row) => (
                        <tr key={row.email}>
                          <td className="pr-3">{row.email}</td>
                          <td className="pr-3">{row.account_no}</td>
                          <td className="text-right tabular-nums">
                            {row.nav.toLocaleString('vi-VN')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {testResult.invalid && testResult.invalid.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs">
                  {testResult.invalid.map((row) => (
                    <li key={row.row}>
                      Dòng {row.row} ({row.email}): {row.error}
                    </li>
                  ))}
                </ul>
              )}
            </Alert>
          )}
        </Card>
      ))}

      <Card>
        <Textarea
          label="Lý do thay đổi"
          required
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ví dụ: Đổi sang sheet NAV quý 3, sheet cũ đã đóng"
          hint="Bắt buộc — ghi vào nhật ký hệ thống cùng tên người thực hiện."
        />

        {save.error && (
          <Alert tone="danger" className="mt-3">
            {save.error.message}
          </Alert>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            loading={save.loading}
            disabled={reason.trim().length < 3}
            onClick={async () => {
              const result = await save.mutate({ values: draft, reason: reason.trim() });
              if (result) {
                toast.success(result.message);
                setReason('');
                refresh();
              }
            }}
          >
            Lưu cấu hình
          </Button>
          <Button variant="outline" onClick={() => void refresh()}>
            Khôi phục giá trị đang lưu
          </Button>
        </div>
      </Card>

    </div>
  );
}
