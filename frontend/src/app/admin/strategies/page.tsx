'use client';

import Link from 'next/link';
import { useState } from 'react';

import { SymbolPicker } from '@/components/domain/SymbolPicker';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Icon,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Spinner,
  StatusBadge,
  Tabs,
  Textarea,
} from '@/components/ui';
import { useApiMutation, useApiQuery, usePagination, useStaffSession, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { formatPercent, formatR } from '@/lib/format';
import { SCHOOL_LABEL, STRATEGY_KIND, statusOptions } from '@/lib/status';
import { toInputDateTime, fromInputDateTime } from '@/lib/datetime';
import type { Message, Page, StrategyKind } from '@/types';

type AdminStrategy = {
  id: number;
  code: string;
  name: string;
  school: string;
  timeframe: string;
  status: string;
  is_public: boolean;
  owner_type: 'SYSTEM' | 'USER';
  owner_id: number | null;
  owner_name: string | null;
  owner_code: string | null;
  /** Backend đã gộp cả ba điều kiện của bộ lọc site khách hàng vào đây. */
  visible_to_customers: boolean;
  min_package_id: number | null;
  analyst_id: number | null;
  /** Loại chiến lược — quyết định nút Phân tích bên site khách hàng chạy cái gì. */
  kind: StrategyKind;
  document_count: number;
  has_rules: boolean;
  symbols: string[];
  subscribers: number;
  stats_live: any;
};

/** Trần số mã một chiến lược — phải đủ chỗ cho nút "Toàn bộ danh mục" (hơn 1.500 mã). */
const MAX_SYMBOLS = 2000;

const OWNER_TABS = [
  { key: 'SYSTEM', label: 'Của hệ thống' },
  { key: 'USER', label: 'Của khách hàng' },
  { key: '', label: 'Tất cả' },
];

export default function AdminStrategiesPage() {
  const toast = useToast();
  const { can } = useStaffSession();

  const [signalFor, setSignalFor] = useState<AdminStrategy | null>(null);
  const [symbolsFor, setSymbolsFor] = useState<AdminStrategy | null>(null);
  // Mặc định chỉ xem chiến lược của hệ thống: đây là thứ nhân viên thật sự quản lý, và cũng là
  // thứ duy nhất lên được site khách hàng.
  const [ownerType, setOwnerType] = useState('SYSTEM');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const { page, size, setPage, setSize, reset } = usePagination(10);

  const { data, isLoading, refresh } = useApiQuery<Page<AdminStrategy>>(`${ADMIN}/strategies`, {
    page,
    size,
    owner_type: ownerType || undefined,
    q: search || undefined,
    status: statusFilter || undefined,
    kind: kindFilter || undefined,
  });
  const strategies = data?.items ?? [];

  const setStatus = useApiMutation<Message, { id: number; status: string }>(({ id, status }) =>
    api.post<Message>(`${ADMIN}/strategies/${id}/status`, undefined, { status }),
  );

  const hiddenCount = strategies.filter(
    (s) => s.owner_type === 'SYSTEM' && !s.visible_to_customers,
  ).length;

  return (
    <div className="flex h-full flex-col space-y-3">
      <PageHeader
        title="Chiến lược & tín hiệu"
        description="Quản lý chiến lược, phạm vi mã và nhập tín hiệu"
        infoTitle="Tín hiệu là bất biến"
        /* BR-840 — ràng buộc quan trọng nhất của phần này. */
        info={
          <p>
            Sau khi ghi nhận, tín hiệu <strong>không thể sửa hay xoá</strong> — kể cả Quản trị tối
            cao. Muốn huỷ một tín hiệu thì đánh dấu huỷ kèm lý do, bản ghi gốc vẫn được giữ nguyên.
            Nếu sửa được, toàn bộ thống kê hiệu suất trở nên vô nghĩa và không còn gì để bảo vệ bạn
            khi khách hàng khiếu nại.
          </p>
        }
        action={
          can('strategy.manage') ? (
            // Hai nút riêng thay vì một nút rồi hỏi loại ở trang sau: hai loại cần hai bộ thông
            // tin khác hẳn nhau, và chọn trước thì mỗi form chỉ hỏi đúng thứ nó cần.
            <div className="flex flex-wrap gap-2">
              <Link href="/admin/strategies/new?kind=RULE">
                <Button variant="outline" leftIcon={<Icon name="filter" size={15} />}>
                  Tạo theo điều kiện
                </Button>
              </Link>
              <Link href="/admin/strategies/new?kind=DOCUMENT">
                <Button leftIcon={<Icon name="document" size={15} />}>Tạo theo tài liệu</Button>
              </Link>
            </div>
          ) : undefined
        }
      />

      <Tabs
        items={OWNER_TABS}
        active={ownerType}
        onChange={(key) => {
          setOwnerType(key);
          reset();
        }}
      />

      <div className="shrink-0 grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem_14rem] sm:items-end">
        <SearchInput
          placeholder="Tên hoặc mã chiến lược…"
          value={search}
          onSearch={(value) => {
            setSearch(value);
            reset();
          }}
        />
        <Select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            reset();
          }}
          placeholder="Tất cả trạng thái"
          options={[
            { value: 'ACTIVE', label: 'Đang hoạt động' },
            { value: 'DRAFT', label: 'Nháp' },
            { value: 'ARCHIVED', label: 'Lưu trữ' },
          ]}
        />
        <Select
          value={kindFilter}
          onChange={(e) => {
            setKindFilter(e.target.value);
            reset();
          }}
          placeholder="Mọi loại chiến lược"
          options={statusOptions(STRATEGY_KIND)}
        />
      </div>

      {ownerType === 'USER' && (
        <Alert tone="info" title="Chiến lược cá nhân của khách hàng">
          Khách hàng tự tạo và tự quản lý. Chúng <strong>không bao giờ hiển thị</strong> ở danh
          sách chiến lược công khai — chỉ chính chủ và người được chia sẻ mới xem được. Nhân viên
          chỉ xem để hỗ trợ, không nhập tín hiệu hay sửa phạm vi mã được.
        </Alert>
      )}

      {ownerType !== 'USER' && hiddenCount > 0 && (
        <Alert tone="warning" title={`${hiddenCount} chiến lược chưa hiển thị với khách hàng`}>
          Chiến lược chỉ lên site khách hàng khi ở trạng thái <strong>Đang hoạt động</strong> và
          được đánh dấu <strong>công khai</strong>. Xem thẻ “Khách hàng không thấy” bên dưới để
          biết chiến lược nào đang thiếu điều kiện.
        </Alert>
      )}

      {isLoading ? (
        <Spinner label="Đang tải…" />
      ) : !strategies.length ? (
        <EmptyState
          title={
            search || statusFilter
              ? 'Không có chiến lược nào khớp bộ lọc'
              : 'Chưa có chiến lược nào'
          }
          description="Tạo chiến lược, thêm mã áp dụng, rồi nhập tín hiệu để hiển thị marker trên biểu đồ của khách hàng."
        />
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
          {strategies.map((strategy) => (
            <Card key={strategy.id}>
              <CardHeader
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {strategy.name}
                    <Badge tone="blue">{SCHOOL_LABEL[strategy.school] ?? strategy.school}</Badge>
                    <Badge
                      tone={
                        strategy.status === 'ACTIVE'
                          ? 'green'
                          : strategy.status === 'DRAFT'
                            ? 'amber'
                            : 'gray'
                      }
                    >
                      {strategy.status === 'ACTIVE'
                        ? 'Đang hoạt động'
                        : strategy.status === 'DRAFT'
                          ? 'Nháp'
                          : 'Lưu trữ'}
                    </Badge>

                    {/* Trạng thái ACTIVE **không** đồng nghĩa với "khách hàng nhìn thấy" — đây là
                        chỗ hai khái niệm hay bị nhầm, nên nói thẳng ra bằng một thẻ riêng. */}
                    <StatusBadge map={STRATEGY_KIND} code={strategy.kind} />
                    {strategy.kind === 'DOCUMENT' && (
                      <Badge tone="gray">{strategy.document_count} tài liệu</Badge>
                    )}
                    {strategy.kind === 'RULE' && !strategy.has_rules && (
                      <Badge tone="amber" title="Chưa dựng điều kiện thì nút Phân tích bên site khách hàng báo lỗi.">
                        Chưa có điều kiện
                      </Badge>
                    )}

                    {strategy.owner_type === 'USER' ? (
                      <Badge tone="purple">
                        Của khách hàng
                        {strategy.owner_name ? ` · ${strategy.owner_name}` : ''}
                      </Badge>
                    ) : strategy.visible_to_customers ? (
                      <Badge tone="green">Khách hàng thấy</Badge>
                    ) : (
                      <Badge tone="red">Khách hàng không thấy</Badge>
                    )}
                  </span>
                }
                description={`${strategy.code} · ${strategy.symbols.length} mã · ${strategy.subscribers} khách hàng đăng ký nhận tín hiệu`}
                action={
                  <div className="flex flex-wrap gap-2">
                    {can('signal.create') &&
                      strategy.status === 'ACTIVE' &&
                      strategy.owner_type === 'SYSTEM' && (
                        <Button size="sm" onClick={() => setSignalFor(strategy)}>
                          Nhập tín hiệu
                        </Button>
                      )}
                    {/* Chiến lược cá nhân là tài sản của khách hàng — nhân viên chỉ xem.
                        Backend cũng từ chối các thao tác này, đây chỉ là lớp giao diện. */}
                    {can('strategy.manage') && strategy.owner_type === 'SYSTEM' && (
                      <>
                        {/* Nhãn theo đúng loại: màn sửa chỉ hỏi thứ loại đó cần, giống màn tạo. */}
                        <Link href={`/admin/strategies/${strategy.id}/rules`}>
                          <Button size="sm" variant="outline">
                            {strategy.kind === 'DOCUMENT' ? 'Sửa tài liệu' : 'Sửa điều kiện'}
                          </Button>
                        </Link>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setSymbolsFor(strategy)}
                        >
                          Sửa phạm vi mã
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            const next = strategy.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE';
                            const result = await setStatus.mutate({ id: strategy.id, status: next });
                            if (result) {
                              toast.success(result.message);
                              refresh();
                            }
                          }}
                        >
                          {strategy.status === 'ACTIVE' ? 'Lưu trữ' : 'Kích hoạt'}
                        </Button>
                      </>
                    )}
                  </div>
                }
              />

              <div className="flex flex-wrap gap-1.5">
                {strategy.symbols.map((symbol) => (
                  <span
                    key={symbol}
                    className="rounded bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600"
                  >
                    {symbol}
                  </span>
                ))}
              </div>

              {strategy.stats_live?.total_trades > 0 && (
                <div className="mt-3 rounded-lg border border-green-200 bg-green-50/60 p-3">
                  <Badge tone="green" className="mb-2">
                    Thống kê tín hiệu thực
                  </Badge>
                  <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <div>
                      <dt className="text-xs text-ink-500">Số lệnh đã đóng</dt>
                      <dd className="font-medium">{strategy.stats_live.closed_trades}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-500">Winrate</dt>
                      <dd className="font-medium">{formatPercent(strategy.stats_live.win_rate)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-500">R trung bình</dt>
                      <dd className="font-medium">{formatR(strategy.stats_live.avg_r)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-500">Đang mở</dt>
                      <dd className="font-medium">{strategy.stats_live.open_trades}</dd>
                    </div>
                  </dl>
                </div>
              )}
            </Card>
          ))}

          <Pagination
            page={data!.page}
            pages={data!.pages}
            total={data!.total}
            size={data!.size}
            onPageChange={setPage}
            onSizeChange={setSize}
          />
        </div>
      )}

      {signalFor && (
        <SignalEditor
          strategy={signalFor}
          onClose={() => setSignalFor(null)}
          onSaved={(message) => {
            toast.success(message);
            setSignalFor(null);
            refresh();
          }}
        />
      )}

      {symbolsFor && (
        <SymbolsEditor
          strategy={symbolsFor}
          onClose={() => setSymbolsFor(null)}
          onSaved={(message) => {
            toast.success(message);
            setSymbolsFor(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function SignalEditor({
  strategy,
  onClose,
  onSaved,
}: {
  strategy: AdminStrategy;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState({
    symbol: strategy.symbols[0] ?? '',
    direction: 'BUY',
    signal_type: 'LIVE',
    entry_time: toInputDateTime(new Date().toISOString()),
    entry_price: '',
    sl: '',
    tp: '',
    reason_text: '',
  });
  const [confirming, setConfirming] = useState(false);

  const save = useApiMutation<{ id: number; message: string }, Record<string, unknown>>((body) =>
    api.post(`${ADMIN}/signals`, body),
  );

  const isLive = form.signal_type === 'LIVE';

  return (
    <>
      <Modal
        open={!confirming}
        onClose={onClose}
        title={`Nhập tín hiệu — ${strategy.name}`}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button
              disabled={!form.symbol || !form.entry_price || !form.entry_time}
              onClick={() => setConfirming(true)}
            >
              Tiếp tục
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {save.error && <Alert tone="danger">{save.error.message}</Alert>}

          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Mã cổ phiếu"
              required
              value={form.symbol}
              onChange={(e) => setForm({ ...form, symbol: e.target.value })}
              options={strategy.symbols.map((s) => ({ value: s, label: s }))}
            />
            <Select
              label="Chiều lệnh"
              required
              value={form.direction}
              onChange={(e) => setForm({ ...form, direction: e.target.value })}
              options={[
                { value: 'BUY', label: 'MUA' },
                { value: 'SELL', label: 'BÁN' },
              ]}
            />
          </div>

          {/* BR-841 — phân biệt tuyệt đối, và cảnh báo ngay tại chỗ nhập. */}
          <Select
            label="Loại tín hiệu"
            required
            value={form.signal_type}
            onChange={(e) => setForm({ ...form, signal_type: e.target.value })}
            options={[
              { value: 'LIVE', label: 'Tín hiệu thực (LIVE) — sẽ gửi thông báo tới khách hàng' },
              { value: 'BACKTEST', label: 'Mô phỏng (BACKTEST) — không gửi thông báo' },
            ]}
          />

          {isLive ? (
            <Alert tone="warning">
              Tín hiệu thực sẽ được <strong>gửi ngay tới Telegram</strong> của tất cả khách hàng đã
              đăng ký cặp ({strategy.name} × {form.symbol}). Kiểm tra kỹ số liệu trước khi ghi nhận.
            </Alert>
          ) : (
            <Alert tone="info">
              Tín hiệu mô phỏng chỉ dùng để thống kê và hiển thị trên biểu đồ với nhãn “Mô phỏng”.
              Không gửi thông báo và không bao giờ gộp chung với thống kê tín hiệu thực.
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Thời điểm vào lệnh"
              type="datetime-local"
              required
              value={form.entry_time}
              onChange={(e) => setForm({ ...form, entry_time: e.target.value })}
            />
            <Input
              label="Giá vào"
              placeholder="Ví dụ: 25000"
              type="number"
              required
              value={form.entry_price}
              onChange={(e) => setForm({ ...form, entry_price: e.target.value })}
            />
            <Input
              label="Cắt lỗ (SL)"
              placeholder="Ví dụ: 23500"
              type="number"
              value={form.sl}
              onChange={(e) => setForm({ ...form, sl: e.target.value })}
              hint={
                form.direction === 'BUY'
                  ? 'Với lệnh MUA: phải thấp hơn giá vào.'
                  : 'Với lệnh BÁN: phải cao hơn giá vào.'
              }
            />
            <Input
              label="Chốt lời (TP)"
              placeholder="Ví dụ: 28000"
              type="number"
              value={form.tp}
              onChange={(e) => setForm({ ...form, tp: e.target.value })}
            />
          </div>

          <Textarea
            label="Lý do vào lệnh"
            rows={3}
            value={form.reason_text}
            onChange={(e) => setForm({ ...form, reason_text: e.target.value })}
            placeholder="Ví dụ: Phá vùng cung D1, retest thành công."
            hint="Nội dung này hiển thị trong popup khi khách hàng chạm vào marker trên biểu đồ."
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Xác nhận ghi nhận tín hiệu"
        message={
          <div className="space-y-2">
            <p>
              <strong>
                {form.direction === 'BUY' ? 'MUA' : 'BÁN'} {form.symbol}
              </strong>{' '}
              @ {form.entry_price} · SL {form.sl || '—'} · TP {form.tp || '—'}
            </p>
            <p className="text-red-600">
              Sau khi ghi nhận, tín hiệu <strong>không thể sửa hay xoá</strong>.
              {isLive && ' Thông báo sẽ được gửi ngay tới khách hàng đã đăng ký.'}
            </p>
          </div>
        }
        confirmLabel="Ghi nhận tín hiệu"
        danger={isLive}
        loading={save.loading}
        onConfirm={async () => {
          const result = await save.mutate({
            strategy_id: strategy.id,
            symbol: form.symbol,
            direction: form.direction,
            signal_type: form.signal_type,
            entry_time: fromInputDateTime(form.entry_time),
            entry_price: Number(form.entry_price),
            sl: form.sl ? Number(form.sl) : null,
            tp: form.tp ? Number(form.tp) : null,
            reason_text: form.reason_text || null,
          });
          if (result) {
            setConfirming(false);
            onSaved(result.message);
          }
        }}
      />
    </>
  );
}

function SymbolsEditor({
  strategy,
  onClose,
  onSaved,
}: {
  strategy: AdminStrategy;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [symbols, setSymbols] = useState<string[]>(strategy.symbols);

  const save = useApiMutation<Message, string[]>((list) =>
    api.put<Message>(`${ADMIN}/strategies/${strategy.id}/symbols`, list),
  );

  const removed = strategy.symbols.filter((s) => !symbols.includes(s));
  const added = symbols.filter((s) => !strategy.symbols.includes(s));

  return (
    <Modal
      open
      onClose={onClose}
      title={`Phạm vi mã — ${strategy.name}`}
      description="Khách hàng chỉ đăng ký nhận tín hiệu được các mã trong danh sách này."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={save.loading}
            onClick={async () => {
              const result = await save.mutate(symbols);
              if (result) onSaved(result.message);
            }}
          >
            Lưu ({symbols.length} mã)
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.error && <Alert tone="danger">{save.error.message}</Alert>}

        <SymbolPicker
          value={symbols}
          onChange={setSymbols}
          label="Mã áp dụng"
          max={MAX_SYMBOLS}
          extraActions={
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSymbols(strategy.symbols)}
                disabled={added.length === 0 && removed.length === 0}
              >
                Khôi phục
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSymbols([])}
                disabled={symbols.length === 0}
              >
                Bỏ chọn tất cả
              </Button>
            </>
          }
          showSelectAll
          showExchangeBulk
          showUpload
          searchPath={`${ADMIN}/market/symbols/search`}
          codesPath={`${ADMIN}/market/symbols/codes`}
        />

        {/* BR-860c — không xoá âm thầm; cảnh báo trước hệ quả với khách hàng đã đăng ký. */}
        {removed.length > 0 && (
          <Alert tone="warning" title={`Sẽ gỡ ${removed.length} mã khỏi phạm vi`}>
            Các mã <strong>{removed.join(', ')}</strong> sẽ bị gỡ. Đăng ký nhận tín hiệu của khách
            hàng cho các mã này sẽ chuyển sang trạng thái tạm dừng và{' '}
            <strong>khách hàng sẽ nhận được thông báo giải thích</strong> — không xoá âm thầm.
          </Alert>
        )}

        {added.length > 0 && (
          <Alert tone="info">Sẽ thêm {added.length} mã mới: {added.join(', ')}</Alert>
        )}
      </div>
    </Modal>
  );
}
