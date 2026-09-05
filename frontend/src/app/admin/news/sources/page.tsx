'use client';

/**
 * Nguồn tin tự động — khai báo trang chuyên mục để job dò bài mới mỗi ngày.
 *
 * Màn này tồn tại vì một lý do vận hành hơn là vì tính năng: bộ dò link hỏng theo kiểu **im
 * lặng** — trang nguồn đổi giao diện thì nó vẫn chạy, vẫn báo xong, chỉ là không ra bài nào.
 * Nên trạng thái lượt chạy gần nhất là phần quan trọng nhất của màn, không phải danh sách nguồn.
 *
 * Bố cục: phần đầu (nút, tiến trình) và phân trang đứng yên, chỉ danh sách nguồn cuộn.
 */

import { useState } from 'react';
import Link from 'next/link';

import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Icon,
  InfoButton,
  Input,
  Modal,
  Pagination,
  Select,
  Spinner,
} from '@/components/ui';
import { fieldError, useApiMutation, useApiQuery, usePagination, useStaffSession, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { formatDateTime } from '@/lib/datetime';
import { formatNumber } from '@/lib/format';
import type { Message, NewsSource, Page } from '@/types';

/** Hai trạng thái nghĩa là lượt chạy còn dở — giao diện làm mới liên tục khi thấy chúng. */
const BUSY = ['PENDING', 'RUNNING'];

const isBusy = (source: NewsSource) => BUSY.includes(source.last_status ?? '');

type FormState = {
  name: string;
  url: string;
  is_active: boolean;
  max_items: string;
};

const EMPTY: FormState = { name: '', url: '', is_active: true, max_items: '15' };

function toForm(source: NewsSource): FormState {
  return {
    name: source.name,
    url: source.url,
    is_active: source.is_active,
    max_items: String(source.max_items),
  };
}

function SourceEditor({
  source,
  onClose,
  onSaved,
}: {
  source: NewsSource | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = source !== null;
  const [form, setForm] = useState<FormState>(source ? toForm(source) : EMPTY);

  const save = useApiMutation<Message | { id: number; message: string }, Record<string, unknown>>(
    (body) =>
      isEdit
        ? api.put<Message>(`${ADMIN}/news/sources/${source.id}`, body)
        : api.post<{ id: number; message: string }>(`${ADMIN}/news/sources`, body),
  );

  const validUrl = /^https?:\/\/\S+$/i.test(form.url.trim());

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? 'Sửa nguồn tin' : 'Thêm nguồn tin'}
      description="Dán đường dẫn trang chuyên mục của báo — nơi họ liệt kê các bài mới nhất."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={save.loading}
            disabled={form.name.trim().length < 2 || !validUrl}
            onClick={async () => {
              const result = await save.mutate({
                name: form.name.trim(),
                url: form.url.trim(),
                is_active: form.is_active,
                max_items: Number(form.max_items) || 10,
              });
              if (result) onSaved((result as Message).message);
            }}
          >
            {isEdit ? 'Lưu' : 'Thêm nguồn'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.error && <Alert tone="danger">{save.error.message}</Alert>}

        <Input
          label="Đường dẫn trang chuyên mục"
          required
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
          placeholder="https://cafef.vn/thi-truong-chung-khoan.chn"
          error={
            form.url && !validUrl
              ? 'Đường dẫn phải bắt đầu bằng http:// hoặc https://'
              : fieldError(save.error, 'url')
          }
          hint="Trang liệt kê bài của báo, không phải một bài cụ thể. Báo nào có địa chỉ RSS thì dán RSS — chắc chắn hơn."
        />

        <Input
          label="Tên nguồn"
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          maxLength={120}
          placeholder="CafeF"
          hint="Tên này hiện dưới tiêu đề mỗi tin ở site khách hàng."
          error={fieldError(save.error, 'name')}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Số bài quét mỗi lượt"
            type="number"
            min={1}
            max={50}
            value={form.max_items}
            onChange={(e) => setForm({ ...form, max_items: e.target.value })}
            hint="Trần số bài mở ra xem, không phải số tin sẽ lấy — chỉ bài đăng trong ngày hôm nay mới được lấy. Để 15 là đủ cho một chuyên mục bình thường."
            error={fieldError(save.error, 'max_items')}
          />
          <Select
            label="Trạng thái"
            value={form.is_active ? '1' : '0'}
            onChange={(e) => setForm({ ...form, is_active: e.target.value === '1' })}
            options={[
              { value: '1', label: 'Đang kéo tin' },
              { value: '0', label: 'Tạm dừng' },
            ]}
          />
        </div>
      </div>
    </Modal>
  );
}

