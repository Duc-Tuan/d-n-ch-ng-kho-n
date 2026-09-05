'use client';

import { useRef, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Icon,
  Input,
  Modal,
  PageHeader,
  Pagination,
  RowAction,
  SearchInput,
  Select,
  Spinner,
  Table,
  Textarea,
  type Column,
} from '@/components/ui';
import { useAction, useApiQuery, useConfirmAction, useList, useStaffSession, useToast } from '@/hooks';
import { ADMIN, PUBLIC, api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/datetime';
import { formatFileSize, formatNumber } from '@/lib/format';
import type { Category, DocumentItem, Message, Package, Page } from '@/types';

export default function AdminDocumentsPage() {
  const toast = useToast();
  const { can } = useStaffSession();

  const [uploading, setUploading] = useState(false);
  const [viewingLogs, setViewingLogs] = useState<DocumentItem | null>(null);
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');

  const { data: categories } = useApiQuery<Category[]>(`${ADMIN}/categories`, {
    type: 'DOCUMENT',
  });

  const list = useList<DocumentItem>(`${ADMIN}/documents`, {
    q: search || undefined,
    category_id: categoryId || undefined,
  });

  const remove = useConfirmAction<DocumentItem, Message>(
    (doc, reason) => api.del<Message>(`${ADMIN}/documents/${doc.id}`, { reason }),
    { onSuccess: list.refresh },
  );

  const columns: Column<DocumentItem>[] = [
    {
      key: 'title',
      header: 'Tài liệu',
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-ink-900">{row.title}</p>
          <p className="text-xs text-ink-500">
            {row.category_name} · {row.original_name}
          </p>
        </div>
      ),
    },
    { key: 'size', header: 'Dung lượng', render: (row) => formatFileSize(row.file_size), hideOnMobile: true },
    {
      key: 'package',
      header: 'Gói tối thiểu',
      render: (row) => (row.min_package_id ? <Badge tone="amber">Có giới hạn</Badge> : '—'),
      hideOnMobile: true,
    },
    {
      key: 'downloads',
      header: 'Lượt tải',
      render: (row) => formatNumber(row.download_count),
      align: 'right',
    },
    { key: 'created', header: 'Ngày tải lên', render: (row) => formatDate(row.created_at), hideOnMobile: true },
    {
      key: 'actions',
      header: 'Hành động',
      width: '8rem',
      align: 'right',
      sticky: 'right',
      render: (row) => (
        <div className="flex justify-center gap-0.5">
          <RowAction
            label="Lịch sử tải xuống"
            icon={<Icon name="clock" size={16} />}
            onClick={() => setViewingLogs(row)}
          />
          {can('doc.delete') && (
            <RowAction
              label="Xoá tài liệu"
              icon={<Icon name="trash" size={16} />}
              danger
              onClick={() => remove.ask(row)}
            />
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex h-full flex-col space-y-3">
      <PageHeader
        title="Kho tài liệu"
        description="Tài liệu phân tích cho khách hàng tải xuống"
        infoTitle="Cơ chế bảo vệ tài liệu"
        /* BR-510/511/512 — nêu rõ cơ chế bảo vệ để nhân viên hiểu vì sao có các ràng buộc. */
        info={
          <p>
            File được lưu ngoài thư mục công khai và đổi tên khi lưu. Khách hàng tải xuống qua
            đường dẫn có hạn dùng ngắn, kèm kiểm tra quyền theo gói. File PDF được đóng dấu định
            danh (email và thời điểm tải) để truy vết nguồn phát tán. Mọi lượt tải đều được ghi
            nhật ký.
          </p>
        }
        action={
          can('doc.upload') ? <Button onClick={() => setUploading(true)}>+ Tải lên</Button> : undefined
        }
      />

      <div className="shrink-0 grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-end">
        <SearchInput
          placeholder="Tên tài liệu, tên file…"
          value={search}
          onSearch={(value) => {
            setSearch(value);
            list.reset();
          }}
        />
        <Select
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            list.reset();
          }}
          placeholder="Tất cả danh mục"
          options={(categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
        />
      </div>

      <Table
        {...list.tableProps}
        columns={columns}
        rowKey={(row) => row.id}
        emptyMessage="Không tìm thấy tài liệu nào khớp bộ lọc"
        fill
        minWidth="58rem"
      />

      {uploading && (
        <UploadModal
          onClose={() => setUploading(false)}
          onUploaded={(message) => {
            toast.success(message);
            setUploading(false);
            list.refresh();
          }}
        />
      )}

      {viewingLogs && (
        <DownloadLogs document={viewingLogs} onClose={() => setViewingLogs(null)} />
      )}

      <ConfirmDialog
        {...remove.dialogProps}
        title="Xoá tài liệu"
        message={`Xoá "${remove.target?.title}"? File sẽ bị xoá khỏi kho lưu trữ, nhật ký tải xuống vẫn được giữ.`}
        danger
        requireReason
      />
    </div>
  );
}

function UploadModal({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: (message: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({ title: '', description: '', category_id: '', min_package_id: '' });
  const [file, setFile] = useState<File | null>(null);

  const { data: categories } = useApiQuery<Category[]>(`${ADMIN}/categories`, { type: 'DOCUMENT' });
  const { data: packages } = useApiQuery<Package[]>(`${PUBLIC}/packages`);

  const upload = useAction<{ id: number; message: string }, FormData>(
    (formData: FormData) => api.upload(`${ADMIN}/documents`, formData),
    { toastError: false },  // form tự hiện lỗi ngay dưới ô chọn file
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Tải lên tài liệu"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={upload.loading}
            disabled={!file || !form.title || !form.category_id}
            onClick={async () => {
              if (!file) return;
              const formData = new FormData();
              formData.append('file', file);
              formData.append('title', form.title);
              formData.append('category_id', form.category_id);
              if (form.description) formData.append('description', form.description);
              if (form.min_package_id) formData.append('min_package_id', form.min_package_id);

              const result = await upload.run(formData);
              if (result) onUploaded(result.message);
            }}
          >
            Tải lên
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {upload.error && <Alert tone="danger">{upload.error.message}</Alert>}

        <div>
          <p className="mb-1.5 text-sm font-medium text-ink-700">
            File <span className="text-red-500">*</span>
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg"
            onChange={(e) => {
              const selected = e.target.files?.[0] ?? null;
              setFile(selected);
              if (selected && !form.title) {
                setForm((f) => ({ ...f, title: selected.name.replace(/\.[^.]+$/, '') }));
              }
            }}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-ink-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-ink-900"
          />
          <p className="mt-1.5 text-xs text-ink-500">
            Chấp nhận PDF, DOCX, XLSX, PPTX, PNG, JPG. Tối đa 50MB. Tên file sẽ được đổi khi lưu.
          </p>
          {file && (
            <p className="mt-1 text-xs text-ink-600">
              Đã chọn: {file.name} ({formatFileSize(file.size)})
            </p>
          )}
        </div>

        <Input
          label="Tên tài liệu"
          placeholder="Ví dụ: Báo cáo phân tích ngành thép quý 3"
          required
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Danh mục"
            required
            value={form.category_id}
            onChange={(e) => setForm({ ...form, category_id: e.target.value })}
            placeholder="— Chọn danh mục —"
            options={(categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
          <Select
            label="Gói tối thiểu để tải"
            value={form.min_package_id}
            onChange={(e) => setForm({ ...form, min_package_id: e.target.value })}
            placeholder="Mọi gói đều tải được"
            options={(packages ?? []).map((p) => ({ value: p.id, label: p.name }))}
          />
        </div>

        <Textarea
          label="Mô tả"
          placeholder="Tóm tắt nội dung để khách hàng biết tài liệu nói gì"
          rows={3}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </div>
    </Modal>
  );
}

function DownloadLogs({ document, onClose }: { document: DocumentItem; onClose: () => void }) {
  const { data, isLoading, setPage, setSize } = useList<any>(
    `${ADMIN}/documents/${document.id}/downloads`,
  );

  return (
    <Modal open onClose={onClose} title={`Lịch sử tải: ${document.title}`} size="lg">
      {isLoading ? (
        <Spinner label="Đang tải…" />
      ) : !data?.items.length ? (
        <p className="py-8 text-center text-sm text-ink-500">Chưa có lượt tải nào</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                {['Khách hàng', 'IP', 'Watermark', 'Thời điểm'].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium text-ink-600">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {data.items.map((log) => (
                <tr key={log.id}>
                  <td className="px-3 py-2">
                    <p className="font-medium">{log.full_name ?? `#${log.user_id}`}</p>
                    <p className="text-xs text-ink-500">{log.email}</p>
                  </td>
                  <td className="px-3 py-2 text-ink-600">{log.ip ?? '—'}</td>
                  <td className="px-3 py-2">
                    {log.watermarked ? <Badge tone="green">Có</Badge> : <Badge tone="gray">Không</Badge>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-500">
                    {formatDateTime(log.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <Pagination
            page={data.page}
            pages={data.pages}
            total={data.total}
            size={data.size}
            onPageChange={setPage}
            onSizeChange={setSize}
          />
        </div>
      )}
    </Modal>
  );
}
