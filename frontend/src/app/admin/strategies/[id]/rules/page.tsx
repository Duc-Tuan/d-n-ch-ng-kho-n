'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { RuleBuilder, emptyRules } from '@/components/domain/RuleBuilder';
import { StrategyRunView } from '@/components/domain/StrategyRunView';
import { SymbolCombobox } from '@/components/domain/SymbolCombobox';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Icon,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui';
import { useApiQuery, useRuleCatalog, useStaffSession, useStrategyRun, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import type { DocumentItem, Message, StrategyKind, StrategyRules } from '@/types';

/**
 * Sửa chiến lược của hệ thống (YC10, YC14).
 *
 * Màn này **tách theo loại chiến lược đúng như màn tạo**: loại theo điều kiện chỉ thấy phần dựng
 * điều kiện và chạy thử, loại theo tài liệu chỉ thấy phần tài liệu. Trước đây cả hai khối cùng
 * hiện ở đây nên một chiến lược trông như thể mang được cả hai — trong khi backend từ chối một
 * nửa số thao tác (`_require_kind`) và nút Phân tích bên site khách hàng chỉ chạy đúng một cái.
 * Người sửa không có cách nào biết mình đang nhìn phần vô nghĩa cho tới lúc bấm Lưu và nhận lỗi.
 *
 * Trang riêng chứ không phải popup: người dùng cần vừa sửa điều kiện vừa nhìn biểu đồ kết quả,
 * hai thứ đó không đặt vừa trong một hộp thoại.
 */
type StrategyEditData = {
  strategy_id: number;
  name: string;
  kind: StrategyKind;
  rules: StrategyRules | null;
  symbols: string[];
};

export default function StrategyEditPage() {
  const params = useParams<{ id: string }>();
  const strategyId = Number(params.id);
  const { can } = useStaffSession();

  const { data, isLoading, refresh } = useApiQuery<StrategyEditData>(
    Number.isFinite(strategyId) ? `${ADMIN}/strategies/${strategyId}/rules` : null,
  );

  if (!can('strategy.manage')) {
    return (
      <div className="space-y-4">
        <PageHeader title="Sửa chiến lược" />
        <Alert tone="warning" title="Không đủ quyền">
          Chỉ người có quyền quản lý chiến lược mới sửa được chiến lược.
        </Alert>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="py-20">
        <Spinner label="Đang tải chiến lược…" />
      </div>
    );
  }

  if (!data) {
    return <EmptyState title="Không tìm thấy chiến lược" />;
  }

  // Hai loại, hai màn khác hẳn nhau — tách thành hai thành phần để mỗi bên chỉ nạp đúng thứ nó
  // dùng: màn tài liệu không cần danh mục chỉ báo, màn điều kiện không cần kho tài liệu.
  return data.kind === 'DOCUMENT' ? (
    <DocumentStrategyEditor strategyId={strategyId} name={data.name} />
  ) : (
    <RuleStrategyEditor strategyId={strategyId} data={data} refresh={refresh} />
  );
}

/* ====================================================================
 * LOẠI THEO ĐIỀU KIỆN — dựng bộ lọc và chạy thử. Không có tài liệu.
 * ================================================================== */
function RuleStrategyEditor({
  strategyId,
  data,
  refresh,
}: {
  strategyId: number;
  data: StrategyEditData;
  refresh: () => void;
}) {
  const toast = useToast();

  const [rules, setRules] = useState<StrategyRules>(data.rules ?? emptyRules());
  const [symbol, setSymbol] = useState(data.symbols[0] ?? '');
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const catalog = useRuleCatalog(`${ADMIN}/strategies/catalog`);
  const runner = useStrategyRun(`${ADMIN}/market/ohlcv`);

  // Sau khi lưu, `refresh` mang về bản mới — đồng bộ lại để mốc "bản đã lưu" không lệch.
  useEffect(() => setRules(data.rules ?? emptyRules()), [data.rules]);

  /** Chạy thử bộ lọc **đang sửa**, không phải bộ lọc đã lưu. */
  const tryRun = async () => {
    if (!symbol) {
      toast.error('Chọn mã để chạy thử');
      return;
    }
    const result = await runner.run(`${ADMIN}/strategies/try`, symbol, { body: { symbol, rules } });
    if (!result && runner.error) toast.error(runner.error);
  };

  const save = async (next: StrategyRules | null) => {
    setSaving(true);
    try {
      const result = await api.put<Message>(`${ADMIN}/strategies/${strategyId}/rules`, {
        rules: next,
      });
      toast.success(result.message);
      refresh();
    } catch (err) {
      toast.error((err as Error).message ?? 'Không lưu được bộ lọc');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={
          <Link href="/admin/strategies" className="hover:text-ink-700">
            ← Chiến lược &amp; tín hiệu
          </Link>
        }
        title={`Bộ điều kiện — ${data.name}`}
        description="Điều kiện máy chạy được, dùng để sinh điểm mua bán trên biểu đồ của khách hàng"
        action={
          data.rules ? (
            <Button variant="ghost" disabled={saving} onClick={() => setConfirmClear(true)}>
              Gỡ bộ lọc
            </Button>
          ) : undefined
        }
      />

      <Alert tone="info" title="Khách hàng thấy gì">
        Khách hàng chạy được chiến lược này lên mã bất kỳ và xem toàn bộ điểm mua bán, lãi lỗ từng
        lệnh. Nhưng <strong>nội dung điều kiện bên trong không bao giờ được gửi ra</strong> — đó là
        chất xám của đội phân tích. Việc chặn nằm ở tầng API chứ không phải ở giao diện, nên khách
        có mở công cụ nhà phát triển cũng không đọc được.
      </Alert>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
        {/* ---------- CỘT TRÁI: DỰNG ĐIỀU KIỆN ---------- */}
        <div className="space-y-4">
          {!catalog ? (
            <Card>
              <div className="py-12">
                <Spinner label="Đang tải danh mục chỉ báo…" />
              </div>
            </Card>
          ) : (
            <>
              <RuleBuilder value={rules} onChange={setRules} catalog={catalog} disabled={saving} />

              <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-ink-200 bg-surface py-3">
                <Button loading={saving} onClick={() => void save(rules)}>
                  Lưu bộ lọc
                </Button>
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() => setRules(data.rules ?? emptyRules())}
                >
                  Khôi phục bản đã lưu
                </Button>
              </div>
            </>
          )}
        </div>

        {/* ---------- CỘT PHẢI: CHẠY THỬ ---------- */}
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Chạy thử"
              description="Dùng bộ lọc đang sửa trên màn này, chưa cần lưu."
            />
            <div className="flex flex-wrap items-end gap-3">
              <SymbolCombobox
                value={symbol}
                onChange={setSymbol}
                className="w-56"
                hint={data.symbols.length ? `Phạm vi mã: ${data.symbols.join(', ')}` : undefined}
              />
              <Button
                loading={runner.loading}
                leftIcon={<Icon name="chart" size={16} />}
                onClick={() => void tryRun()}
              >
                Chạy thử
              </Button>
            </div>
          </Card>

          {runner.error && <Alert tone="danger">{runner.error}</Alert>}

          {runner.loading ? (
            <Card>
              <div className="py-16">
                <Spinner label={`Đang chạy trên ${symbol}…`} />
              </div>
            </Card>
          ) : runner.result ? (
            <StrategyRunView
              result={runner.result}
              candles={runner.candles}
              height={380}
              ohlcvEndpoint={runner.ohlcvEndpoint}
            />
          ) : (
            <EmptyState
              title="Chưa chạy thử"
              description="Dựng điều kiện bên trái, chọn một mã rồi bấm Chạy thử để xem kết quả trước khi lưu."
            />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Gỡ bộ lọc phân tích?"
        message="Chiến lược sẽ quay về chế độ phát tín hiệu thủ công. Khách hàng không chạy phân tích tự động lên mã của họ được nữa. Các tín hiệu đã phát vẫn giữ nguyên."
        confirmLabel="Gỡ bộ lọc"
        danger
        onConfirm={async () => {
          await save(null);
          setConfirmClear(false);
        }}
      />
    </div>
  );
}

/* ====================================================================
 * LOẠI THEO TÀI LIỆU — chỉ quản lý tài liệu. Không có bộ điều kiện.
 * ================================================================== */
function DocumentStrategyEditor({ strategyId, name }: { strategyId: number; name: string }) {
  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={
          <Link href="/admin/strategies" className="hover:text-ink-700">
            ← Chiến lược &amp; tín hiệu
          </Link>
        }
        title={`Tài liệu phân tích — ${name}`}
        description="AI đọc các tài liệu này rồi viết nhận định khi khách hàng bấm Phân tích"
      />

      <Alert tone="info" title="Chiến lược theo tài liệu không có bộ điều kiện">
        Loại này chạy bằng AI đọc tài liệu, không chạy điều kiện máy. Muốn dùng điều kiện vào/thoát
        lệnh thì <strong>tạo một chiến lược theo điều kiện</strong> — hai loại không đổi qua lại
        được vì mọi tín hiệu đã phát đều gắn với mã chiến lược cũ.
      </Alert>

      <StrategyDocuments strategyId={strategyId} />
    </div>
  );
}

/**
 * YC14 — tài liệu đính kèm chiến lược.
 *
 * Chỉ chọn từ kho tài liệu, không tải file thẳng ở đây. Tài liệu chiến lược cần đúng bộ bảo vệ
 * của kho: kiểm tra gói, đóng dấu chìm theo từng khách, ghi nhật ký từng lượt tải. Mở một đường
 * tải riêng cho chiến lược là mở một lối đi vòng qua tất cả những thứ đó.
 */
function StrategyDocuments({ strategyId }: { strategyId: number }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState('');

  const { data, refresh } = useApiQuery<StrategyDocument[]>(
    `${ADMIN}/strategies/${strategyId}/documents`,
  );
  const { data: library } = useApiQuery<{ items: DocumentItem[] }>(
    adding ? `${ADMIN}/documents` : null,
    { size: 100 },
  );

  const attached = new Set((data ?? []).map((d) => d.document_id));
  const available = (library?.items ?? []).filter((d) => !attached.has(d.id));

  const attach = async () => {
    if (!picked) return;
    try {
      const result = await api.post<Message>(`${ADMIN}/strategies/${strategyId}/documents`, {
        document_id: Number(picked),
      });
      toast.success(result.message);
      setPicked('');
      setAdding(false);
      refresh();
    } catch (err) {
      toast.error((err as Error).message ?? 'Không gắn được tài liệu');
    }
  };

  const detach = async (documentId: number) => {
    try {
      const result = await api.del<Message>(
        `${ADMIN}/strategies/${strategyId}/documents/${documentId}`,
      );
      toast.success(result.message);
      refresh();
    } catch (err) {
      toast.error((err as Error).message ?? 'Không gỡ được tài liệu');
    }
  };

  return (
    <Card>
      <CardHeader
        title="Tài liệu đính kèm"
        description="PDF có lớp văn bản là định dạng duy nhất AI đọc được. Khách hàng đủ điều kiện gói cũng tải được các tài liệu này ở màn chiến lược."
        action={
          <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Đóng' : 'Gắn tài liệu'}
          </Button>
        }
      />

      {adding && (
        <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-ink-200 bg-ink-50 p-3">
          <Select
            label="Chọn từ kho tài liệu"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            placeholder={available.length ? 'Chọn tài liệu…' : 'Kho không còn tài liệu nào chưa gắn'}
            options={available.map((d) => ({ value: d.id, label: d.title }))}
            className="min-w-[16rem] flex-1"
          />
          <Button size="sm" disabled={!picked} onClick={() => void attach()}>
            Gắn vào chiến lược
          </Button>
          <Link href="/admin/documents">
            <Button size="sm" variant="ghost" leftIcon={<Icon name="upload" size={15} />}>
              Tải tài liệu mới
            </Button>
          </Link>
        </div>
      )}

      {!data?.length ? (
        <p className="rounded-lg border border-dashed border-ink-200 px-3 py-6 text-center text-sm text-ink-500">
          Chưa có tài liệu nào đính kèm. <strong>Chưa có tài liệu thì nút Phân tích bên site khách
          hàng không có gì để đọc</strong> — đừng kích hoạt chiến lược trước khi gắn.
        </p>
      ) : (
        <ul className="divide-y divide-ink-100">
          {data.map((doc) => (
            <li key={doc.link_id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate font-medium text-ink-900">{doc.title}</p>
                <p className="text-xs text-ink-500">
                  {doc.original_name} · {Math.round(doc.file_size / 1024)} KB
                  {doc.min_package_id ? ' · giới hạn theo gói' : ''}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void detach(doc.document_id)}>
                <Icon name="trash" size={15} />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type StrategyDocument = {
  link_id: number;
  document_id: number;
  title: string;
  original_name: string;
  file_size: number;
  min_package_id: number | null;
};