/** Trạng thái lượt chạy gần nhất của một nguồn, kèm lý do khi hỏng. */
function StatusLine({ source }: { source: NewsSource }) {
  if (source.last_status === 'PENDING') {
    return (
      <Badge tone="gray" dot>
        Đang chờ
      </Badge>
    );
  }

  if (source.last_status === 'RUNNING') {
    return (
      <span className="inline-flex items-center gap-2">
        <Badge tone="blue">
          <Icon name="spinner" size={12} className="animate-spin" />
          Đang kéo…
        </Badge>
      </span>
    );
  }

  if (!source.last_fetched_at) {
    return <span className="text-sm text-ink-500">Chưa chạy lần nào</span>;
  }

  const tone =
    source.last_status === 'SUCCESS' ? 'green' : source.last_status === 'FAILED' ? 'red' : 'amber';
  const label =
    source.last_status === 'SUCCESS'
      ? 'Hoàn thành'
      : source.last_status === 'FAILED'
        ? 'Không ra bài'
        : 'Hoàn thành, có bài lỗi';

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{label}</Badge>
        {source.last_status !== 'FAILED' && (
          <span className="text-xs text-ink-600">
            {source.last_added > 0
              ? `+${source.last_added} tin hôm nay`
              : 'hôm nay chưa có tin mới'}
          </span>
        )}
        <span className="text-xs text-ink-500">{formatDateTime(source.last_fetched_at)}</span>
      </div>
      {source.last_error && (
        <p className="text-xs leading-relaxed text-red-600">{source.last_error}</p>
      )}
    </div>
  );
}

/**
 * Thanh tiến trình của lượt đang chạy.
 *
 * "Một lượt" = các nguồn có cùng `last_started_at`; backend đóng chung một mốc cho cả mẻ đúng
 * để chỗ này gom lại được mà không cần giữ trạng thái riêng ở trình duyệt.
 */
function RunProgress({ items }: { items: NewsSource[] }) {
  const stamps = items.map((s) => s.last_started_at).filter((s): s is string => s !== null);
  if (!stamps.length) return null;

  const latest = stamps.reduce((a, b) => (a > b ? a : b));
  const batch = items.filter((s) => s.last_started_at === latest);
  if (!batch.some(isBusy)) return null;

  const done = batch.filter((s) => !isBusy(s)).length;
  const running = batch.find((s) => s.last_status === 'RUNNING');
  const percent = Math.round((done / batch.length) * 100);

  return (
    <Card className="border-blue-200 bg-blue-50/60">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
          <Icon name="spinner" size={15} className="animate-spin text-blue-600" />
          Đang kéo tin — xong {done}/{batch.length} nguồn
        </p>
        <p className="text-xs text-ink-600">
          {running ? `Đang đọc: ${running.name}` : 'Đang chuẩn bị…'}
        </p>
      </div>

      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-blue-100"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-blue-600 transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>

      <p className="mt-2 text-xs leading-relaxed text-ink-600">
        Mỗi nguồn phải mở từng bài để đọc tiêu đề và ảnh, nên một lượt mất khoảng vài chục giây
        tới vài phút. Rời khỏi trang không làm dừng lượt kéo.
      </p>
    </Card>
  );
}

