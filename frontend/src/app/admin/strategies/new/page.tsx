'use client';

/**
 * Tạo chiến lược — trang riêng, không phải hộp thoại.
 *
 * Trước đây form này nằm trong `Modal`. Hộp thoại hợp với thao tác một hai trường; ở đây có bảy
 * trường cộng phần chọn mã có thể lên tới cả nghìn dòng, kèm ô tìm kiếm tự xổ và khối nạp file.
 * Nhồi tất cả vào một khung cao 92% màn hình nghĩa là hai vùng cuộn lồng nhau, danh sách gợi ý bị
 * cắt ở mép, và một cú Escape nhầm là mất sạch phần đã nhập mà không hỏi lại.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';

import { SymbolPicker } from '@/components/domain/SymbolPicker';

import {
  Alert,
  Button,
  Card,
  CardHeader,
  Icon,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { useApiMutation, useApiQuery, useStaffSession, useToast } from '@/hooks';
import { ADMIN, PUBLIC, api } from '@/lib/api';
import { SCHOOL_LABEL, STRATEGY_KIND, statusOptions } from '@/lib/status';
import type { Category, Message, Package, StrategyKind } from '@/types';

/** Danh mục cả sàn có hơn 1.500 mã — trần phải đủ chỗ cho nút "Toàn bộ danh mục". */
const MAX_SYMBOLS = 2000;

/** Đuôi file kho tài liệu chấp nhận — khớp `storage_service.MIME_BY_EXT` ở backend. */
const DOC_ACCEPT = '.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg';

/** Tài liệu đã chọn nhưng chưa tải lên — chiến lược chưa tồn tại nên chưa có chỗ để gắn. */
type PendingDoc = { file: File; title: string };

