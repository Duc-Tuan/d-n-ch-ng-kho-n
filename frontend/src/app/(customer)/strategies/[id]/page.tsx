'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AnalysisPanel } from '@/components/domain/AnalysisPanel';
import { StrategyChart } from '@/components/domain/StrategyChart';
import { StrategyRunView } from '@/components/domain/StrategyRunView';
import { SymbolCombobox } from '@/components/domain/SymbolCombobox';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Disclaimer,
  EmptyState,
  Icon,
  LockedContent,
  Modal,
  PageHeader,
  Pagination,
  Select,
  Spinner,
  StatusBadge,
  Tabs,
  TabPanel,
  Textarea,
} from '@/components/ui';
import { useApiMutation, useApiQuery, usePagination, useStrategyRun, useToast } from '@/hooks';
import { ApiError, CUSTOMER, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/datetime';
import { formatNumber, formatPercent, formatR } from '@/lib/format';
import { SCHOOL_LABEL, SIGNAL_RESULT, SIGNAL_TYPE } from '@/lib/status';
import type {
  MarkerResponse,
  OhlcvResponse,
  Page,
  Signal,
  Strategy,
} from '@/types';

const TABS = [
  { key: 'chart', label: 'Biểu đồ' },
  { key: 'ai', label: 'Phân tích' },
  { key: 'analyze', label: 'Thử trên mã khác' },
  { key: 'signals', label: 'Danh sách lệnh' },
  { key: 'questions', label: 'Hỏi đáp' },
];

export default function StrategyDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const toast = useToast();

  const strategyId = Number(params.id);
  const [symbol, setSymbol] = useState(searchParams.get('symbol') ?? '');
  const [signalType, setSignalType] = useState('');
  const [tab, setTab] = useState('chart');
  const [selectedSignalId, setSelectedSignalId] = useState<number | null>(null);
  const [askOpen, setAskOpen] = useState(false);

  const { data: strategy, isLoading, error } = useApiQuery<Strategy>(
    Number.isFinite(strategyId) ? `${CUSTOMER}/strategies/${strategyId}` : null,
  );

  useEffect(() => {
    if (!symbol && strategy?.symbols.length) setSymbol(strategy.symbols[0]);
  }, [strategy, symbol]);

  const { data: markers, isLoading: markersLoading } = useApiQuery<MarkerResponse>(
    strategy && symbol ? `${CUSTOMER}/strategies/${strategyId}/markers` : null,
    { symbol, signal_type: signalType || undefined },
  );

  // Nến thật của mã đang xem — marker được đặt lên chuỗi giá này thay vì chuỗi dựng tạm.
  const { data: ohlcv } = useApiQuery<OhlcvResponse>(
    symbol ? `${CUSTOMER}/market/ohlcv` : null,
    { symbol, limit: 500 },
  );

  if (isLoading) {
    return (
      <div className="py-20">
        <Spinner label="Đang tải chiến lược…" />
      </div>
    );
  }

  if (error instanceof ApiError && error.code === 'PACKAGE_TOO_LOW') {
    return (
      <div className="space-y-5">
        <PageHeader title="Chiến lược" />
        <LockedContent
          title="Chiến lược thuộc gói cao hơn"
          description={error.message}
        />
      </div>
    );
  }

  if (!strategy) {
    return <EmptyState title="Không tìm thấy chiến lược" />;
  }

  const signals = markers?.signals ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={
          <Link href="/strategies" className="hover:text-ink-700">
            ← Danh sách chiến lược
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {strategy.name}
            <Badge tone="blue">{SCHOOL_LABEL[strategy.school] ?? strategy.school}</Badge>
            <Badge tone="gray">{strategy.timeframe}</Badge>
          </span>
        }
        description={strategy.description ?? undefined}
        action={
          <div className="flex gap-2">
            <Link href={`/account/notifications?strategy=${strategy.id}&symbol=${symbol}`}>
              {/* Mục 15.1 — nút 🔔 đặt ngay trên màn biểu đồ, không bắt KH đi vòng vào trang cài đặt. */}
              <Button size="sm" variant="outline" leftIcon={<Icon name="bell" size={16} />}>
                Nhận tín hiệu
              </Button>
            </Link>
            <Button size="sm" onClick={() => setAskOpen(true)}>
              Hỏi chuyên viên
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        {/* Chiến lược có thể khai báo hàng trăm mã — dùng ô có tìm kiếm thay cho select dài. */}
        <SymbolCombobox
          value={symbol}
          onChange={(next) => {
            setSymbol(next);
            router.replace(`/strategies/${strategyId}?symbol=${next}`);
          }}
          options={strategy.symbols}
          className="w-44"
        />
        <Select
          label="Loại tín hiệu"
          value={signalType}
          onChange={(e) => setSignalType(e.target.value)}
          options={[
            { value: '', label: 'Cả hai loại' },
            { value: 'LIVE', label: 'Chỉ tín hiệu thực' },
            { value: 'BACKTEST', label: 'Chỉ mô phỏng' },
          ]}
          className="w-48"
        />
      </div>

      <Tabs items={TABS} active={tab} onChange={setTab} />

      <TabPanel active={tab} tabKey="chart">
        {markersLoading ? (
          <div className="py-16">
            <Spinner label="Đang tải tín hiệu…" />
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
            <StrategyChart
              signals={signals}
              candles={ohlcv?.candles}
              attribution={ohlcv?.attribution}
              truncated={markers?.truncated}
              maxMarkers={markers?.max_markers}
              selectedSignalId={selectedSignalId}
              onSelectSignal={(s) => setSelectedSignalId(s?.id ?? null)}
            />

            {/* Mục 13.2 bước 5 — panel danh sách lệnh, liên kết hai chiều với biểu đồ. */}
            <Card padded={false} className="overflow-hidden">
              <div className="border-b border-ink-100 px-4 py-3">
                <p className="text-sm font-semibold text-ink-900">
                  Lệnh trên {symbol} ({signals.length})
                </p>
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                {signals.length ? (
                  <ul className="divide-y divide-ink-100">
                    {[...signals].reverse().map((signal) => (
                      <li key={signal.id}>
                        <button
                          onClick={() => setSelectedSignalId(signal.id)}
                          className={cn(
                            'flex w-full min-h-touch items-start justify-between gap-2 px-4 py-2.5 text-left transition-colors',
                            selectedSignalId === signal.id
                              ? 'bg-ink-100'
                              : 'hover:bg-ink-50',
                          )}
                        >
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 text-sm font-medium">
                              <span
                                className={signal.direction === 'BUY' ? 'text-up' : 'text-down'}
                              >
                                {signal.direction === 'BUY' ? '▲ MUA' : '▼ BÁN'}
                              </span>
                              <span className="tabular-nums text-ink-700">
                                {formatNumber(signal.entry_price)}
                              </span>
                            </p>
                            <p className="mt-0.5 text-xs text-ink-500">
                              {formatDateTime(signal.entry_time)}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <StatusBadge
                              map={SIGNAL_TYPE}
                              code={signal.signal_type}
                              showHint={false}
                            />
                            <span className="text-xs tabular-nums text-ink-600">
                              {signal.r_multiple !== null ? formatR(signal.r_multiple) : '—'}
                            </span>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-4 py-10 text-center text-sm text-ink-500">
                    Chưa có tín hiệu nào trên mã này
                  </p>
                )}
              </div>
            </Card>
          </div>
        )}
      </TabPanel>

      <TabPanel active={tab} tabKey="ai">
        <AnalysisPanel strategyId={strategyId} symbol={symbol} kind={strategy.kind} />
      </TabPanel>

      <TabPanel active={tab} tabKey="analyze">
        <AnalyzePanel strategyId={strategyId} strategyName={strategy.name} />
      </TabPanel>

      <TabPanel active={tab} tabKey="signals">
        <SignalTable strategyId={strategyId} symbol={symbol} />
      </TabPanel>

      <TabPanel active={tab} tabKey="questions">
        <QuestionList strategyId={strategyId} onAsk={() => setAskOpen(true)} />
      </TabPanel>

      {/* Không có khối "Tài liệu hướng dẫn" ở đây, và đó là chủ ý: tài liệu của chiến lược
          hệ thống là căn cứ nội bộ cho AI đọc, không phải nội dung bán cho khách (BR-848).
          Backend cũng đã bỏ endpoint tương ứng — ẩn nút không thì chưa đủ. */}

      {/* BR-843 — thống kê hiển thị cùng biểu đồ, tách LIVE/BACKTEST và nêu rõ khoảng thời gian. */}
      <StatsPanel strategy={strategy} />

      {/* BR-844 — disclaimer cố định dưới mỗi biểu đồ chiến lược. */}
      <Disclaimer />

      <AskQuestionModal
        open={askOpen}
        onClose={() => setAskOpen(false)}
        strategyId={strategyId}
        signalId={selectedSignalId}
        onSuccess={() => {
          toast.success('Đã gửi câu hỏi. Chuyên viên sẽ trả lời trong 24 giờ làm việc.');
          setAskOpen(false);
        }}
      />
    </div>
  );
}

/**
 * YC12 — áp chiến lược của công ty lên một mã bất kỳ để khách tự đánh giá.
 *
 * Đây là chỗ khách hàng nhìn thấy giá trị của chiến lược một cách khách quan: cùng bộ quy tắc
 * đó, nếu đầu tư vào mã họ quan tâm thì ra điểm mua bán nào, lãi lỗ thế nào.
 *
 * BR-848 — kết quả trả về **không kèm** công thức bên trong. `StrategyRunView` tự ẩn phần quy
 * tắc khi máy chủ không gửi, nên ở đây không cần xử lý gì thêm.
 */
function AnalyzePanel({ strategyId, strategyName }: { strategyId: number; strategyName: string }) {
  const toast = useToast();
  const [symbol, setSymbol] = useState('');
  const runner = useStrategyRun(`${CUSTOMER}/market/ohlcv`);

  const execute = async () => {
    if (!symbol) {
      toast.error('Chọn mã cổ phiếu trước khi chạy');
      return;
    }
    const result = await runner.run(`${CUSTOMER}/strategies/${strategyId}/run`, symbol);
    if (!result && runner.error) toast.error(runner.error);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={`Thử “${strategyName}” trên một mã bất kỳ`}
          description="Chọn mã bạn quan tâm để xem chiến lược này sinh ra điểm mua bán nào trong quá khứ và kết quả ra sao."
        />

        <div className="flex flex-wrap items-end gap-3">
          <SymbolCombobox value={symbol} onChange={setSymbol} className="w-56" />
          <Button
            loading={runner.loading}
            leftIcon={<Icon name="chart" size={16} />}
            onClick={() => void execute()}
          >
            Chạy phân tích
          </Button>
        </div>

        <Alert tone="info" className="mt-3">
          Kết quả cho bạn thấy chiến lược này <strong>làm được gì</strong>. Quy tắc chi tiết bên
          trong là chất xám của đội phân tích nên không hiển thị — nhưng mọi điểm mua bán và số
          liệu lãi lỗ đều là kết quả thật của chính bộ quy tắc đó trên dữ liệu lịch sử.
        </Alert>
      </Card>

      {runner.error && <Alert tone="danger">{runner.error}</Alert>}

      {runner.loading ? (
        <Card>
          <div className="py-16">
            <Spinner label={`Đang chạy chiến lược trên ${symbol}…`} />
          </div>
        </Card>
      ) : runner.result ? (
        <StrategyRunView
          result={runner.result}
          candles={runner.candles}
          ohlcvEndpoint={runner.ohlcvEndpoint}
        />
      ) : (
        <EmptyState
          title="Chưa chạy phân tích"
          description="Chọn một mã rồi bấm Chạy phân tích để xem kết quả trên biểu đồ."
        />
      )}
    </div>
  );
}

function StatsPanel({ strategy }: { strategy: Strategy }) {
  const blocks = [
    { label: 'Tín hiệu thực', stats: strategy.stats_live, live: true },
    { label: 'Mô phỏng', stats: strategy.stats_backtest, live: false },
  ];

  return (
    <Card>
      <CardHeader
        title="Thống kê hiệu suất"
        description="Tín hiệu thực và tín hiệu mô phỏng luôn được tính riêng, không bao giờ gộp chung."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {blocks.map(({ label, stats, live }) => (
          <div
            key={label}
            className={cn(
              'rounded-lg border p-3',
              live
          ? 'border-tone-green-line bg-tone-green-bg/60'
          : 'border-dashed border-line-strong bg-ink-50',
            )}
          >
            <Badge tone={live ? 'green' : 'gray'} className="mb-2">
              {label}
            </Badge>
            {stats && stats.total_trades > 0 ? (
              <>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <Stat label="Tổng số lệnh" value={stats.total_trades} />
                  <Stat label="Đã đóng" value={stats.closed_trades} />
                  <Stat label="Winrate" value={formatPercent(stats.win_rate)} />
                  <Stat label="R trung bình" value={formatR(stats.avg_r)} />
                  <Stat
                    label="Sụt giảm lớn nhất"
                    value={stats.max_dd !== null ? `${stats.max_dd.toFixed(2)}R` : '—'}
                  />
                  <Stat
                    label="Profit factor"
                    value={stats.profit_factor?.toFixed(2) ?? '—'}
                  />
                </dl>
                <p className="mt-2 text-xs text-ink-500">
                  Khoảng thời gian tính: {stats.period_from} – {stats.period_to}
                </p>
              </>
            ) : (
              <p className="text-sm text-ink-400">Chưa có dữ liệu</p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="font-medium tabular-nums text-ink-900">{value}</dd>
    </div>
  );
}

function SignalTable({ strategyId, symbol }: { strategyId: number; symbol: string }) {
  // Trước đây cắt cứng 50 lệnh gần nhất và không có cách xem tiếp — chiến lược chạy lâu thì phần
  // lịch sử cũ biến mất khỏi giao diện dù dữ liệu vẫn còn.
  const { page, size, setPage, setSize } = usePagination(20);
  const { data, isLoading } = useApiQuery<Page<Signal>>(
    `${CUSTOMER}/strategies/${strategyId}/signals`,
    { symbol: symbol || undefined, page, size },
  );

  if (isLoading) return <Spinner label="Đang tải…" />;
  if (!data?.items.length) return <EmptyState title="Chưa có lệnh nào" />;

  return (
    <div className="rounded-xl border border-ink-200 bg-surface">
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-ink-200 bg-ink-50">
          <tr>
            {['Mã', 'Chiều', 'Loại', 'Vào lệnh', 'Giá vào', 'SL', 'TP', 'Kết quả', 'R'].map((h) => (
              <th key={h} className="whitespace-nowrap px-3 py-2.5 text-left font-medium text-ink-600">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {data.items.map((s) => (
            <tr key={s.id}>
              <td className="px-3 py-2.5 font-medium">{s.symbol}</td>
              <td className={cn('px-3 py-2.5 font-medium', s.direction === 'BUY' ? 'text-up' : 'text-down')}>
                {s.direction === 'BUY' ? 'MUA' : 'BÁN'}
              </td>
              <td className="px-3 py-2.5">
                <StatusBadge map={SIGNAL_TYPE} code={s.signal_type} />
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-ink-600">
                {formatDateTime(s.entry_time)}
              </td>
              <td className="px-3 py-2.5 tabular-nums">{formatNumber(s.entry_price)}</td>
              <td className="px-3 py-2.5 tabular-nums text-ink-500">{formatNumber(s.sl)}</td>
              <td className="px-3 py-2.5 tabular-nums text-ink-500">{formatNumber(s.tp)}</td>
              <td className="px-3 py-2.5">
                <StatusBadge map={SIGNAL_RESULT} code={s.result} />
              </td>
              <td className="px-3 py-2.5 tabular-nums">{formatR(s.r_multiple)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <div className="border-t border-ink-100 px-4">
        <Pagination
          page={data.page}
          pages={data.pages}
          total={data.total}
          size={data.size}
          onPageChange={setPage}
          onSizeChange={setSize}
        />
      </div>
    </div>
  );
}

function QuestionList({ strategyId, onAsk }: { strategyId: number; onAsk: () => void }) {
  const minePage = usePagination(10);
  const faqPage = usePagination(10);

  const { data: mine } = useApiQuery<Page<any>>(`${CUSTOMER}/strategies/${strategyId}/questions`, {
    page: minePage.page,
    size: minePage.size,
  });
  const { data: faq } = useApiQuery<Page<any>>(`${CUSTOMER}/strategies/${strategyId}/faq`, {
    page: faqPage.page,
    size: faqPage.size,
  });

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Câu hỏi của bạn"
          description="Chỉ bạn nhìn thấy các câu hỏi này."
          action={
            <Button size="sm" onClick={onAsk}>
              Đặt câu hỏi
            </Button>
          }
        />
        {mine?.items.length ? (
          <ul className="divide-y divide-ink-100">
            {mine.items.map((q) => (
              <li key={q.id} className="py-3">
                <p className="text-sm font-medium text-ink-900">{q.question}</p>
                <p className="mt-0.5 text-xs text-ink-500">
                  {formatDateTime(q.created_at)} ·{' '}
                  {q.status === 'PENDING' ? 'Đang chờ trả lời' : 'Đã trả lời'}
                </p>
                {q.answer && (
                  <div className="mt-2 rounded-lg bg-ink-100 p-3 text-sm text-ink-700">
                    {q.answer}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="Bạn chưa đặt câu hỏi nào"
            description="Có thắc mắc về một lệnh cụ thể? Bấm vào marker trên biểu đồ rồi đặt câu hỏi ngay tại đó."
          />
        )}
        {mine && (
          <Pagination
            page={mine.page}
            pages={mine.pages}
            total={mine.total}
            size={mine.size}
            onPageChange={minePage.setPage}
          />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Câu hỏi thường gặp"
          description="Các câu hỏi đã được chuyên viên duyệt công khai (đã ẩn danh người hỏi)."
        />
        {faq?.items.length ? (
          <ul className="divide-y divide-ink-100">
            {faq.items.map((item) => (
              <li key={item.id} className="py-3">
                <p className="text-sm font-medium text-ink-900">{item.question}</p>
                <p className="mt-1 text-sm text-ink-600">{item.answer}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-ink-500">Chưa có câu hỏi công khai nào</p>
        )}
        {faq && (
          <Pagination
            page={faq.page}
            pages={faq.pages}
            total={faq.total}
            size={faq.size}
            onPageChange={faqPage.setPage}
          />
        )}
      </Card>
    </div>
  );
}

function AskQuestionModal({
  open,
  onClose,
  strategyId,
  signalId,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  strategyId: number;
  signalId: number | null;
  onSuccess: () => void;
}) {
  const [question, setQuestion] = useState('');

  const ask = useApiMutation<unknown, { strategy_id: number; signal_id: number | null; question: string }>(
    (input) => api.post(`${CUSTOMER}/strategies/${strategyId}/questions`, input),
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Đặt câu hỏi cho chuyên viên"
      description="Cam kết trả lời trong 24 giờ làm việc."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={ask.loading}
            disabled={question.trim().length < 5}
            onClick={async () => {
              const result = await ask.mutate({
                strategy_id: strategyId,
                signal_id: signalId,
                question: question.trim(),
              });
              if (result) {
                setQuestion('');
                onSuccess();
              }
            }}
          >
            Gửi câu hỏi
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {ask.error && <Alert tone="danger">{ask.error.message}</Alert>}
        {signalId && (
          <Alert tone="info">Câu hỏi này sẽ được gắn với lệnh bạn đang chọn trên biểu đồ.</Alert>
        )}
        <Textarea
          label="Nội dung câu hỏi"
          required
          rows={5}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ví dụ: Vì sao chiến lược vào lệnh tại điểm này mà không chờ retest sâu hơn?"
          hint="Câu hỏi của bạn là riêng tư. Nếu hữu ích cho nhiều người, chuyên viên có thể xin phép công khai (đã ẩn danh)."
        />
      </div>
    </Modal>
  );
}

