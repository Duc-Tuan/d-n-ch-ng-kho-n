'use client';

/** Form tạo/sửa và hộp thoại chia sẻ chiến lược cá nhân của khách hàng. */
import { useEffect, useState } from 'react';

import { SymbolPicker } from '@/components/domain/SymbolPicker';
import {
  Alert,
  Badge,
  Button,
  Icon,
  Input,
  Modal,
  Select,
  Spinner,
  StatusBadge,
  Textarea,
} from '@/components/ui';
import { fieldError, useApiMutation, useApiQuery, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { SCHOOL_LABEL, STRATEGY_KIND, statusOptions } from '@/lib/status';
import type { Message, Strategy, StrategyKind } from '@/types';


export function MyStrategyEditor({
  strategyId,
  onClose,
  onSaved,
}: {
  strategyId: number | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = strategyId !== null;

  const { data: existing, isLoading } = useApiQuery<{ strategy: Strategy; is_owner: boolean }>(
    isEdit ? `${CUSTOMER}/my-strategies/${strategyId}` : null,
  );

  const [form, setForm] = useState({
    name: '',
    school: 'PRICE_ACTION',
    description: '',
    rules_summary: '',
  });

  /**
   * Loại chiến lược — chọn một lần lúc tạo, sau đó khoá.
   *
   * Đổi loại nghĩa là vứt bỏ hoặc toàn bộ điều kiện đã dựng, hoặc toàn bộ tài liệu đã tải lên —
   * và mọi bản phân tích cũ sinh ra từ loại trước đó trở thành không giải thích được.
   */
  const [kind, setKind] = useState<StrategyKind>('RULE');
  const [symbols, setSymbols] = useState<string[]>([]);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (isEdit && existing && !initialized) {
      const s = existing.strategy;
      setForm({
        name: s.name,
        school: s.school,
        description: s.description ?? '',
        rules_summary: s.rules_summary ?? '',
      });
      setKind(s.kind);
      setSymbols(s.symbols);
      setInitialized(true);
    }
  }, [isEdit, existing, initialized]);

  const save = useApiMutation<Message | { id: number; message: string }, Record<string, unknown>>(
    (body) =>
      isEdit
        ? api.put<Message>(`${CUSTOMER}/my-strategies/${strategyId}`, body)
        : api.post<{ id: number; message: string }>(`${CUSTOMER}/my-strategies`, body),
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? 'Sửa chiến lược' : 'Tạo chiến lược của riêng bạn'}
      description="Chỉ bạn nhìn thấy chiến lược này cho tới khi bạn chủ động chia sẻ."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={save.loading}
            disabled={form.name.trim().length < 2 || symbols.length === 0}
            onClick={async () => {
              const result = await save.mutate({
                name: form.name.trim(),
                school: form.school,
                kind,
                symbols,
                description: form.description || null,
                rules_summary: form.rules_summary || null,
              });
              if (result) onSaved((result as Message).message);
            }}
          >
            {isEdit ? 'Lưu' : 'Tạo chiến lược'}
          </Button>
        </>
      }
    >
      {isEdit && isLoading ? (
        <Spinner label="Đang tải…" />
      ) : (
        <div className="space-y-4">
          {save.error && <Alert tone="danger">{save.error.message}</Alert>}

          <Input
            label="Tên chiến lược"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Ví dụ: Vượt đỉnh 20 phiên"
            error={fieldError(save.error, 'name')}
          />

          {/* Chọn loại trước mọi thứ khác: nó quyết định bước tiếp theo là dựng điều kiện hay
              tải tài liệu, và không đổi được sau khi tạo. */}
          {isEdit ? (
            <div>
              <p className="mb-1.5 text-sm font-medium text-ink-700">Loại chiến lược</p>
              <StatusBadge map={STRATEGY_KIND} code={kind} />
              <p className="mt-1.5 text-xs text-ink-500">
                Không đổi được sau khi tạo. Cần loại khác thì tạo một chiến lược mới.
              </p>
            </div>
          ) : (
            <div>
              <p className="mb-1.5 text-sm font-medium text-ink-700">
                Loại chiến lược <span className="text-tone-red-fg">*</span>
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {(['RULE', 'DOCUMENT'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setKind(option)}
                    className={cn(
                      'rounded-xl border p-3 text-left transition-colors',
                      kind === option
                        ? 'border-ink-900 bg-ink-50'
                        : 'border-ink-200 hover:border-ink-300',
                    )}
                  >
                    <p className="text-sm font-semibold text-ink-900">
                      {option === 'RULE' ? 'Theo điều kiện' : 'Theo tài liệu'}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-600">
                      {option === 'RULE'
                        ? 'Bạn dựng điều kiện vào/thoát lệnh. Phân tích chạy tức thì và không tốn lượt nào.'
                        : 'Bạn tải tài liệu lên, AI đọc rồi viết nhận định. Mỗi lượt phân tích trừ một hạn mức trong ngày.'}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Trường phái"
              value={form.school}
              onChange={(e) => setForm({ ...form, school: e.target.value })}
              options={statusOptions(SCHOOL_LABEL)}
            />
            {/* Khung thời gian không còn chọn được — toàn hệ thống chạy trên nến ngày. */}
            <Input label="Khung thời gian" value="D — nến ngày" readOnly disabled />
          </div>

          <SymbolPicker
            value={symbols}
            onChange={setSymbols}
            error={fieldError(save.error, 'symbols')}
          />

          <Textarea
            label="Mô tả ngắn"
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Chiến lược này dùng khi nào, phù hợp với loại thị trường nào."
          />

          <Textarea
            label={kind === 'DOCUMENT' ? 'Ghi chú về chiến lược' : 'Quy tắc vào/ra lệnh'}
            rows={5}
            value={form.rules_summary}
            onChange={(e) => setForm({ ...form, rules_summary: e.target.value })}
            placeholder={
              '1. Điều kiện vào lệnh…\n2. Đặt cắt lỗ ở đâu…\n3. Chốt lời khi nào…'
            }
            hint="Ghi rõ quy tắc giúp bạn giữ kỷ luật và đánh giá lại chiến lược sau này."
          />

          {/*
            Bộ lọc máy chạy được nằm ở màn chi tiết chứ không phải trong hộp thoại này: dựng điều
            kiện cần vừa sửa vừa nhìn kết quả trên biểu đồ, không đặt vừa trong một popup.
          */}
          <Alert tone="info">
            {kind === 'DOCUMENT' ? (
              <>
                Sau khi tạo xong, mở chiến lược rồi vào thẻ <strong>Tài liệu</strong> để tải file
                lên. Chưa có tài liệu thì phân tích không có căn cứ để bám vào.
              </>
            ) : (
              <>
                Sau khi tạo xong, mở chiến lược rồi vào thẻ <strong>Bộ điều kiện</strong> để dựng
                điều kiện vào và thoát lệnh. Có điều kiện thì hệ thống tự chấm điểm mua bán lên
                biểu đồ của bất kỳ mã nào bạn chọn.
              </>
            )}
          </Alert>
        </div>
      )}
    </Modal>
  );
}

type ShareItem = {
  id: number;
  email: string | null;
  is_link: boolean;
  share_url: string | null;
  note: string | null;
  created_at: string;
};

export function ShareStrategyModal({
  strategy,
  onClose,
  onChanged,
}: {
  strategy: Strategy;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [email, setEmail] = useState('');

  const { data: shares, refresh } = useApiQuery<ShareItem[]>(
    `${CUSTOMER}/my-strategies/${strategy.id}/shares`,
  );

  const shareByEmail = useApiMutation<Message, { email: string }>((body) =>
    api.post<Message>(`${CUSTOMER}/my-strategies/${strategy.id}/share`, body),
  );
  const createLink = useApiMutation<{ share_url: string; message: string }, void>(() =>
    api.post(`${CUSTOMER}/my-strategies/${strategy.id}/share-link`),
  );
  const revoke = useApiMutation<Message, number>((id) =>
    api.del<Message>(`${CUSTOMER}/my-strategies/shares/${id}`),
  );

  const link = shares?.find((s) => s.is_link);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Chia sẻ: ${strategy.name}`}
      description="Người nhận chỉ được xem — không sửa và không chia sẻ tiếp cho người khác."
      size="lg"
      footer={
        <Button variant="outline" onClick={onClose}>
          Đóng
        </Button>
      }
    >
      <div className="space-y-5">
        {/* ---------- Chia sẻ đích danh ---------- */}
        <div>
          <p className="mb-2 text-sm font-medium text-ink-700">Chia sẻ cho một khách hàng</p>
          {shareByEmail.error && (
            <Alert tone="danger" className="mb-2">
              {shareByEmail.error.message}
            </Alert>
          )}
          <div className="flex gap-2">
            <Input
              type="email"
              placeholder="email@khachhang.vn"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1"
            />
            <Button
              loading={shareByEmail.loading}
              disabled={!email.includes('@')}
              onClick={async () => {
                const result = await shareByEmail.mutate({ email: email.trim() });
                if (result) {
                  toast.success(result.message);
                  setEmail('');
                  refresh();
                  onChanged();
                }
              }}
            >
              Chia sẻ
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-ink-500">
            Người nhận phải có tài khoản trên hệ thống và sẽ nhận được thông báo trong ứng dụng.
          </p>
        </div>

        {/* ---------- Chia sẻ bằng link ---------- */}
        <div className="border-t border-ink-100 pt-4">
          <p className="mb-2 text-sm font-medium text-ink-700">Hoặc chia sẻ bằng link</p>
          {link?.share_url ? (
            <div className="flex gap-2">
              <Input readOnly value={link.share_url} className="flex-1 font-mono text-xs" />
              <Button
                variant="outline"
                leftIcon={<Icon name="copy" size={15} />}
                onClick={() => {
                  navigator.clipboard.writeText(link.share_url!);
                  toast.success('Đã sao chép link');
                }}
              >
                Sao chép
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              loading={createLink.loading}
              onClick={async () => {
                const result = await createLink.mutate();
                if (result) {
                  toast.success('Đã tạo link chia sẻ');
                  refresh();
                }
              }}
            >
              Tạo link chia sẻ
            </Button>
          )}
          <p className="mt-1.5 text-xs text-ink-500">
            Ai có link này và đang đăng nhập đều nhận được chiến lược. Thu hồi bất cứ lúc nào.
          </p>
        </div>

        {/* ---------- Danh sách đang chia sẻ ---------- */}
        <div className="border-t border-ink-100 pt-4">
          <p className="mb-2 text-sm font-medium text-ink-700">
            Đang chia sẻ với ({shares?.filter((s) => !s.is_link).length ?? 0})
          </p>
          {!shares?.length ? (
            <p className="text-sm text-ink-500">Chưa chia sẻ cho ai.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {shares.map((share) => (
                <li key={share.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon
                      name={share.is_link ? 'external' : 'user'}
                      size={16}
                      className="text-ink-400"
                    />
                    <span className="truncate text-sm text-ink-800">
                      {share.email ?? 'Link chia sẻ công khai'}
                    </span>
                    {share.is_link && <Badge tone="gray">Link</Badge>}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const result = await revoke.mutate(share.id);
                      if (result) {
                        toast.success(result.message);
                        refresh();
                        onChanged();
                      }
                    }}
                  >
                    Thu hồi
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
