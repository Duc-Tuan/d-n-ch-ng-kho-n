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
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Pagination,
  Spinner,
  Textarea,
} from '@/components/ui';
import { useApiMutation, useApiQuery, usePagination, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { formatDate, fromInputDateTime, toInputDateTime } from '@/lib/datetime';
import { formatNumber, formatPercent } from '@/lib/format';
import type { LegalDocument, Message, Page } from '@/types';

const TYPE_LABEL: Record<string, string> = {
  TOS: 'Điều khoản sử dụng',
  PRIVACY: 'Chính sách bảo mật',
  REFUND: 'Chính sách thanh toán & hoàn tiền',
  DISCLAIMER: 'Tuyên bố miễn trừ trách nhiệm',
  COOKIE: 'Chính sách cookie',
  NAV_CONSENT: 'Đồng ý truy xuất dữ liệu NAV',
  TELEGRAM_CONSENT: 'Đồng ý nhận tín hiệu qua Telegram',
};

export default function LegalPage() {
  const toast = useToast();
  const [creating, setCreating] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<LegalDocument | null>(null);
  const [viewing, setViewing] = useState<LegalDocument | null>(null);

  const { page, size, setPage, setSize } = usePagination(50);
  const { data, isLoading, refresh } = useApiQuery<Page<LegalDocument>>(`${ADMIN}/legal`, {
    page,
    size,
  });

  const publish = useApiMutation<Message, number>((id) =>
    api.post<Message>(`${ADMIN}/legal/${id}/publish`),
  );

  const byType = (data?.items ?? []).reduce<Record<string, LegalDocument[]>>((acc, doc) => {
    (acc[doc.type] ??= []).push(doc);
    return acc;
  }, {});

  if (isLoading) return <Spinner label="Đang tải…" />;

  return (
    <div className="flex h-full flex-col space-y-3">
      <PageHeader
        title="Văn bản pháp lý"
        description="Soạn phiên bản mới, đặt ngày hiệu lực và theo dõi tỷ lệ đồng ý"
        infoTitle="Vì sao quản lý theo phiên bản"
        info={
          <>
            {/* BR-801 — lưu bằng dữ liệu có phiên bản, không phải file HTML tĩnh. */}
            <p>
              Khi có tranh chấp, bạn phải chứng minh được khách hàng đã đồng ý với{' '}
              <strong>đúng phiên bản nào, vào lúc nào</strong>. Vì vậy mỗi lần sửa nội dung phải
              tạo phiên bản mới thay vì sửa đè bản đang hiệu lực.
            </p>
            <p className="text-amber-700">
              <strong>Nội dung mẫu cần được luật sư rà soát.</strong> Bộ văn bản khởi tạo là bản
              nháp kỹ thuật để hệ thống vận hành được. Nội dung pháp lý — đặc biệt là điều kiện duy
              trì tài khoản và chính sách hoàn tiền — cần luật sư chuyên ngành chứng khoán rà soát
              trước khi vận hành thật.
            </p>
          </>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
        {Object.keys(TYPE_LABEL).map((type) => {
          const versions = byType[type] ?? [];
          const current = versions.find((v) => v.is_current);

          return (
            <Card key={type}>
              <CardHeader
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {TYPE_LABEL[type]}
                    {current ? (
                      <Badge tone="green">Đang hiệu lực: v{current.version}</Badge>
                    ) : (
                      <Badge tone="red">Chưa ban hành</Badge>
                    )}
                  </span>
                }
                description={
                  current ? `Hiệu lực từ ${formatDate(current.effective_from)}` : undefined
                }
                action={
                  <Button size="sm" variant="outline" onClick={() => setCreating(type)}>
                    + Phiên bản mới
                  </Button>
                }
              />

              {versions.length ? (
                <ul className="divide-y divide-ink-100">
                  {versions.map((doc) => (
                    <li key={doc.id} className="flex flex-wrap items-center gap-3 py-2.5">
                      <span className="text-sm font-medium text-ink-900">v{doc.version}</span>
                      <span className="text-xs text-ink-500">
                        Hiệu lực {formatDate(doc.effective_from)}
                      </span>
                      {doc.is_current && <Badge tone="green">Đang dùng</Badge>}
                      {doc.requires_reconsent && (
                        <Badge tone="amber">Yêu cầu đồng ý lại</Badge>
                      )}

                      <div className="ml-auto flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setViewing(doc)}>
                          Xem
                        </Button>
                        {!doc.is_current && (
                          <Button size="sm" variant="outline" onClick={() => setPublishing(doc)}>
                            Ban hành
                          </Button>
                        )}
                        {doc.is_current && <ConsentStats documentId={doc.id} />}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-center text-sm text-ink-500">
                  Chưa có phiên bản nào cho loại văn bản này
                </p>
              )}
            </Card>
          );
        })}

        {/* Mỗi lần ban hành sinh thêm một phiên bản được giữ vĩnh viễn, nên danh sách chỉ dài ra. */}
        {data && (
          <Card>
            <Pagination
              page={data.page}
              pages={data.pages}
              total={data.total}
              size={data.size}
              onPageChange={setPage}
              onSizeChange={setSize}
              className="py-0"
            />
          </Card>
        )}
      </div>

      {creating && (
        <LegalEditor
          type={creating}
          typeLabel={TYPE_LABEL[creating]}
          onClose={() => setCreating(null)}
          onSaved={(message) => {
            toast.success(message);
            setCreating(null);
            refresh();
          }}
        />
      )}

      {viewing && (
        <Modal
          open
          onClose={() => setViewing(null)}
          title={`${TYPE_LABEL[viewing.type]} — v${viewing.version}`}
          size="xl"
        >
          <div className="prose-article whitespace-pre-wrap text-sm">{viewing.content}</div>
        </Modal>
      )}

      <ConfirmDialog
        open={Boolean(publishing)}
        onClose={() => setPublishing(null)}
        title="Ban hành phiên bản"
        message={
          <div className="space-y-2">
            <p>
              Ban hành <strong>{TYPE_LABEL[publishing?.type ?? '']} v{publishing?.version}</strong>?
              Phiên bản đang hiệu lực sẽ được thay thế.
            </p>
            {publishing?.requires_reconsent && (
              // BR-802 — thay đổi trọng yếu thì chặn màn và bắt đồng ý lại.
              <p className="text-amber-700">
                Phiên bản này được đánh dấu <strong>yêu cầu đồng ý lại</strong>. Khách hàng sẽ thấy
                màn hình chặn và phải đọc, đồng ý lại trước khi tiếp tục sử dụng dịch vụ.
              </p>
            )}
          </div>
        }
        confirmLabel="Ban hành"
        loading={publish.loading}
        onConfirm={async () => {
          if (!publishing) return;
          const result = await publish.mutate(publishing.id);
          if (result) {
            toast.success(result.message);
            setPublishing(null);
            refresh();
          }
        }}
      />
    </div>
  );
}

/** BR-805 — thống kê bao nhiêu khách hàng đã đồng ý phiên bản nào. */
function ConsentStats({ documentId }: { documentId: number }) {
  const { data } = useApiQuery<{ consented: number; total_users: number; rate: number }>(
    `${ADMIN}/legal/${documentId}/consents`,
  );

  if (!data) return null;

  return (
    <Badge tone={data.rate > 80 ? 'green' : 'amber'} title="Tỷ lệ khách hàng đã đồng ý">
      {formatNumber(data.consented)}/{formatNumber(data.total_users)} đồng ý (
      {formatPercent(data.rate)})
    </Badge>
  );
}

function LegalEditor({
  type,
  typeLabel,
  onClose,
  onSaved,
}: {
  type: string;
  typeLabel: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState({
    version: '',
    title: typeLabel,
    content: '',
    effective_from: toInputDateTime(new Date().toISOString()),
    requires_reconsent: false,
    summary_of_changes: '',
  });

  const save = useApiMutation<{ id: number; message: string }, Record<string, unknown>>((body) =>
    api.post(`${ADMIN}/legal`, body),
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={`Phiên bản mới — ${typeLabel}`}
      size="xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={save.loading}
            disabled={!form.version || form.content.length < 20}
            onClick={async () => {
              const result = await save.mutate({
                type,
                version: form.version,
                title: form.title,
                content: form.content,
                effective_from: fromInputDateTime(form.effective_from),
                requires_reconsent: form.requires_reconsent,
                summary_of_changes: form.summary_of_changes || null,
              });
              if (result) onSaved(result.message);
            }}
          >
            Lưu bản nháp
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.error && <Alert tone="danger">{save.error.message}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Số phiên bản"
            required
            value={form.version}
            onChange={(e) => setForm({ ...form, version: e.target.value })}
            placeholder="1.1"
          />
          <Input
            label="Ngày hiệu lực"
            type="datetime-local"
            required
            value={form.effective_from}
            onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
          />
        </div>

        <Input
          label="Tiêu đề"
          placeholder="Ví dụ: Điều khoản sử dụng dịch vụ"
          required
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />

        <Textarea
          label="Nội dung"
          placeholder="Dán toàn văn văn bản pháp lý vào đây"
          required
          rows={16}
          value={form.content}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
          className="font-mono text-xs"
          hint="Hỗ trợ định dạng markdown đơn giản. Xuống dòng được giữ nguyên khi hiển thị."
        />

        <Textarea
          label="Tóm tắt thay đổi"
          placeholder="Nêu ngắn gọn khác gì so với phiên bản trước"
          rows={2}
          value={form.summary_of_changes}
          onChange={(e) => setForm({ ...form, summary_of_changes: e.target.value })}
          hint="Hiển thị cho khách hàng khi yêu cầu đồng ý lại."
        />

        <Checkbox
          checked={form.requires_reconsent}
          onChange={(e) => setForm({ ...form, requires_reconsent: e.target.checked })}
          label={
            <>
              Yêu cầu khách hàng đồng ý lại
              <span className="block text-xs text-ink-500">
                Bật khi có thay đổi trọng yếu — đặc biệt là điều kiện duy trì tài khoản hoặc chính
                sách hoàn tiền. Cần thông báo trước tối thiểu 15 ngày.
              </span>
            </>
          }
        />
      </div>
    </Modal>
  );
}