export default function AdminNewsSourcesPage() {
  const toast = useToast();
  const { can } = useStaffSession();

  const [editing, setEditing] = useState<{ source: NewsSource | null } | null>(null);
  const [deleting, setDeleting] = useState<NewsSource | null>(null);
  const { page, size, setPage } = usePagination(20);

  // Chưa biết có lượt nào đang chạy hay không cho tới lần tải đầu, nên vòng lặp làm mới được
  // bật/tắt theo chính dữ liệu vừa nhận: còn nguồn nào dở thì hỏi lại sau 2,5 giây.
  const [busy, setBusy] = useState(false);
  const { data, isLoading, refresh } = useApiQuery<Page<NewsSource>>(
    `${ADMIN}/news/sources`,
    { page, size },
    {
      refreshInterval: busy ? 2500 : 0,
      onSuccess: (result) => setBusy(result.items.some(isBusy)),
    },
  );

  const remove = useApiMutation<Message, number>((id) =>
    api.del<Message>(`${ADMIN}/news/sources/${id}`),
  );
  const syncAll = useApiMutation<Message, void>(() => api.post<Message>(`${ADMIN}/news/sync`));
  const syncOne = useApiMutation<Message, number>((id) =>
    api.post<Message>(`${ADMIN}/news/sources/${id}/sync`),
  );

  const canEdit = can('content.create');
  const items = data?.items ?? [];
  const activeCount = items.filter((s) => s.is_active).length;

  /** Hai nút chạy tay dùng chung một đường: gọi API, báo kết quả, rồi làm mới ngay lập tức. */
  const trigger = async (run: () => Promise<Message | null>, fallback: string) => {
    const result = await run();
    if (result) {
      toast.success(result.message);
      // Backend đã đánh dấu "đang chờ" ngay trong request, nên lần làm mới này thấy tiến trình
      // luôn — và chính nó bật vòng lặp tự làm mới.
      await refresh();
    } else {
      toast.error(fallback);
    }
  };

  return (
    <div className="flex h-full flex-col space-y-4">
      {/*
        Không lặp lại tiêu đề màn: khung quản trị đã ghi tên màn trên thanh đầu trang. Một hàng
        công cụ, rồi tới thanh tiến trình — chỉ hiện khi có lượt đang chạy.
      */}
      <div className="shrink-0 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/admin/news"
            className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-ink-600 underline underline-offset-2 hover:text-ink-900"
          >
            <Icon name="external" size={14} />
            Tin đã kéo về
          </Link>
          <Link
            href="/admin/settings"
            className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-ink-600 underline underline-offset-2 hover:text-ink-900"
          >
            <Icon name="clock" size={14} />
            Đổi giờ kéo tin hằng ngày
          </Link>

          <div className="ml-auto flex items-center gap-2">
            <InfoButton
              info={
                <>
                  <p>
                    Mỗi ngày vào giờ đặt ở{' '}
                    <strong>Cấu hình hệ thống → Tin tức dẫn nguồn</strong>, hệ thống mở từng trang
                    trong danh sách này, tìm các bài mới rồi thêm vào danh sách tin. Tin kéo về
                    hiện luôn ở site khách hàng, không qua bước duyệt. Máy chủ phải đang bật vào
                    đúng giờ đó thì job mới chạy.
                  </p>
                  <p>
                    <strong>Chỉ lấy bài đăng trong ngày hôm nay</strong> (theo giờ Việt Nam), lấy
                    theo ngày chứ không theo số lượng — nên nguồn ít bài cũng không kéo về tin cũ,
                    và hôm nhiều tin cũng không bị cắt bớt. Ô <em>Số bài quét mỗi lượt</em> chỉ là
                    trần an toàn cho số bài phải mở ra xem. Vì vậy đặt giờ chạy vào cuối ngày thì
                    mẻ kéo mới bắt được trọn ngày tin.
                  </p>
                  <p>
                    Chỉ lấy <strong>tiêu đề, mô tả ngắn, ảnh đại diện và ngày đăng</strong> — đúng
                    những gì trang nguồn tự khai để được chia sẻ lại. Không lấy thân bài: lưu toàn
                    văn là đăng lại nội dung của người khác trên tên miền của mình. Khách bấm vào
                    tin vẫn sang thẳng trang gốc.
                  </p>
                  <p>
                    <strong>Không thêm tin trùng.</strong> Cùng một bài gặp lại ở lượt sau, nằm
                    hai lần trên một trang, hay bạn đã tự dán tay trước đó — đều bị bỏ qua. Nhiều
                    báo cùng đăng lại một bản tin với đúng tiêu đề thì cũng chỉ lấy bài đầu tiên.
                  </p>
                  <p>
                    Dòng trạng thái dưới mỗi nguồn là chỗ cần nhìn. Trang nguồn đổi giao diện thì
                    bộ dò không báo lỗi mà chỉ ngừng tìm thấy bài — nên một lượt chạy không ra bài
                    nào được tính là <em>hỏng</em> và hiện đỏ ở đây.
                  </p>
                </>
              }
            />
            {canEdit && (
              <>
                <Button
                  variant="outline"
                  loading={syncAll.loading}
                  disabled={activeCount === 0 || busy}
                  leftIcon={<Icon name="refresh" size={16} />}
                  onClick={() =>
                    trigger(() => syncAll.mutate(), syncAll.error?.message ?? 'Không chạy được')
                  }
                >
                  {busy ? 'Đang kéo…' : 'Kéo tin ngay'}
                </Button>
                <Button
                  onClick={() => setEditing({ source: null })}
                  leftIcon={<Icon name="plus" size={16} />}
                >
                  Thêm nguồn
                </Button>
              </>
            )}
          </div>
        </div>

        <RunProgress items={items} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {isLoading ? (
          <div className="py-16">
            <Spinner label="Đang tải danh sách nguồn…" />
          </div>
        ) : !items.length ? (
          <EmptyState
            title="Chưa khai báo nguồn nào"
            description="Bấm Thêm nguồn rồi dán đường dẫn trang chuyên mục của báo, ví dụ https://cafef.vn/thi-truong-chung-khoan.chn"
          />
        ) : (
          <div className="space-y-3 pb-1">
            {items.map((source) => (
              <Card key={source.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-ink-900">{source.name}</h3>
                      {source.is_active ? (
                        <Badge tone="green">Đang kéo tin</Badge>
                      ) : (
                        <Badge tone="gray">Tạm dừng</Badge>
                      )}
                      <span className="text-xs text-ink-500">
                        {formatNumber(source.item_count)} tin đã lấy · tối đa {source.max_items}{' '}
                        bài/lượt
                      </span>
                    </div>

                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex max-w-full items-center gap-1 truncate text-xs text-ink-500 underline underline-offset-2 hover:text-ink-900"
                    >
                      <Icon name="external" size={13} className="shrink-0" />
                      <span className="truncate">{source.url}</span>
                    </a>

                    <StatusLine source={source} />
                  </div>

                  {canEdit && (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={syncOne.loading}
                        disabled={busy}
                        onClick={() =>
                          trigger(
                            () => syncOne.mutate(source.id),
                            syncOne.error?.message ?? 'Không chạy được',
                          )
                        }
                      >
                        Kéo thử
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ source })}>
                        Sửa
                      </Button>
                      {can('content.delete') && (
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(source)}>
                          Xoá
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {data && data.items.length > 0 && (
        <div className="shrink-0">
          <Pagination
            page={data.page}
            pages={data.pages}
            total={data.total}
            size={data.size}
            onPageChange={setPage}
          />
        </div>
      )}

      {editing && (
        <SourceEditor
          source={editing.source}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            toast.success(message);
            refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Xoá nguồn tin này?"
        message={`Ngừng kéo tin từ "${deleting?.name ?? ''}". Các tin đã lấy về vẫn giữ nguyên trên site khách hàng — muốn gỡ thì vào danh sách tin và tắt từng tin.`}
        confirmLabel="Xoá nguồn"
        danger
        loading={remove.loading}
        onConfirm={async () => {
          if (!deleting) return;
          const result = await remove.mutate(deleting.id);
          setDeleting(null);
          if (result) {
            toast.success(result.message);
            refresh();
          } else {
            toast.error(remove.error?.message ?? 'Không xoá được nguồn');
          }
        }}
      />
    </div>
  );
}
