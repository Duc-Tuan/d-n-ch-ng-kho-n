'use client';

/**
 * Màn soạn bài viết (YC13, 14, 15).
 *
 * Trước đây đây là một popup. Soạn bài là việc kéo dài hàng chục phút, có ảnh, có bảng, có xem
 * trước — nhốt vào hộp thoại thì vùng soạn chỉ còn vài dòng, và mọi thao tác lỡ tay đóng nền là
 * mất trắng. Nên tách thành màn riêng có đường dẫn riêng, quay lại hay tải lại trang đều được.
 *
 * Dùng chung cho cả tạo mới (`/admin/articles/new`) và sửa (`/admin/articles/{id}/edit`) — hai
 * luồng khác nhau đúng một chỗ là có nạp dữ liệu cũ hay không.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { MediaPickerModal, type PickedImage } from '@/components/domain/MediaPickerModal';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Icon,
  Input,
  PageHeader,
  RichTextEditor,
  Select,
  Spinner,
  Tabs,
  Textarea,
} from '@/components/ui';
import { useApiQuery, useStaffSession, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { formatDateTime, fromInputDateTime, toInputDateTime } from '@/lib/datetime';
import type { Article, Category, Message, Package } from '@/types';

type FormState = {
  category_id: string;
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  thumbnail: string;
  tags: string;
  min_package_id: string;
  published_at: string;
  change_note: string;
};

const EMPTY: FormState = {
  category_id: '',
  title: '',
  slug: '',
  excerpt: '',
  content: '',
  thumbnail: '',
  tags: '',
  min_package_id: '',
  published_at: '',
  change_note: '',
};

const TABS = [
  { key: 'edit', label: 'Soạn nội dung' },
  { key: 'preview', label: 'Xem trước' },
];

export function ArticleEditorScreen({ articleId }: { articleId: number | null }) {
  const router = useRouter();
  const toast = useToast();
  const { can } = useStaffSession();

  const isEdit = articleId !== null;

  const [tab, setTab] = useState('edit');
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Hộp chọn ảnh được mở từ hai chỗ: thanh công cụ trình soạn thảo và ô ảnh đại diện. Giữ lời
  // hứa đang chờ ở ref để trình soạn thảo nhận lại ảnh sau khi người dùng chọn xong.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerResolve = useRef<((image: PickedImage | null) => void) | null>(null);
  const [pickerTarget, setPickerTarget] = useState<'content' | 'thumbnail'>('content');

  const { data: categories } = useApiQuery<Category[]>(`${ADMIN}/categories`, { type: 'ARTICLE' });
  const { data: packages } = useApiQuery<Package[]>('/public/packages');
  const { data: article, isLoading } = useApiQuery<Article>(
    isEdit ? `${ADMIN}/articles/${articleId}` : null,
  );

  useEffect(() => {
    if (!article) return;
    setForm({
      category_id: String(article.category_id ?? ''),
      title: article.title,
      slug: article.slug,
      excerpt: article.excerpt ?? '',
      content: article.content ?? '',
      thumbnail: article.thumbnail ?? '',
      tags: article.tags ?? '',
      min_package_id: article.min_package_id ? String(article.min_package_id) : '',
      published_at: toInputDateTime(article.published_at),
      change_note: '',
    });
    setDirty(false);
  }, [article]);

  // Danh mục mặc định khi tạo mới — đỡ một thao tác cho trường gần như luôn chọn cái đầu tiên.
  useEffect(() => {
    if (!isEdit && !form.category_id && categories?.length) {
      setForm((f) => ({ ...f, category_id: String(categories[0].id) }));
    }
  }, [categories, form.category_id, isEdit]);

  // Cảnh báo khi đóng tab lúc còn nội dung chưa lưu. Không chặn được điều hướng nội bộ của
  // Next.js, nên nút Quay lại tự hỏi riêng.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const update = (patch: Partial<FormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };

  const requestImage = (target: 'content' | 'thumbnail') =>
    new Promise<PickedImage | null>((resolve) => {
      pickerResolve.current = resolve;
      setPickerTarget(target);
      setPickerOpen(true);
    });

  const closePicker = () => {
    setPickerOpen(false);
    // Đóng mà không chọn thì phải trả lời lời hứa, nếu không trình soạn thảo treo mãi.
    pickerResolve.current?.(null);
    pickerResolve.current = null;
  };

  const handlePick = (image: PickedImage) => {
    if (pickerTarget === 'thumbnail') {
      update({ thumbnail: image.url });
      pickerResolve.current?.(null);
    } else {
      update({ content: form.content });
      pickerResolve.current?.(image);
    }
    pickerResolve.current = null;
    setPickerOpen(false);
  };

  const canSave =
    form.title.trim().length >= 5 &&
    form.content.trim().length > 0 &&
    Boolean(form.category_id) &&
    (!isEdit || form.change_note.trim().length > 0);

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        category_id: Number(form.category_id),
        title: form.title.trim(),
        slug: form.slug.trim() || undefined,
        excerpt: form.excerpt.trim() || null,
        content: form.content,
        thumbnail: form.thumbnail.trim() || null,
        tags: form.tags.trim() || null,
        min_package_id: form.min_package_id ? Number(form.min_package_id) : null,
        published_at: fromInputDateTime(form.published_at),
        change_note: form.change_note.trim() || undefined,
      };

      if (isEdit) {
        const result = await api.put<Message>(`${ADMIN}/articles/${articleId}`, body);
        toast.success(result.message);
        setDirty(false);
      } else {
        const result = await api.post<{ id: number; message: string }>(`${ADMIN}/articles`, body);
        toast.success(result.message);
        setDirty(false);
        // Chuyển sang chế độ sửa để lần lưu sau không tạo thêm bài trùng.
        router.replace(`/admin/articles/${result.id}/edit`);
      }
    } catch (err) {
      toast.error((err as Error).message ?? 'Không lưu được bài viết');
    } finally {
      setSaving(false);
    }
  };

  const goBack = () => {
    if (dirty) {
      setLeaving(true);
      return;
    }
    router.push('/admin/articles');
  };

  if (!can('content.create')) {
    return (
      <div className="space-y-4">
        <PageHeader title="Soạn bài viết" />
        <Alert tone="warning" title="Không đủ quyền">
          Bạn không có quyền soạn bài viết.
        </Alert>
      </div>
    );
  }

  if (isEdit && isLoading) {
    return (
      <div className="py-20">
        <Spinner label="Đang tải bài viết…" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={
          <button onClick={goBack} className="hover:text-ink-700">
            ← Danh sách bài viết
          </button>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {isEdit ? 'Sửa bài viết' : 'Bài viết mới'}
            {article && <Badge tone="gray">{article.slug}</Badge>}
            {dirty && <Badge tone="amber">Chưa lưu</Badge>}
          </span>
        }
        description={
          isEdit && article?.updated_at
            ? `Sửa lần cuối ${formatDateTime(article.updated_at)}`
            : 'Bài mới luôn được tạo ở trạng thái Nháp, sau đó gửi duyệt'
        }
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={goBack}>
              Quay lại
            </Button>
            <Button loading={saving} disabled={!canSave} onClick={() => void save()}>
              {isEdit ? 'Lưu thay đổi' : 'Tạo bài viết'}
            </Button>
          </div>
        }
      />

      <Tabs items={TABS} active={tab} onChange={setTab} />

      {tab === 'preview' ? (
        <ArticlePreview
          form={form}
          categoryName={
            categories?.find((c) => String(c.id) === form.category_id)?.name ?? 'Chưa chọn danh mục'
          }
        />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
          {/* ---------- CỘT TRÁI: NỘI DUNG ---------- */}
          <div className="space-y-4">
            <Card>
              <div className="space-y-3">
                <Input
                  label="Tiêu đề"
                  required
                  value={form.title}
                  onChange={(e) => update({ title: e.target.value })}
                  placeholder="Ví dụ: Nhìn lại nhóm thép sau quý 2"
                  hint="Tối thiểu 5 ký tự."
                />
                <Input
                  label="Đường dẫn thân thiện"
                  value={form.slug}
                  onChange={(e) => update({ slug: e.target.value })}
                  placeholder="Bỏ trống để hệ thống tự sinh từ tiêu đề"
                  hint="Đổi đường dẫn của bài đã xuất bản sẽ làm hỏng link cũ mà người đọc đã lưu."
                />
              </div>
            </Card>

            <Card padded={false} className="p-4 sm:p-5">
              <RichTextEditor
                label="Nội dung bài viết"
                required
                value={form.content}
                onChange={(content) => update({ content })}
                onRequestImage={() => requestImage('content')}
                disabled={saving}
                minHeight="30rem"
                hint="Ảnh chèn vào bài được lưu trên máy chủ và chỉ người đã đăng nhập mới xem được."
              />
            </Card>

            <Card>
              <Textarea
                label="Đoạn tóm tắt"
                rows={3}
                value={form.excerpt}
                onChange={(e) => update({ excerpt: e.target.value })}
                placeholder="Bỏ trống thì hệ thống tự lấy vài dòng đầu của bài."
                hint="Hiển thị ở danh sách bài viết và khi chia sẻ link."
              />
            </Card>
          </div>

          {/* ---------- CỘT PHẢI: THUỘC TÍNH ---------- */}
          <div className="space-y-4">
            <Card>
              <CardHeader title="Phân loại" />
              <div className="space-y-3">
                <Select
                  label="Danh mục"
                  required
                  value={form.category_id}
                  onChange={(e) => update({ category_id: e.target.value })}
                  placeholder="Chọn danh mục"
                  options={(categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
                />
                <Input
                  label="Thẻ"
                  value={form.tags}
                  onChange={(e) => update({ tags: e.target.value })}
                  placeholder="thep, HPG, quy-2"
                  hint="Cách nhau bằng dấu phẩy. Thẻ trùng một mã chứng khoán sẽ đưa bài này vào kết quả phân tích mã đó ở site khách hàng."
                />
              </div>
            </Card>

            <Card>
              <CardHeader title="Ảnh đại diện" />
              {form.thumbnail ? (
                <div className="space-y-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={form.thumbnail}
                    alt="Ảnh đại diện"
                    className="w-full rounded-lg border border-ink-200 object-cover"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void requestImage('thumbnail')}
                    >
                      Đổi ảnh
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => update({ thumbnail: '' })}>
                      Gỡ ảnh
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="w-full"
                  leftIcon={<Icon name="upload" size={16} />}
                  onClick={() => void requestImage('thumbnail')}
                >
                  Chọn ảnh đại diện
                </Button>
              )}
            </Card>

            <Card>
              <CardHeader title="Phát hành" />
              <div className="space-y-3">
                <Select
                  label="Gói tối thiểu để đọc"
                  value={form.min_package_id}
                  onChange={(e) => update({ min_package_id: e.target.value })}
                  placeholder="Mọi khách hàng đều đọc được"
                  options={(packages ?? []).map((p) => ({ value: p.id, label: p.name }))}
                  hint="Đặt gói sẽ khoá nội dung với khách hàng gói thấp hơn."
                />
                <Input
                  type="datetime-local"
                  label="Hẹn giờ xuất bản"
                  value={form.published_at}
                  onChange={(e) => update({ published_at: e.target.value })}
                  hint="Bỏ trống thì bài đăng ngay khi được duyệt."
                />
              </div>
            </Card>

            {isEdit && (
              <Card>
                <Textarea
                  label="Ghi chú thay đổi"
                  required
                  rows={2}
                  value={form.change_note}
                  onChange={(e) => update({ change_note: e.target.value })}
                  placeholder="Ví dụ: Cập nhật số liệu quý 2 và bổ sung biểu đồ"
                  hint="Bắt buộc — lưu vào lịch sử phiên bản để biết ai sửa gì lúc nào."
                />
              </Card>
            )}
          </div>
        </div>
      )}

      <MediaPickerModal open={pickerOpen} onClose={closePicker} onPick={handlePick} />

      <ConfirmDialog
        open={leaving}
        onClose={() => setLeaving(false)}
        title="Rời khỏi màn soạn bài?"
        message="Bài viết còn thay đổi chưa lưu. Rời đi bây giờ sẽ mất phần vừa soạn."
        confirmLabel="Rời đi"
        danger
        onConfirm={() => router.push('/admin/articles')}
      />
    </div>
  );
}

