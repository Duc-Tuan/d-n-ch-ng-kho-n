'use client';

import { useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Icon,
  Input,
  Modal,
  PageHeader,
  Spinner,
} from '@/components/ui';
import { ChangePasswordModal } from '@/components/domain/ChangePasswordModal';
import { useApiQuery, useStaffSession } from '@/hooks';
import { ADMIN } from '@/lib/api';
import { formatDateTime } from '@/lib/datetime';
import type { Permission, Role } from '@/types';

/**
 * Hồ sơ cá nhân của nhân viên.
 *
 * Menu tài khoản đã trỏ tới đường dẫn này từ trước nhưng màn hình chưa tồn tại — bấm vào là ra
 * trang 404. Màn này lấp chỗ đó và là nơi duy nhất nhân viên tự đổi được mật khẩu của mình.
 *
 * BR-533 — danh sách quyền ở đây chỉ để nhân viên **biết mình có gì**; chặn thật vẫn nằm ở backend
 * trên từng endpoint.
 */
export default function StaffProfilePage() {
  const { staff, loading } = useStaffSession();
  const [passwordOpen, setPasswordOpen] = useState(false);

  const { data: roles } = useApiQuery<Role[]>(`${ADMIN}/roles`);
  const { data: permissions } = useApiQuery<Permission[]>(`${ADMIN}/permissions`);

  if (loading) {
    return (
      <div className="py-20">
        <Spinner label="Đang tải hồ sơ…" />
      </div>
    );
  }

  if (!staff) return null;

  const permissionName = (code: string) =>
    permissions?.find((p) => p.code === code)?.name ?? code;

  return (
    <div className="space-y-3">
      <PageHeader
        title="Hồ sơ cá nhân"
        description="Thông tin tài khoản quản trị và tập quyền đang có"
        infoTitle="Về hồ sơ và mật khẩu"
        info={
          <>
            <p>
              Thông tin định danh (tên đăng nhập, họ tên, email) do <strong>Quản trị tối cao</strong>{' '}
              quản lý ở màn Nhân viên &amp; phân quyền — bạn không tự sửa được. Điều này để nhật ký
              hệ thống luôn quy được trách nhiệm về đúng một người.
            </p>
            <p>
              Đổi mật khẩu cần <strong>xác nhận bằng mã gửi về email</strong> của bạn (hiệu lực 5
              phút), và sẽ <strong>kết thúc mọi phiên đăng nhập hiện tại</strong> — kể cả phiên bạn
              đang dùng, nên sau khi đổi bạn phải đăng nhập lại.
            </p>
            <p>
              Danh sách quyền bên dưới chỉ để bạn biết mình làm được gì. Việc kiểm tra quyền thực
              hiện ở backend trên từng API (BR-533).
            </p>
          </>
        }
        action={
          <Button leftIcon={<Icon name="key" size={15} />} onClick={() => setPasswordOpen(true)}>
            Đổi mật khẩu
          </Button>
        }
      />

      {staff.must_change_password && (
        <Alert tone="warning" title="Bạn đang dùng mật khẩu do quản trị viên cấp">
          Hãy đổi sang mật khẩu của riêng bạn. Mật khẩu do người khác biết thì mọi thao tác ghi
          trong nhật ký dưới tên bạn đều mất giá trị đối chứng.
        </Alert>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Thông tin tài khoản" />
          <dl className="divide-y divide-ink-100 text-sm">
            <Row label="Tên đăng nhập" value={staff.username} />
            <Row label="Họ tên" value={staff.full_name} />
            <Row label="Email" value={staff.email} />
            <Row label="Số điện thoại" value={staff.phone ?? '—'} />
            <Row
              label="Trạng thái"
              value={
                <Badge tone={staff.status === 'ACTIVE' ? 'green' : 'gray'}>
                  {staff.status === 'ACTIVE' ? 'Đang làm việc' : 'Đã nghỉ'}
                </Badge>
              }
            />
            <Row label="Đăng nhập lần cuối" value={formatDateTime(staff.last_login_at)} />
          </dl>
        </Card>

        <Card>
          <CardHeader
            title="Vai trò"
            description="Do Quản trị tối cao gán. Mỗi vai trò là một tập hợp quyền."
          />
          <div className="flex flex-wrap gap-1.5">
            {staff.roles.map((code) => (
              <Badge key={code} tone={code === 'SUPER_ADMIN' ? 'purple' : 'blue'}>
                {roles?.find((r) => r.code === code)?.name ?? code}
              </Badge>
            ))}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title={`Quyền đang có (${staff.permissions.length})`}
          description="Tổng hợp từ tất cả vai trò được gán."
        />
        {staff.permissions.length ? (
          <div className="flex flex-wrap gap-1.5">
            {staff.permissions.map((code) => (
              <span
                key={code}
                title={code}
                className="rounded bg-ink-100 px-2 py-0.5 text-xs text-ink-600"
              >
                {permissionName(code)}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-500">Chưa được gán quyền nào.</p>
        )}
      </Card>

      {passwordOpen && <ChangePasswordModal onClose={() => setPasswordOpen(false)} />}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <dt className="shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-ink-900">{value}</dd>
    </div>
  );
}
