'use client';

/**
 * Tài liệu của chiến lược cá nhân — khách hàng tự tải lên.
 *
 * Khác hẳn kho tài liệu chung: file ở đây thuộc về **một khách hàng**, không vào kho công ty,
 * không ràng bậc gói, và chỉ chủ sở hữu cùng người được chia sẻ chiến lược mới thấy (BR-850).
 * Máy chủ giữ ranh giới đó bằng cột `documents.owner_user_id`.
 */

import { useRef, useState } from 'react';

import { Alert, Button, Card, CardHeader, ConfirmDialog, Icon, Spinner } from '@/components/ui';
import { useApiMutation, useApiQuery, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { formatDate } from '@/lib/datetime';
import { formatFileSize } from '@/lib/format';
import type { Message } from '@/types';

type StrategyDoc = {
  id: number;
  title: string;
  original_name: string;
  file_size: number;
  mime_type: string;
  created_at: string;
};

/** Cùng whitelist với `storage_service.MIME_BY_EXT` ở máy chủ. */
const ACCEPT = '.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg';

export function PersonalDocuments({
  strategyId,
  canEdit,
}: {
  strategyId: number;
  canEdit: boolean;
}) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState<StrategyDoc | null>(null);

  const { data, isLoading, refresh } = useApiQuery<StrategyDoc[]>(
    `${CUSTOMER}/my-strategies/${strategyId}/documents`,
  );

  const remove = useApiMutation<Message, number>((documentId) =>
    api.del<Message>(`${CUSTOMER}/my-strategies/${strategyId}/documents/${documentId}`),
  );

  const upload = async (files: File[]) => {
    setUploading(true);
    let failed = 0;
    // Tải lần lượt chứ không song song: mỗi file là một lượt ghi đĩa cộng một dòng CSDL, và
    // trần số tài liệu được kiểm ở máy chủ theo từng lượt — bắn song song thì vượt trần mà
    // không lượt nào biết.
    for (const file of files) {
      const body = new FormData();
      body.append('file', file);
      body.append('title', file.name.replace(/\.[^.]+$/, ''));
      try {
        await api.upload<{ id: number }>(
          `${CUSTOMER}/my-strategies/${strategyId}/documents`,
          body,
        );
      } catch (err) {
        failed += 1;
        toast.error(`${file.name} — ${(err as Error).message || 'không tải lên được'}`);
      }
    }
    setUploading(false);
    await refresh();
    if (failed < files.length) toast.success('Đã tải tài liệu lên chiến lược');
  };

  return (
    <Card>
      <CardHeader
        title="Tài liệu chiến lược"
        description="AI đọc những tài liệu này khi bạn bấm Phân tích. Chỉ bạn và người được bạn chia sẻ mới xem được."
        action={
          canEdit ? (
            <Button
              size="sm"
              variant="outline"
              loading={uploading}
              leftIcon={<Icon name="upload" size={15} />}
              onClick={() => fileInput.current?.click()}
            >
              Tải tài liệu lên
            </Button>
          ) : undefined
        }
      />

      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          // Xoá giá trị để chọn lại đúng file vừa rồi vẫn kích hoạt onChange.
          e.target.value = '';
          if (picked.length) void upload(picked);
        }}
      />

      <Alert tone="info" className="mb-3">
        Chỉ <strong>PDF có lớp văn bản</strong> mới được đọc. PDF bản quét ảnh và các định dạng
        khác vẫn lưu được nhưng sẽ bị bỏ qua khi phân tích — tài liệu càng đầy đủ thì nhận định
        càng bám sát cách bạn giao dịch.
      </Alert>

      {isLoading ? (
        <div className="py-8">
          <Spinner label="Đang tải danh sách…" />
        </div>
      ) : !data?.length ? (
        <p className="rounded-lg border border-dashed border-ink-300 px-3 py-8 text-center text-sm text-ink-500">
          {canEdit
            ? 'Chưa có tài liệu nào. Tải lên ít nhất một file để phân tích có căn cứ.'
            : 'Chủ sở hữu chưa tải tài liệu nào lên chiến lược này.'}
        </p>
      ) : (
        <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
          {data.map((doc) => (
            <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <Icon name="document" size={18} className="shrink-0 text-ink-400" />
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink-900">{doc.title}</p>
                  <p className="truncate text-xs text-ink-500">
                    {doc.original_name} · {formatFileSize(doc.file_size)} ·{' '}
                    {formatDate(doc.created_at)}
                  </p>
                </div>
              </div>
              {canEdit && (
                <Button size="sm" variant="ghost" onClick={() => setRemoving(doc)}>
                  <Icon name="trash" size={15} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Gỡ tài liệu khỏi chiến lược?"
        message={`"${removing?.title ?? ''}" sẽ bị xoá khỏi chiến lược và không còn được dùng khi phân tích. Các bản phân tích đã có vẫn giữ nguyên.`}
        confirmLabel="Gỡ tài liệu"
        danger
        loading={remove.loading}
        onConfirm={async () => {
          if (!removing) return;
          const result = await remove.mutate(removing.id);
          setRemoving(null);
          if (result) {
            toast.success(result.message);
            await refresh();
          } else {
            toast.error(remove.error?.message ?? 'Không gỡ được tài liệu');
          }
        }}
      />
    </Card>
  );
}