/**
 * YC15 — xem trước đúng như khi bài đã đăng.
 *
 * Dùng lại chính lớp `prose-article` mà site khách hàng dùng, nên đây không phải bản mô phỏng
 * gần giống mà là **cùng một cách hiển thị**. Xem trước bằng kiểu chữ khác với bản thật thì
 * biên tập vẫn phải đăng lên rồi mới biết bài trông thế nào.
 */
function ArticlePreview({ form, categoryName }: { form: FormState; categoryName: string }) {
  if (!form.content.trim()) {
    return (
      <Alert tone="info">
        Chưa có nội dung để xem trước. Sang thẻ <strong>Soạn nội dung</strong> để bắt đầu viết.
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <Alert tone="info">
        Đây là hình dung bài viết khi đã xuất bản. Khi lưu, máy chủ sẽ lọc bỏ những thẻ HTML không
        an toàn, nên bản thật có thể khác đôi chút nếu nội dung được dán từ nguồn ngoài.
      </Alert>

      <Card>
        <article className="mx-auto max-w-3xl space-y-5">
          <header className="space-y-3">
            <Badge tone="blue">{categoryName}</Badge>
            <h1 className="text-2xl font-semibold leading-tight text-ink-900">
              {form.title || 'Bài viết chưa có tiêu đề'}
            </h1>
            <p className="text-sm text-ink-500">
              {form.published_at
                ? `Hẹn đăng ${formatDateTime(fromInputDateTime(form.published_at))}`
                : 'Đăng ngay khi được duyệt'}{' '}
              · 0 lượt xem
            </p>
            {form.excerpt && (
              <p className="border-l-4 border-ink-200 pl-4 text-base leading-relaxed text-ink-600">
                {form.excerpt}
              </p>
            )}
          </header>

          {form.thumbnail && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={form.thumbnail} alt="" className="w-full rounded-lg" />
          )}

          {/*
            Nội dung do chính người đang ngồi trước màn hình soạn ra bằng trình soạn thảo của hệ
            thống, chưa gửi đi đâu — đây là bản xem trước cục bộ, không phải HTML từ người khác.
          */}
          <div className="prose-article" dangerouslySetInnerHTML={{ __html: form.content }} />

          {form.tags && (
            <div className="flex flex-wrap gap-2">
              {form.tags.split(',').map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-ink-100 px-2.5 py-1 text-xs text-ink-600"
                >
                  #{tag.trim()}
                </span>
              ))}
            </div>
          )}
        </article>
      </Card>
    </div>
  );
}