export default function NewStrategyPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const { can } = useStaffSession();

  /**
   * Loại chiến lược được chọn từ màn danh sách và **không đổi được ở đây**.
   *
   * Hai loại cần hai bộ thông tin khác hẳn nhau, nên một ô chọn giữa form sẽ đổi nửa trang
   * ngay dưới tay người đang nhập. Để việc chọn ở bước trước thì mỗi màn chỉ hỏi đúng thứ
   * loại đó cần.
   */
  const kind: StrategyKind = searchParams.get('kind') === 'DOCUMENT' ? 'DOCUMENT' : 'RULE';
  const isDocumentKind = kind === 'DOCUMENT';

  const { data: packages } = useApiQuery<Package[]>(`${PUBLIC}/packages`);
  const { data: docCategories } = useApiQuery<Category[]>(`${ADMIN}/categories`, {
    type: 'DOCUMENT',
  });

  const [form, setForm] = useState({
    code: '',
    name: '',
    school: 'SMC',
    description: '',
    rules_summary: '',
    min_package_id: '',
  });
  const [symbols, setSymbols] = useState<string[]>([]);

  const [docs, setDocs] = useState<PendingDoc[]>([]);
  const [docCategoryId, setDocCategoryId] = useState('');
  const docInput = useRef<HTMLInputElement>(null);

  /** Chiến lược đã tạo xong nhưng còn tài liệu lỗi — giữ lại để bấm thử lại không tạo trùng. */
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState<string[]>([]);

  const save = useApiMutation<{ id: number; message: string }, Record<string, unknown>>((body) =>
    api.post(`${ADMIN}/strategies`, body),
  );

  const canAttachDocs = can('doc.upload');
  const needsCategory = docs.length > 0 && !docCategoryId;
  const canSubmit =
    form.code.trim().length >= 2 && form.name.trim().length >= 2 && !needsCategory;

  if (!can('strategy.manage')) {
    return (
      <Alert tone="danger" title="Không có quyền">
        Bạn không có quyền tạo chiến lược.
      </Alert>
    );
  }

  /**
   * Tải tài liệu lên **kho** rồi gắn vào chiến lược — hai bước, không tải thẳng.
   *
   * Kho tài liệu là nơi có kiểm tra gói dịch vụ, đóng dấu chìm theo từng khách và ghi nhật ký
   * từng lượt tải (BR-511, 512, 513). Một đường tải riêng cho chiến lược sẽ đi vòng qua cả ba.
   *
   * Trả về danh sách tên file thất bại. Lỗi một file **không** làm hỏng các file còn lại: người
   * dùng chọn năm tài liệu thì hỏng một cái không phải là lý do bắt họ làm lại từ đầu.
   */
  async function uploadDocs(strategyId: number, items: PendingDoc[]): Promise<string[]> {
    const errors: string[] = [];
    setUploading({ done: 0, total: items.length });

    for (const [index, item] of items.entries()) {
      try {
        const body = new FormData();
        body.append('file', item.file);
        body.append('title', item.title.trim() || item.file.name);
        body.append('category_id', docCategoryId);
        // Tài liệu phân tích đi kèm chiến lược nào thì theo đúng bậc gói của chiến lược đó —
        // để mặc định thoáng hơn nghĩa là phát tài liệu trả phí cho gói chưa mua.
        if (form.min_package_id) body.append('min_package_id', form.min_package_id);

        const created = await api.upload<{ id: number }>(`${ADMIN}/documents`, body);
        await api.post<Message>(`${ADMIN}/strategies/${strategyId}/documents`, {
          document_id: created.id,
        });
      } catch (err) {
        errors.push(`${item.file.name} — ${(err as Error).message || 'lỗi không rõ'}`);
      }
      setUploading({ done: index + 1, total: items.length });
    }

    setUploading(null);
    return errors;
  }

  async function submit() {
    let strategyId = createdId;

    // Lần bấm đầu tiên tạo chiến lược; lần sau (sau khi có tài liệu lỗi) chỉ tải lại tài liệu.
    if (strategyId === null) {
      const result = await save.mutate({
        code: form.code.trim(),
        name: form.name.trim(),
        school: form.school,
        kind,
        description: form.description || null,
        rules_summary: form.rules_summary || null,
        min_package_id: form.min_package_id ? Number(form.min_package_id) : null,
        symbols,
      });
      if (!result) return;
      toast.success(result.message);
      strategyId = result.id;
      setCreatedId(result.id);
    }

    const errors = docs.length ? await uploadDocs(strategyId, docs) : [];
    setFailed(errors);

    if (errors.length) {
      toast.error(`${errors.length} tài liệu không tải lên được. Chiến lược đã được tạo.`);
      return;
    }

    if (docs.length) toast.success(`Đã đính kèm ${docs.length} tài liệu`);
    // Đi thẳng tới trang cấu hình của chiến lược vừa tạo thay vì quay về danh sách: đó là nơi
    // xem lại tài liệu đính kèm và đặt bộ lọc, hai việc gần như luôn làm ngay sau khi tạo.
    router.push(`/admin/strategies/${strategyId}/rules`);
  }

  return (
    <div className="space-y-4 pb-4">
      <PageHeader
        title={isDocumentKind ? 'Tạo chiến lược theo tài liệu' : 'Tạo chiến lược theo điều kiện'}
        description={
          isDocumentKind
            ? 'AI đọc tài liệu bạn tải lên rồi viết nhận định khi khách bấm Phân tích. Chiến lược mới ở trạng thái Nháp — khách chưa nhìn thấy.'
            : 'Bạn dựng điều kiện vào/thoát lệnh, máy chạy tức thì khi khách bấm Phân tích. Chiến lược mới ở trạng thái Nháp — khách chưa nhìn thấy.'
        }
        action={
          <Button variant="outline" onClick={() => router.push('/admin/strategies')}>
            Quay lại danh sách
          </Button>
        }
      />

      {save.error && <Alert tone="danger">{save.error.message}</Alert>}

      <Card>
        <CardHeader title="Thông tin chung" />

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Mã chiến lược"
              required
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              placeholder="SMC_BREAKOUT"
              hint="Không đổi được sau khi tạo — mã này đi kèm mọi tín hiệu đã phát."
            />
            <Input
              label="Tên hiển thị"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="SMC Breakout"
            />
            <Select
              label="Trường phái"
              value={form.school}
              onChange={(e) => setForm({ ...form, school: e.target.value })}
              options={statusOptions(SCHOOL_LABEL)}
            />
            {/* Khung thời gian không còn là lựa chọn — toàn hệ thống chạy trên nến ngày. */}
            <Input label="Khung thời gian" value="D — nến ngày" readOnly disabled
                   hint="Cố định cho mọi chiến lược." />
          </div>

          <Select
            label="Gói tối thiểu để xem"
            value={form.min_package_id}
            onChange={(e) => setForm({ ...form, min_package_id: e.target.value })}
            placeholder="Mọi gói đều xem được"
            options={(packages ?? []).map((p) => ({ value: p.id, label: p.name }))}
            hint="Đặt gói cao để chiến lược này thành đòn bẩy bán gói dài hạn."
          />

          <Textarea
            label="Mô tả"
            placeholder="Chiến lược này hợp với loại thị trường nào?"
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />

          <Textarea
            label="Tóm tắt quy tắc"
            placeholder="Tóm tắt cho nhân viên hiểu, không nêu công thức chi tiết"
            rows={3}
            value={form.rules_summary}
            onChange={(e) => setForm({ ...form, rules_summary: e.target.value })}
            hint="Nội dung này là nền cho phần hỏi đáp về chiến lược."
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Danh sách mã áp dụng"
          description="Khách hàng chỉ đăng ký nhận tín hiệu được các mã trong danh sách này. Có thể để trống rồi bổ sung sau."
        />

        <SymbolPicker
          value={symbols}
          onChange={setSymbols}
          label="Mã áp dụng"
          max={MAX_SYMBOLS}
          showSelectAll
          showExchangeBulk
          showUpload
          extraActions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSymbols([])}
              disabled={symbols.length === 0}
            >
              Bỏ chọn tất cả
            </Button>
          }
        />

        <p className="mt-3 text-xs text-ink-500">
          Nút <strong>Tải từ file</strong> ở đây nhận <em>danh sách mã</em> dạng văn bản thuần
          (.txt, .csv): mỗi dòng một mã, hoặc phân tách bằng dấu phẩy. Mã không có trong danh mục
          hệ thống sẽ được liệt kê ra chứ không bị bỏ qua âm thầm.
        </p>
      </Card>

      {!isDocumentKind && (
        <Card>
          <CardHeader
            title="Bước tiếp theo: dựng điều kiện"
            description="Chiến lược theo điều kiện không đính tài liệu."
          />
          <Alert tone="info">
            Tạo xong sẽ chuyển thẳng tới thẻ <strong>Bộ điều kiện</strong> để dựng điều kiện vào
            và thoát lệnh. <strong>Chưa có điều kiện thì nút Phân tích bên site khách hàng sẽ
            báo lỗi</strong> — đừng kích hoạt chiến lược trước khi dựng xong.
          </Alert>
        </Card>
      )}

      {/* Tài liệu phân tích đính kèm chiến lược. File được chọn ở đây nhưng chỉ tải lên **sau
          khi** chiến lược được tạo — trước đó chưa có id để gắn vào. */}
      {isDocumentKind && (
      <Card>
        <CardHeader
          title="Tài liệu phân tích"
          description="PDF có lớp văn bản là định dạng duy nhất AI đọc được. File khác vẫn lưu được nhưng sẽ bị bỏ qua khi phân tích."
          action={
            canAttachDocs ? (
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Icon name="upload" size={15} />}
                onClick={() => docInput.current?.click()}
              >
                Chọn file
              </Button>
            ) : undefined
          }
        />

        {!canAttachDocs ? (
          <Alert tone="info">
            Bạn không có quyền tải tài liệu lên kho, nên phần này ở chế độ chỉ xem. Nhờ người có
            quyền tải tài liệu rồi gắn vào chiến lược sau khi tạo.
          </Alert>
        ) : (
          <div className="space-y-3">
            <input
              ref={docInput}
              type="file"
              multiple
              accept={DOC_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                // Xoá giá trị để chọn lại đúng file vừa rồi vẫn kích hoạt onChange.
                e.target.value = '';
                if (!picked.length) return;
                setDocs((current) => [
                  ...current,
                  // Tên hiển thị mặc định là tên file bỏ đuôi — sửa được ngay bên dưới.
                  ...picked
                    .filter((f) => !current.some((d) => d.file.name === f.name))
                    .map((file) => ({ file, title: file.name.replace(/\.[^.]+$/, '') })),
                ]);
              }}
            />

            {docs.length === 0 ? (
              <p className="rounded-lg border border-dashed border-ink-300 px-3 py-6 text-center text-sm text-ink-500">
                Chưa chọn tài liệu nào. Có thể bỏ qua và đính kèm sau ở trang chiến lược.
              </p>
            ) : (
              <>
                <Select
                  label="Danh mục trong kho tài liệu"
                  required
                  value={docCategoryId}
                  onChange={(e) => setDocCategoryId(e.target.value)}
                  placeholder="Chọn danh mục…"
                  options={(docCategories ?? []).map((c) => ({ value: c.id, label: c.name }))}
                  error={needsCategory ? 'Chọn danh mục trước khi tạo' : undefined}
                  hint="Tài liệu vào kho chung rồi gắn vào chiến lược, nên vẫn cần một danh mục."
                />

                <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
                  {docs.map((doc, index) => (
                    <li key={doc.file.name} className="flex items-end gap-2 p-2.5">
                      <div className="min-w-0 flex-1">
                        <Input
                          label={index === 0 ? 'Tên hiển thị' : undefined}
                          value={doc.title}
                          maxLength={255}
                          onChange={(e) =>
                            setDocs((current) =>
                              current.map((d, i) =>
                                i === index ? { ...d, title: e.target.value } : d,
                              ),
                            )
                          }
                        />
                        <p className="mt-1 truncate text-xs text-ink-500">
                          {doc.file.name} · {Math.max(1, Math.round(doc.file.size / 1024))} KB
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDocs((current) => current.filter((_, i) => i !== index))}
                      >
                        <Icon name="trash" size={15} />
                      </Button>
                    </li>
                  ))}
                </ul>

                <p className="text-xs text-ink-500">
                  Tài liệu được tải lên <strong>kho tài liệu</strong> rồi gắn vào chiến lược — đó
                  là nơi có kiểm tra gói dịch vụ, đóng dấu chìm theo từng khách hàng và ghi nhật ký
                  từng lượt tải. Quyền xem theo đúng gói tối thiểu bạn đặt ở trên.
                </p>
              </>
            )}
          </div>
        )}

        {uploading && (
          <Alert tone="info" className="mt-3">
            Đang tải tài liệu {uploading.done}/{uploading.total}…
          </Alert>
        )}

        {failed.length > 0 && (
          <Alert tone="danger" title={`${failed.length} tài liệu không tải lên được`} className="mt-3">
            <p>
              Chiến lược <strong>đã được tạo</strong>. Bấm lại nút bên dưới để thử tải lại, hoặc bỏ
              các file lỗi ra khỏi danh sách rồi đính kèm sau ở trang chiến lược.
            </p>
            <ul className="mt-1 list-inside list-disc">
              {failed.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Alert>
        )}
      </Card>
      )}

      {/* Thanh hành động dính đáy: form dài, người dùng không phải cuộn ngược lên để lưu. */}
      <div className="sticky bottom-0 -mx-4 flex flex-col-reverse gap-2 border-t border-ink-200 bg-surface px-4 py-3 sm:mx-0 sm:flex-row sm:justify-end sm:rounded-xl sm:border sm:px-4">
        <Button
          variant="outline"
          onClick={() =>
            // Chiến lược đã tạo rồi thì "Huỷ" chỉ là rời trang, không xoá gì — đi tới đúng
            // chiến lược đó thay vì bỏ người dùng lại ở danh sách mà không biết nó đã tồn tại.
            router.push(createdId ? `/admin/strategies/${createdId}/rules` : '/admin/strategies')
          }
        >
          {createdId ? 'Để sau, đi tới chiến lược' : 'Huỷ'}
        </Button>
        <Button
          loading={save.loading || uploading !== null}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {createdId
            ? 'Thử tải lại tài liệu'
            : `Tạo chiến lược${symbols.length > 0 ? ` (${symbols.length} mã)` : ''}${
                docs.length > 0 ? ` + ${docs.length} tài liệu` : ''
              }`}
        </Button>
      </div>
    </div>
  );
}
