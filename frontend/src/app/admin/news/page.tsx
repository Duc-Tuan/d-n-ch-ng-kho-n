'use client';

/**
 * Tin tức dẫn nguồn — danh sách tin, gồm cả tin nhập tay lẫn tin do job kéo về.
 *
 * Hệ thống chỉ giữ những gì hiển thị trên thẻ tin — tiêu đề, mô tả ngắn, ảnh, ngày đăng, đường
 * dẫn — chứ không lưu thân bài; khách bấm vào là sang thẳng trang gốc. Khai báo nguồn để kéo tự
 * động nằm ở màn `/admin/news/sources`.
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
  SearchInput,
  Select,
  Spinner,
  Textarea,
} from '@/components/ui';
import { fieldError, useApiMutation, useApiQuery, useDebounced, usePagination, useStaffSession, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { formatDate, formatDateTime, toInputDateTime, fromInputDateTime } from '@/lib/datetime';
import { formatNumber } from '@/lib/format';
import type { Message, NewsItem, Page } from '@/types';

type FormState = {
  title: string;
  summary: string;
  url: string;
  source_name: string;
  published_at: string;
  is_active: boolean;
  sort_order: string;
};

const EMPTY: FormState = {
  title: '',
  summary: '',
  url: '',
  source_name: '',
  published_at: '',
  is_active: true,
  sort_order: '0',
};

function toForm(item: NewsItem): FormState {
  return {
    title: item.title,
    summary: item.summary ?? '',
    url: item.url,
    source_name: item.source_name ?? '',
    published_at: item.published_at ? toInputDateTime(item.published_at) : '',
    is_active: item.is_active,
    sort_order: String(item.sort_order),
  };
}

function NewsEditor({
  item,
  onClose,
  onSaved,
}: {
  item: NewsItem | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = item !== null;
  const [form, setForm] = useState<FormState>(item ? toForm(item) : EMPTY);

  const save = useApiMutation<Message | { id: number; message: string }, Record<string, unknown>>(
    (body) =>
      isEdit
        ? api.put<Message>(`${ADMIN}/news/${item.id}`, body)
        : api.post<{ id: number; message: string }>(`${ADMIN}/news`, body),
  );

  const validUrl = /^https?:\/\/\S+$/i.test(form.url.trim());

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? 'Sửa tin' : 'Thêm tin dẫn nguồn'}
      description="Khách hàng chỉ thấy tiêu đề, mô tả ngắn và ngày đăng. Bấm vào tin là sang thẳng trang gốc."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={save.loading}
            disabled={form.title.trim().length < 3 || !validUrl}
            onClick={async () => {
              const result = await save.mutate({
                title: form.title.trim(),
                summary: form.summary.trim() || null,
                url: form.url.trim(),
                source_name: form.source_name.trim() || null,
                published_at: form.published_at
                  ? fromInputDateTime(form.published_at)
                  : null,
                is_active: form.is_active,
                sort_order: Number(form.sort_order) || 0,
              });
              if (result) onSaved((result as Message).message);
            }}
          >
            {isEdit ? 'Lưu' : 'Thêm tin'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.error && <Alert tone="danger">{save.error.message}</Alert>}

        <Input
          label="Đường dẫn bài gốc"
          required
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
          placeholder="https://cafef.vn/…"
          error={
            form.url && !validUrl
              ? 'Đường dẫn phải bắt đầu bằng http:// hoặc https://'
              : fieldError(save.error, 'url')
          }
          hint="Đây là nơi khách hàng được đưa tới khi bấm vào tin."
        />

        <Input
          label="Tiêu đề"
          required
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          maxLength={255}
          error={fieldError(save.error, 'title')}
        />

        <Textarea
          label="Mô tả ngắn"
          rows={3}
          value={form.summary}
          onChange={(e) => setForm({ ...form, summary: e.target.value })}
          maxLength={2000}
          hint="Vài câu tóm tắt để khách quyết định có bấm vào đọc hay không."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Tên nguồn"
            value={form.source_name}
            onChange={(e) => setForm({ ...form, source_name: e.target.value })}
            placeholder="CafeF"
            hint="Bỏ trống thì lấy tên miền của đường dẫn."
          />
          <Input
            label="Ngày đăng của bài gốc"
            type="datetime-local"
            value={form.published_at}
            onChange={(e) => setForm({ ...form, published_at: e.target.value })}
            hint="Ngày bài được đăng bên nguồn, không phải lúc bạn nhập vào đây."
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Trạng thái"
            value={form.is_active ? '1' : '0'}
            onChange={(e) => setForm({ ...form, is_active: e.target.value === '1' })}
            options={[
              { value: '1', label: 'Đang hiển thị' },
              { value: '0', label: 'Đã gỡ khỏi site khách' },
            ]}
          />
          <Input
            label="Thứ tự ghim"
            type="number"
            value={form.sort_order}
            onChange={(e) => setForm({ ...form, sort_order: e.target.value })}
            hint="Số lớn hơn đứng trước. Để 0 thì sắp theo ngày đăng."
          />
        </div>
      </div>
    </Modal>
  );
}

export default function AdminNewsPage() {
  const toast = useToast();
  const { can } = useStaffSession();

  const [editing, setEditing] = useState<{ item: NewsItem | null } | null>(null);
  const [deleting, setDeleting] = useState<NewsItem | null>(null);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [autoFilter, setAutoFilter] = useState('');
  const debounced = useDebounced(search);
  const { page, size, setPage, reset } = usePagination(20);

  const { data, isLoading, refresh } = useApiQuery<Page<NewsItem>>(`${ADMIN}/news`, {
    page,
    size,
    q: debounced || undefined,
    is_active: activeFilter === '' ? undefined : activeFilter === '1',
    auto: autoFilter === '' ? undefined : autoFilter === 'auto',
  });

  const remove = useApiMutation<Message, { id: number; reason: string }>(({ id, reason }) =>
    api.del<Message>(`${ADMIN}/news/${id}`, { reason }),
  );

  const canEdit = can('content.create');

  return (
    <div className="flex h-full flex-col space-y-4">
      {/*
        Không lặp lại tiêu đề màn: khung quản trị đã ghi tên màn trên thanh đầu trang. Ở đây chỉ
        còn một hàng công cụ — tìm kiếm và bộ lọc bên trái, nút thao tác bên phải.
      */}
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <SearchInput
          value={search}
          onSearch={(value) => {
            setSearch(value);
            reset();
          }}
          placeholder="Tìm theo tiêu đề hoặc nguồn…"
          className="min-w-[16rem] flex-1"
        />
        <Select
          value={autoFilter}
          onChange={(e) => {
            setAutoFilter(e.target.value);
            reset();
          }}
          placeholder="Mọi nguồn gốc"
          options={[
            { value: 'auto', label: 'Tin kéo tự động' },
            { value: 'manual', label: 'Tin nhập tay' },
          ]}
          className="w-44"
        />
        <Select
          value={activeFilter}
          onChange={(e) => {
            setActiveFilter(e.target.value);
            reset();
          }}
          placeholder="Mọi trạng thái"
          options={[
            { value: '1', label: 'Đang hiển thị' },
            { value: '0', label: 'Đã gỡ' },
          ]}
          className="w-44"
        />

        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/admin/news/sources"
            className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-ink-600 underline underline-offset-2 hover:text-ink-900"
          >
            <Icon name="refresh" size={14} />
            Nguồn tin tự động
          </Link>
          <InfoButton
            info={
              <>
                <p>
                  Màn này là danh sách tin dẫn nguồn: mỗi dòng trỏ sang một bài gốc ở trang khác.
                  Khách hàng đọc tiêu đề và mô tả ở site của mình, bấm vào là sang trang nguồn.
                </p>
                <p>
                  Tin vào đây bằng hai đường: bạn <strong>dán tay</strong> một đường dẫn, hoặc job
                  kéo về từ các nguồn khai ở màn <strong>Nguồn tin tự động</strong>. Tin kéo tự
                  động có nhãn <em>Tự động</em>; sửa hay gỡ nó y như tin nhập tay.
                </p>
                <p>
                  Job chỉ lấy bài <strong>đăng trong ngày hôm nay</strong>. Muốn dẫn một bài cũ
                  thì dán tay đường dẫn của nó ở đây — nhập tay không bị giới hạn theo ngày.
                </p>
                <p>
                  Cả hai đường đều <strong>không lưu nội dung bài</strong>, chỉ giữ tiêu đề, mô tả
                  ngắn, ảnh đại diện và ngày đăng. Lưu lại toàn văn nghĩa là xuất bản lại nội dung
                  của người khác trên tên miền của mình — chuyện bản quyền, không phải chuyện kỹ
                  thuật.
                </p>
                <p>
                  <strong>Không có tin trùng.</strong> Cùng một đường dẫn chỉ vào danh sách một
                  lần, dù bạn dán tay hay job kéo về; nhiều báo đăng lại một bản tin với đúng tiêu
                  đề thì cũng chỉ giữ bài đầu tiên.
                </p>
                <p>
                  <strong>Gỡ khỏi site khách</strong> giữ nguyên bản ghi, chỉ ẩn đi — dùng khi
                  link hỏng hoặc bài bị gỡ bên nguồn. <strong>Xoá</strong> thì mất hẳn.
                </p>
              </>
            }
          />
          {canEdit && (
            <Button
              onClick={() => setEditing({ item: null })}
              leftIcon={<Icon name="plus" size={16} />}
            >
              Thêm tin
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {isLoading ? (
          <div className="py-16">
            <Spinner label="Đang tải danh sách tin…" />
          </div>
        ) : !data?.items.length ? (
          <EmptyState
            title="Chưa có tin nào"
            description={
              search
                ? 'Thử từ khoá khác.'
                : 'Bấm Thêm tin rồi dán đường dẫn bài bạn muốn dẫn cho khách hàng.'
            }
          />
        ) : (
          <div className="space-y-3 pb-1">
            {data.items.map((item) => (
              <Card key={item.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {item.image_url && (
                    // Ảnh nằm trên máy chủ của trang nguồn. Hỏng link thì ẩn ô ảnh đi chứ không
                    // để lại khung vỡ — bài vẫn đọc được bằng tiêu đề.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.image_url}
                      alt=""
                      loading="lazy"
                      className="hidden h-20 w-32 shrink-0 rounded-lg object-cover sm:block"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      {item.source_name && <Badge tone="gray">{item.source_name}</Badge>}
                      {item.source_id !== null && <Badge tone="blue">Tự động</Badge>}
                      {item.sort_order > 0 && <Badge tone="amber">Ghim · {item.sort_order}</Badge>}
                      {item.is_active ? (
                        <Badge tone="green">Đang hiển thị</Badge>
                      ) : (
                        <Badge tone="red">Đã gỡ</Badge>
                      )}
                    </div>

                    <h3 className="font-semibold leading-snug text-ink-900">{item.title}</h3>
                    {item.summary && (
                      <p className="mt-1 text-sm leading-relaxed text-ink-600">{item.summary}</p>
                    )}

                    <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
                      <span>Đăng: {item.published_at ? formatDate(item.published_at) : '—'}</span>
                      <span>Nhập: {formatDateTime(item.created_at)}</span>
                      <span>{formatNumber(item.click_count)} lượt bấm</span>
                    </p>

                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1.5 inline-flex max-w-full items-center gap-1 truncate text-xs text-ink-500 underline underline-offset-2 hover:text-ink-900"
                    >
                      <Icon name="external" size={13} className="shrink-0" />
                      <span className="truncate">{item.url}</span>
                    </a>
                  </div>

                  {canEdit && (
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ item })}>
                        Sửa
                      </Button>
                      {can('content.delete') && (
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(item)}>
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
        <NewsEditor
          item={editing.item}
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
        title="Xoá tin này?"
        message={`"${deleting?.title ?? ''}" sẽ bị xoá hẳn. Muốn tạm ẩn khỏi site khách thì sửa trạng thái thành "Đã gỡ" thay vì xoá.`}
        confirmLabel="Xoá tin"
        danger
        requireReason
        loading={remove.loading}
        onConfirm={async (reason) => {
          if (!deleting) return;
          const result = await remove.mutate({ id: deleting.id, reason });
          setDeleting(null);
          if (result) {
            toast.success(result.message);
            refresh();
          } else {
            toast.error(remove.error?.message ?? 'Không xoá được tin');
          }
        }}
      />
    </div>
  );
}
