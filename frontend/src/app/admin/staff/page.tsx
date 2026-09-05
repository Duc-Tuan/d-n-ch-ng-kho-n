'use client';

import { useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Icon,
  Input,
  Modal,
  PageHeader,
  RowAction,
  SearchInput,
  Select,
  Spinner,
  StatusBadge,
  Table,
  TabPanel,
  Tabs,
  Textarea,
  type Column,
} from '@/components/ui';
import { useApiMutation, useApiQuery, usePagination, useStaffSession, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { formatDateTime } from '@/lib/datetime';
import type { Message, Page, Permission, Role, StaffListItem } from '@/types';

const STAFF_STATUS = {
  ACTIVE: { label: 'Đang làm việc', tone: 'green' as const, hint: '' },
  INACTIVE: { label: 'Đã nghỉ', tone: 'gray' as const, hint: 'Giữ bản ghi để không mất liên kết với nhật ký và bài viết đã đăng.' },
};

const TABS = [
  { key: 'staff', label: 'Nhân viên' },
  { key: 'roles', label: 'Vai trò & quyền' },
];

export default function StaffPage() {
  const { isSuperAdmin } = useStaffSession();
  const [tab, setTab] = useState('staff');

  return (
    <div className="flex h-full flex-col space-y-3">
      <PageHeader
        title="Nhân viên & phân quyền"
        description="Quản lý tài khoản quản trị và tập quyền của từng vai trò"
        infoTitle="Vai trò và phân quyền hoạt động thế nào"
        info={
          <>
            {/* BR-533 — nhắc rõ để không ai nhầm rằng ẩn menu là đã phân quyền. */}
            <p>
              Vai trò là một <strong>tập hợp quyền</strong>; một nhân viên có thể gán nhiều vai
              trò. Việc kiểm tra quyền được thực hiện ở backend trên từng API — ẩn menu ở giao diện
              không phải là phân quyền.
            </p>
            {!isSuperAdmin && (
              <p className="text-amber-700">
                Chỉ Quản trị tối cao mới tạo, sửa tài khoản nhân viên và thay đổi phân quyền. Bạn
                đang ở chế độ chỉ xem.
              </p>
            )}
          </>
        }
      />

      <Tabs items={TABS} active={tab} onChange={setTab} />

      {/* Nội dung tab lấp đầy phần trống còn lại — cùng cách với bảng danh sách. */}
      <TabPanel active={tab} tabKey="staff" className="flex min-h-0 flex-1 flex-col">
        <StaffList canManage={isSuperAdmin} />
      </TabPanel>

      <TabPanel active={tab} tabKey="roles" className="min-h-0 flex-1 overflow-y-auto">
        <RoleMatrix canManage={isSuperAdmin} />
      </TabPanel>
    </div>
  );
}

function StaffList({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<StaffListItem | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const { page, size, setPage, setSize, reset } = usePagination(20);

  const { data, isLoading, refresh } = useApiQuery<Page<StaffListItem>>(`${ADMIN}/staff`, {
    page,
    size,
    q: search || undefined,
    status: status || undefined,
  });
  const { data: roles } = useApiQuery<Role[]>(`${ADMIN}/roles`);

  const columns: Column<StaffListItem>[] = [
    {
      key: 'staff',
      header: 'Nhân viên',
      render: (row) => (
        <div>
          <p className="font-medium text-ink-900">{row.full_name}</p>
          <p className="text-xs text-ink-500">
            {row.username} · {row.email}
          </p>
        </div>
      ),
    },
    {
      key: 'roles',
      header: 'Vai trò',
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.roles.map((code) => (
            <Badge key={code} tone={code === 'SUPER_ADMIN' ? 'purple' : 'blue'}>
              {roles?.find((r) => r.code === code)?.name ?? code}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      render: (row) => <StatusBadge map={STAFF_STATUS} code={row.status} />,
    },
    {
      key: 'last_login',
      header: 'Đăng nhập cuối',
      render: (row) => formatDateTime(row.last_login_at),
      hideOnMobile: true,
    },
    {
      key: 'actions',
      header: 'Hành động',
      width: '7rem',
      align: 'right',
      sticky: 'right',
      render: (row) =>
        canManage ? (
          <div className="flex justify-center gap-0.5">
            <RowAction
              label="Sửa nhân viên"
              icon={<Icon name="edit" size={16} />}
              onClick={() => setEditing(row)}
            />
            <RowAction
              label="Sửa vai trò & quyền"
              icon={<Icon name="key" size={16} />}
              onClick={() => setEditing(row)}
            />
          </div>
        ) : (
          <span className="text-xs text-ink-400">Chỉ xem</span>
        ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-3">
      <div className="shrink-0 grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-end">
        <SearchInput
          placeholder="Tên, tên đăng nhập, email…"
          value={search}
          onSearch={(value) => {
            setSearch(value);
            reset();
          }}
        />
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            reset();
          }}
          placeholder="Tất cả trạng thái"
          options={Object.entries(STAFF_STATUS).map(([value, meta]) => ({
            value,
            label: meta.label,
          }))}
        />
        {canManage && (
          <Button leftIcon={<Icon name="plus" size={15} />} onClick={() => setCreating(true)}>
            Thêm nhân viên
          </Button>
        )}
      </div>

      <Table
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id}
        loading={isLoading}
        emptyMessage="Không tìm thấy nhân viên nào khớp bộ lọc"
        fill
        minWidth="52rem"
        pagination={data ? { page: data.page, size: data.size, total: data.total } : undefined}
        onPageChange={setPage}
        onPageSizeChange={(next) => {
          setSize(next);
          reset();
        }}
      />

      {(creating || editing) && (
        <StaffEditor
          staff={editing}
          roles={roles ?? []}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(message) => {
            toast.success(message);
            setCreating(false);
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function StaffEditor({
  staff,
  roles,
  onClose,
  onSaved,
}: {
  staff: StaffListItem | null;
  roles: Role[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = Boolean(staff);
  const [form, setForm] = useState({
    username: staff?.username ?? '',
    email: staff?.email ?? '',
    full_name: staff?.full_name ?? '',
    phone: staff?.phone ?? '',
    password: '',
    status: staff?.status ?? 'ACTIVE',
    role_codes: staff?.roles ?? [],
    reason: '',
  });

  const save = useApiMutation<Message | { id: number; message: string }, Record<string, unknown>>(
    (body) =>
      isEdit
        ? api.put<Message>(`${ADMIN}/staff/${staff!.id}`, body)
        : api.post<{ id: number; message: string }>(`${ADMIN}/staff`, body),
  );

  const rolesChanged =
    isEdit && JSON.stringify([...form.role_codes].sort()) !== JSON.stringify([...(staff?.roles ?? [])].sort());

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Sửa nhân viên: ${staff!.full_name}` : 'Thêm nhân viên'}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={save.loading}
            disabled={
              form.role_codes.length === 0 ||
              (!isEdit && (form.username.length < 3 || form.password.length < 8)) ||
              (rolesChanged && form.reason.trim().length < 3)
            }
            onClick={async () => {
              const body = isEdit
                ? {
                    email: form.email,
                    full_name: form.full_name,
                    phone: form.phone || null,
                    status: form.status,
                    role_codes: form.role_codes,
                    reason: form.reason || null,
                  }
                : {
                    username: form.username,
                    email: form.email,
                    full_name: form.full_name,
                    phone: form.phone || null,
                    password: form.password,
                    role_codes: form.role_codes,
                  };
              const result = await save.mutate(body);
              if (result) onSaved((result as Message).message);
            }}
          >
            {isEdit ? 'Lưu' : 'Tạo tài khoản'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.error && <Alert tone="danger">{save.error.message}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          {!isEdit && (
            <Input
              label="Tên đăng nhập"
              placeholder="Ví dụ: nguyenvana"
              required
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          )}
          <Input
            label="Họ tên"
            placeholder="Nguyễn Văn An"
            required
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
          />
          <Input
            label="Email"
            placeholder="nhanvien@congty.com"
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <Input
            label="Số điện thoại"
            placeholder="0912345678"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </div>

        {!isEdit && (
          <Input
            label="Mật khẩu ban đầu"
            placeholder="Tối thiểu 8 ký tự, nhân viên sẽ tự đổi lại"
            type="password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            hint="Nhân viên sẽ phải đổi mật khẩu và thiết lập xác thực hai lớp ở lần đăng nhập đầu tiên."
          />
        )}

        {isEdit && (
          <div>
            <p className="mb-1.5 text-sm font-medium text-ink-700">Trạng thái</p>
            <div className="flex gap-2">
              {(['ACTIVE', 'INACTIVE'] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={form.status === value ? 'primary' : 'outline'}
                  onClick={() => setForm({ ...form, status: value })}
                >
                  {STAFF_STATUS[value].label}
                </Button>
              ))}
            </div>
            {/* BR-534 — nghỉ việc thì đặt INACTIVE, không xoá bản ghi. */}
            <p className="mt-1.5 text-xs text-ink-500">
              Nhân viên nghỉ việc được đặt “Đã nghỉ”, bản ghi vẫn giữ để không mất liên kết với nhật
              ký hệ thống và bài viết đã đăng.
            </p>
          </div>
        )}

        <div>
          <p className="mb-1.5 text-sm font-medium text-ink-700">
            Vai trò <span className="text-red-500">*</span>
          </p>
          <div className="space-y-1.5">
            {roles.map((role) => (
              <Checkbox
                key={role.code}
                checked={form.role_codes.includes(role.code)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    role_codes: e.target.checked
                      ? [...form.role_codes, role.code]
                      : form.role_codes.filter((c) => c !== role.code),
                  })
                }
                label={
                  <span>
                    <span className="font-medium">{role.name}</span>
                    {role.description && (
                      <span className="block text-xs text-ink-500">{role.description}</span>
                    )}
                  </span>
                }
              />
            ))}
          </div>
        </div>

        {rolesChanged && (
          <Textarea
            label="Lý do thay đổi phân quyền"
            placeholder="Ghi rõ lý do để phục vụ đối soát về sau"
            required
            rows={2}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            hint="Thay đổi phân quyền bắt buộc ghi nhật ký kèm lý do."
          />
        )}
      </div>
    </Modal>
  );
}

function RoleMatrix({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const { data: roles, isLoading, refresh } = useApiQuery<Role[]>(`${ADMIN}/roles`);
  const { data: permissions } = useApiQuery<Permission[]>(`${ADMIN}/permissions`);
  const [editing, setEditing] = useState<Role | null>(null);

  if (isLoading) return <Spinner label="Đang tải…" />;

  const byModule = (permissions ?? []).reduce<Record<string, Permission[]>>((acc, perm) => {
    (acc[perm.module] ??= []).push(perm);
    return acc;
  }, {});

  const MODULE_LABEL: Record<string, string> = {
    dashboard: 'Dashboard & báo cáo',
    content: 'Bài viết',
    document: 'Tài liệu',
    customer: 'Khách hàng',
    strategy: 'Chiến lược & tín hiệu',
    ops: 'Vận hành',
    system: 'Hệ thống',
  };

  return (
    <div className="space-y-4">
      {roles?.map((role) => (
        <Card key={role.id}>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                {role.name}
                <Badge tone={role.code === 'SUPER_ADMIN' ? 'purple' : 'gray'}>{role.code}</Badge>
              </span>
            }
            description={role.description ?? undefined}
            action={
              canManage && role.code !== 'SUPER_ADMIN' ? (
                <Button size="sm" variant="outline" onClick={() => setEditing(role)}>
                  Sửa quyền
                </Button>
              ) : undefined
            }
          />
          <div className="flex flex-wrap gap-1.5">
            {role.permissions.map((code) => (
              <span
                key={code}
                className="rounded bg-ink-100 px-2 py-0.5 text-xs text-ink-600"
                title={permissions?.find((p) => p.code === code)?.name}
              >
                {permissions?.find((p) => p.code === code)?.name ?? code}
              </span>
            ))}
          </div>
        </Card>
      ))}

      {editing && (
        <RolePermissionEditor
          role={editing}
          byModule={byModule}
          moduleLabel={MODULE_LABEL}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            toast.success(message);
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function RolePermissionEditor({
  role,
  byModule,
  moduleLabel,
  onClose,
  onSaved,
}: {
  role: Role;
  byModule: Record<string, Permission[]>;
  moduleLabel: Record<string, string>;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>(role.permissions);
  const [reason, setReason] = useState('');

  const save = useApiMutation<Message, void>(() =>
    api.put<Message>(
      `${ADMIN}/roles/${role.id}/permissions`,
      selected,
      { reason },
    ),
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={`Quyền của vai trò: ${role.name}`}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={save.loading}
            disabled={reason.trim().length < 3}
            onClick={async () => {
              const result = await save.mutate();
              if (result) onSaved(result.message);
            }}
          >
            Lưu quyền
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.error && <Alert tone="danger">{save.error.message}</Alert>}

        {Object.entries(byModule).map(([module, perms]) => (
          <div key={module}>
            <p className="mb-1.5 text-sm font-semibold text-ink-700">
              {moduleLabel[module] ?? module}
            </p>
            <div className="grid gap-1 sm:grid-cols-2">
              {perms.map((perm) => (
                <Checkbox
                  key={perm.code}
                  checked={selected.includes(perm.code)}
                  onChange={(e) =>
                    setSelected((current) =>
                      e.target.checked
                        ? [...current, perm.code]
                        : current.filter((c) => c !== perm.code),
                    )
                  }
                  label={perm.name}
                />
              ))}
            </div>
          </div>
        ))}

        <Textarea
          label="Lý do thay đổi"
          placeholder="Ghi rõ lý do để phục vụ đối soát về sau"
          required
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="Thay đổi phân quyền bắt buộc ghi nhật ký kèm lý do."
        />
      </div>
    </Modal>
  );
}
