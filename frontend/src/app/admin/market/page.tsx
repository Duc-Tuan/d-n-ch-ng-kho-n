'use client';

import { useEffect, useRef, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  Icon,
  Input,
  Modal,
  PageHeader,
  Pagination,
  RowAction,
  SearchInput,
  Select,
  Spinner,
  StatCard,
  Table,
  Tabs,
  Textarea,
  type Column,
} from '@/components/ui';
import { useApiMutation, useApiQuery, usePagination, useStaffSession, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/datetime';
import { formatDuration, formatNumber } from '@/lib/format';
import type { Message, Page } from '@/types';

/**
 * Dữ liệu thị trường (Phần 12).
 *
 * Màn này tồn tại để trả lời đúng một câu khi có sự cố: **dữ liệu giá có đủ và có mới không**.
 * Toàn bộ backtest, thống kê hiệu suất và việc chốt kết quả tín hiệu đều chạy trên bảng giá lưu
 * tại chỗ (BR-832), nên một mã thiếu dữ liệu không phải là thiếu một dòng — nó làm sai mọi con số
 * thống kê tính từ mã đó, mà lại không có thông báo lỗi nào.
 */

type MarketSymbol = {
  id: number;
  symbol: string;
  exchange: string;
  company_name: string | null;
  industry: string | null;
  tier: 'A' | 'B' | 'C' | null;
  is_active: boolean;
  last_ohlcv_date: string | null;
  last_synced_at: string | null;
  bars: number;
  data_state: 'ok' | 'stale' | 'missing';
};

type SyncLog = {
  id: number;
  run_date: string;
  symbols_total: number;
  symbols_synced: number;
  symbols_failed: number;
  rows_written: number;
  duration_seconds: number | null;
  anomalies: { items?: Array<{ symbol: string; issue: string }>; count?: number } | null;
  created_at: string;
};

/** Độ phủ của một khung — khớp `market_data.bars.coverage()`. */
type TimeframeCoverage = {
  code: string;
  label: string;
  short_label: string;
  seconds: number;
  intraday: boolean;
  /** Khung gộp lúc đọc: số liệu của nó là số liệu khung gốc, không có bảng lưu riêng. */
  derived: boolean;
  derive_from: string | null;
  retention_days: number | null;
  bars: number;
  symbols: number;
  oldest: string | null;
  latest: string | null;
  sync_enabled: boolean;
};

type Overview = {
  symbols_total: number;
  symbols_with_data: number;
  bars_total: number;
  latest_trade_date: string | null;
  coverage_pct: number;
  symbols_stale: number;
  stale_after_days: number;
  by_exchange: Array<{ exchange: string; total: number; with_data: number }>;
  timeframes: TimeframeCoverage[];
  last_sync: SyncLog | null;
};

/** Tiến độ mẻ đồng bộ toàn danh mục — khớp với `market_data.fullsync.snapshot()`. */
type FullSyncProgress = {
  state: 'idle' | 'running' | 'done' | 'stopped' | 'failed';
  total: number;
  processed: number;
  synced: number;
  failed: number;
  skipped: number;
  rows_written: number;
  current_symbol: string | null;
  current_timeframe: string | null;
  timeframes: string[];
  percent: number;
  started_at: string | null;
  finished_at: string | null;
  elapsed_seconds: number | null;
  eta_seconds: number | null;
  triggered_by: string | null;
  days: number;
  force_full: boolean;
  stop_requested: boolean;
  message: string | null;
  errors: Array<{ symbol: string; issue: string }>;
  /** Lich tu chay - dat o man Cau hinh he thong, ap ngay khong can khoi dong lai. */
  schedule?: {
    enabled: boolean;
    interval_hours: number;
    next_run: string | null;
    scheduler_running: boolean;
  };
};

/** Trang thai bo lay gia thoi gian thuc - khop `quote_store.store.status()`. */
type RealtimeStatus = {
  enabled: boolean;
  provider: string;
  interval_seconds: number;
  quotes: number;
  symbols_tracked: number;
  as_of: string | null;
  stale: boolean;
  session: string;
  session_label: string;
  in_session_window: boolean;
  last_poll_at: string | null;
  last_duration_ms: number | null;
  last_error: string | null;
  consecutive_errors: number;
  polls_ok: number;
  polls_failed: number;
  subscribers: number;
  subscribed_symbols: number;
  intraday_sync_minutes: number;
  window: { start: string; end: string };
};

const SYNC_STATE = {
  idle: { label: 'Chưa chạy lần nào', tone: 'gray' as const, bar: 'bg-ink-300' },
  running: { label: 'Đang chạy', tone: 'blue' as const, bar: 'bg-blue-600' },
  done: { label: 'Hoàn tất', tone: 'green' as const, bar: 'bg-green-600' },
  stopped: { label: 'Đã dừng giữa chừng', tone: 'amber' as const, bar: 'bg-amber-500' },
  failed: { label: 'Lỗi', tone: 'red' as const, bar: 'bg-red-600' },
};

const DATA_STATE = {
  ok: { label: 'Đủ dữ liệu', tone: 'green' as const },
  stale: { label: 'Chậm dữ liệu', tone: 'amber' as const },
  missing: { label: 'Chưa có giá', tone: 'red' as const },
};

/** Mức độ phù hợp để giao dịch theo tín hiệu — do bộ phận phân tích xếp, xem danh mục mã ở backend. */
const TIER_TONE = { A: 'green' as const, B: 'blue' as const, C: 'gray' as const };
const TIER_HINT = {
  A: 'Thanh khoản tốt, biên độ đủ rộng — ưu tiên vào lệnh',
  B: 'Giao dịch được, cần cân nhắc khối lượng',
  C: 'Theo dõi tham khảo, hạn chế vào lệnh',
};

const TABS = [
  { key: 'overview', label: 'Tổng quan & đồng bộ' },
  { key: 'symbols', label: 'Danh mục mã' },
  { key: 'logs', label: 'Nhật ký đồng bộ' },
];

export default function AdminMarketPage() {
  const { can } = useStaffSession();
  const [tab, setTab] = useState('overview');

  return (
    <div className="flex h-full flex-col space-y-3">
      {/* <PageHeader
        title="Dữ liệu thị trường"
        description="Danh mục mã niêm yết, độ phủ dữ liệu giá và nhật ký các mẻ đồng bộ"
        infoTitle="Vì sao cần theo dõi"
        info={
          <p>
            Backtest, thống kê hiệu suất và việc chốt kết quả tín hiệu đều chạy trên bảng giá lưu
            tại chỗ. Một mã thiếu dữ liệu không báo lỗi ở đâu cả — nó chỉ lặng lẽ làm sai mọi con
            số tính từ mã đó. Vì vậy hãy xử lý các mã ở trạng thái <strong>Chưa có giá</strong> và{' '}
            <strong>Chậm dữ liệu</strong> trước khi tin vào thống kê.
          </p>
        }
      /> */}

      <Tabs items={TABS} active={tab} onChange={setTab} />

      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'overview' && <OverviewTab canRun={can('sync.run')} />}
        {tab === 'symbols' && (
          <SymbolTable canRun={can('sync.run')} canManage={can('symbol.manage')} />
        )}
        {tab === 'logs' && <SyncLogList />}
      </div>
    </div>
  );
}

/** Số liệu độ phủ và bảng điều khiển đồng bộ — tách riêng để hai tab bảng bên cạnh dùng hết chiều cao. */
function OverviewTab({ canRun }: { canRun: boolean }) {
  const { data: overview, isLoading, refresh } = useApiQuery<Overview>(`${ADMIN}/market/overview`);

  if (isLoading) {
    return (
      <div className="py-16">
        <Spinner label="Đang tải số liệu…" />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pt-1">
      <OverviewCards overview={overview} />
      <RealtimePanel />
      <FullSyncCard canRun={canRun} timeframes={overview?.timeframes ?? []} onDone={refresh} />
      <TimeframeCoverageCard overview={overview} />
      <SyncPanel overview={overview} canRun={canRun} onDone={refresh} />
    </div>
  );
}

function OverviewCards({ overview }: { overview: Overview | undefined }) {
  if (!overview) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Mã đang niêm yết"
        value={formatNumber(overview.symbols_total)}
        sub={`${overview.by_exchange.map((e) => `${e.exchange} ${e.total}`).join(' · ') || '—'}`}
        icon={<Icon name="chart" size={18} />}
      />
      <StatCard
        label="Độ phủ dữ liệu giá"
        value={`${overview.coverage_pct}%`}
        sub={`${formatNumber(overview.symbols_with_data)} / ${formatNumber(overview.symbols_total)} mã có giá`}
        tone={overview.coverage_pct >= 90 ? 'success' : overview.coverage_pct >= 60 ? 'warning' : 'danger'}
      />
      <StatCard
        label="Mã chậm dữ liệu"
        value={formatNumber(overview.symbols_stale)}
        sub={`Chưa cập nhật quá ${overview.stale_after_days} ngày`}
        tone={overview.symbols_stale > 0 ? 'warning' : 'success'}
      />
      <StatCard
        label="Phiên mới nhất"
        value={overview.latest_trade_date ? formatDate(overview.latest_trade_date) : '—'}
        sub={`${formatNumber(overview.bars_total)} nến đã lưu`}
        icon={<Icon name="calendar" size={18} />}
      />
    </div>
  );
}

/**
 * Độ phủ của **từng khung thời gian**.
 *
 * Con số tổng che đúng chỗ cần nhìn: một hệ thống có 500.000 nến ngày đầy đủ vẫn có thể thủng
 * hẳn khung 1 giờ, và cách duy nhất phát hiện là bấm sang biểu đồ 1 giờ rồi thấy nó trống.
 *
 * Cột "cũ nhất" quan trọng hơn vẻ ngoài của nó với khung trong ngày: nhà cung cấp chỉ phục vụ
 * một cửa sổ trượt vài trăm nến gần đây và trả rỗng cho mọi khoảng quá khứ, nên phần lịch sử
 * này **chỉ dày lên nhờ chạy đồng bộ đều đặn** — không có đường nạp bù như nến ngày.
 */
function TimeframeCoverageCard({ overview }: { overview: Overview | undefined }) {
  const rows = overview?.timeframes ?? [];
  if (!rows.length) return null;

  return (
    <Card padded={false}>
      <div className="p-4 pb-2">
        <CardHeader
          title="Độ phủ theo khung thời gian"
          description="Khung ghi “gộp” không chiếm chỗ trong cơ sở dữ liệu — nó được dựng lại từ khung gốc mỗi lần đọc, nên luôn khớp với khung gốc."
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-y border-line bg-ink-50 text-xs">
            <tr>
              <th className="px-4 py-2 text-left font-medium uppercase text-ink-500">Khung</th>
              <th className="px-4 py-2 text-left font-medium uppercase text-ink-500">Nguồn</th>
              <th className="px-4 py-2 text-right font-medium uppercase text-ink-500">Nến</th>
              <th className="px-4 py-2 text-right font-medium uppercase text-ink-500">Mã</th>
              <th className="px-4 py-2 text-left font-medium uppercase text-ink-500">Cũ nhất</th>
              <th className="px-4 py-2 text-left font-medium uppercase text-ink-500">Mới nhất</th>
              <th className="px-4 py-2 text-left font-medium uppercase text-ink-500">Giữ lại</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.code} className="border-b border-line last:border-0">
                <td className="px-4 py-2">
                  <span className="font-medium tabular-nums text-ink-900">{row.short_label}</span>
                  <span className="ml-2 text-xs text-ink-500">{row.label}</span>
                </td>
                <td className="px-4 py-2">
                  {row.derived ? (
                    <Badge tone="gray">gộp từ {row.derive_from}</Badge>
                  ) : row.sync_enabled ? (
                    <Badge tone="green">đang đồng bộ</Badge>
                  ) : (
                    <Badge tone="amber">chưa bật</Badge>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{formatNumber(row.bars)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatNumber(row.symbols)}</td>
                <td className="px-4 py-2 text-xs text-ink-600">
                  {row.oldest ? formatDateTime(row.oldest) : '—'}
                </td>
                <td className="px-4 py-2 text-xs text-ink-600">
                  {row.latest ? formatDateTime(row.latest) : '—'}
                </td>
                <td className="px-4 py-2 text-xs text-ink-500">
                  {row.derived ? '—' : row.retention_days ? `${row.retention_days} ngày` : 'vĩnh viễn'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SyncPanel({
  overview,
  canRun,
  onDone,
}: {
  overview: Overview | undefined;
  canRun: boolean;
  onDone: () => void;
}) {
  const toast = useToast();

  const syncSymbols = useApiMutation<Message, void>(() =>
    api.post<Message>(`${ADMIN}/market/sync-symbols`),
  );
  const syncOhlcv = useApiMutation<Message, void>(() =>
    api.post<Message>(`${ADMIN}/market/sync-ohlcv`),
  );
  const runFullJob = useApiMutation<Message, void>(() =>
    api.post<Message>(`${ADMIN}/sync/run/sync_market`),
  );

  const last = overview?.last_sync;

  return (
    <Card>
      <CardHeader
        title="Đồng bộ dữ liệu"
        description="Chạy tay khi cần bù dữ liệu. Việc hằng ngày đã có job theo lịch lúc 15:45 phiên giao dịch."
        action={
          canRun ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                loading={syncSymbols.loading}
                leftIcon={<Icon name="refresh" size={15} />}
                onClick={async () => {
                  const result = await syncSymbols.mutate();
                  if (result) {
                    toast.success(result.message);
                    onDone();
                  } else {
                    toast.error(syncSymbols.error?.message ?? 'Không chạy được');
                  }
                }}
              >
                Cập nhật danh mục mã
              </Button>
              <Button
                size="sm"
                variant="outline"
                loading={syncOhlcv.loading}
                leftIcon={<Icon name="download" size={15} />}
                onClick={async () => {
                  const result = await syncOhlcv.mutate();
                  if (result) {
                    toast.success(result.message);
                    onDone();
                  } else {
                    toast.error(syncOhlcv.error?.message ?? 'Không chạy được');
                  }
                }}
              >
                Bù giá cho mã đang thiếu
              </Button>
              <Button
                size="sm"
                loading={runFullJob.loading}
                onClick={async () => {
                  const result = await runFullJob.mutate();
                  if (result) {
                    toast.success(result.message);
                    onDone();
                  } else {
                    toast.error(runFullJob.error?.message ?? 'Không chạy được');
                  }
                }}
              >
                Chạy lại cả mẻ
              </Button>
            </div>
          ) : undefined
        }
      />

      {!canRun && (
        <p className="text-sm text-ink-500">
          Bạn không có quyền chạy job đồng bộ nên màn này ở chế độ chỉ xem.
        </p>
      )}

      {last ? (
        <div className="rounded-lg border border-ink-200 bg-ink-50/60 p-3">
          <p className="text-xs font-medium text-ink-500">
            Mẻ gần nhất · {formatDateTime(last.created_at)}
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-ink-500">Mã xử lý</dt>
              <dd className="font-medium tabular-nums">{formatNumber(last.symbols_total)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">Thành công</dt>
              <dd className="font-medium tabular-nums text-green-600">
                {formatNumber(last.symbols_synced)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">Thất bại</dt>
              <dd
                className={`font-medium tabular-nums ${last.symbols_failed ? 'text-red-600' : ''}`}
              >
                {formatNumber(last.symbols_failed)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">Nến ghi thêm</dt>
              <dd className="font-medium tabular-nums">{formatNumber(last.rows_written)}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-ink-200 px-3 py-6 text-center text-sm text-ink-500">
          Chưa có mẻ đồng bộ nào được ghi nhận.
        </p>
      )}
    </Card>
  );
}

/**
 * Đồng bộ giá cho **toàn bộ** danh mục, một nút bấm, có thanh tiến độ.
 *
 * Thẻ "Đồng bộ dữ liệu" bên dưới chỉ bù tối đa 50 mã một lần — hợp khi vá vài mã lẻ, nhưng
 * không trả lời được câu hỏi thường gặp nhất sau một đợt máy chủ nghỉ: *kéo lại giá cho tất cả
 * mã, ngay bây giờ*. Mẻ đó chạy hàng chục phút, nên tiến độ không phải phần trang trí: nếu chỉ
 * có một vòng quay thì "đang tải mã thứ 800" và "đã treo từ mười phút trước" trông giống hệt nhau.
 *
 * Tiến độ được hỏi lại mỗi 2 giây **trong lúc chạy** và ngừng hẳn khi xong — trạng thái nằm
 * trong bộ nhớ máy chủ nên mỗi lượt hỏi không chạm tới cơ sở dữ liệu. Vì nguồn sự thật là máy
 * chủ chứ không phải tab đang mở, đóng trang rồi mở lại vẫn thấy đúng mẻ đang chạy, và hai người
 * trực cùng nhìn thấy một con số.
 */
function FullSyncCard({
  canRun,
  timeframes,
  onDone,
}: {
  canRun: boolean;
  timeframes: TimeframeCoverage[];
  onDone: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState('incremental');
  const [confirmFull, setConfirmFull] = useState(false);

  /* Chỉ khung **tự tải về** mới chọn được. Khung gộp (4h, 1W, 1M) không có gì để tải — bày nó
     ra đây thì người vận hành tích vào rồi ngồi chờ một phần việc không tồn tại. */
  const selectable = timeframes.filter((tf) => !tf.derived);

  /* Mặc định tích **hết khung đang bật**, đúng như tên nút và đúng như job hằng ngày chạy.
     Để mặc định là mỗi nến ngày thì người vận hành bấm "Đồng bộ tất cả", thấy báo hoàn tất,
     rồi mở biểu đồ 1 giờ ra vẫn trống — mà không có gì trên màn hình nói vì sao. */
  const [picked, setPicked] = useState<string[] | null>(null);
  const enabled = selectable.filter((tf) => tf.sync_enabled).map((tf) => tf.code);
  const chosen = picked ?? enabled;

  const toggleTimeframe = (code: string) =>
    setPicked((current) => {
      const list = current ?? enabled;
      return list.includes(code) ? list.filter((c) => c !== code) : [...list, code];
    });

  const { data: progress, refresh } = useApiQuery<FullSyncProgress>(
    `${ADMIN}/market/sync-progress`,
    undefined,
    { refreshInterval: (latest) => (latest?.state === 'running' ? 2000 : 0) },
  );

  const start = useApiMutation<FullSyncProgress, string>((runMode) =>
    api.post<FullSyncProgress>(`${ADMIN}/market/sync-all`, {
      mode: runMode,
      days: 30,
      timeframes: chosen,
    }),
  );
  const stop = useApiMutation<FullSyncProgress, void>(() =>
    api.post<FullSyncProgress>(`${ADMIN}/market/sync-all/stop`),
  );

  const state = progress?.state ?? 'idle';
  const running = state === 'running';
  const meta = SYNC_STATE[state];

  // Mẻ vừa kết thúc thì làm mới số liệu độ phủ phía trên: người vận hành bấm nút chính là để
  // nhìn hai con số đó đổi, bắt họ tải lại trang mới thấy là bỏ dở việc giữa chừng.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) onDone();
    wasRunning.current = running;
  }, [running, onDone]);

  const launch = async (runMode: string) => {
    if (!chosen.length) {
      toast.error('Chọn ít nhất một khung thời gian để đồng bộ.');
      return;
    }
    const result = await start.mutate(runMode);
    if (result) {
      toast.success('Đã bắt đầu đồng bộ. Tiến độ hiện ngay bên dưới.');
      void refresh(result, { revalidate: false });
    } else {
      toast.error(start.error?.message ?? 'Không chạy được');
      // 409 = đã có mẻ khác chạy (tab khác, người khác) — kéo về trạng thái thật để nút khớp.
      void refresh();
    }
  };

  return (
    <Card>
      <CardHeader
        title="Đồng bộ giá tất cả mã"
        description="Tải dữ liệu OHLCV cho toàn bộ mã đang theo dõi. Chạy nền, xem tiến độ ngay bên dưới."
        action={
          canRun ? (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                disabled={running}
                className="w-60"
                options={[
                  { value: 'incremental', label: 'Bù phần thiếu (30 phiên gần nhất)' },
                  { value: 'full', label: 'Tải lại toàn bộ lịch sử' },
                ]}
              />
              {running ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11"
                  loading={stop.loading}
                  disabled={progress?.stop_requested}
                  leftIcon={<Icon name="close" size={15} />}
                  onClick={async () => {
                    const result = await stop.mutate();
                    if (result) {
                      toast.success('Đã yêu cầu dừng. Mã đang tải sẽ chạy nốt rồi mẻ kết thúc.');
                      void refresh(result, { revalidate: false });
                    } else {
                      toast.error(stop.error?.message ?? 'Không dừng được');
                      void refresh();
                    }
                  }}
                >
                  {progress?.stop_requested ? 'Đang dừng…' : 'Dừng'}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className='h-11'
                  loading={start.loading}
                  leftIcon={<Icon name="refresh" size={15} />}
                  onClick={() => {
                    if (mode === 'full') {
                      setConfirmFull(true);
                      return;
                    }
                    void launch('incremental');
                  }}
                >
                  Đồng bộ tất cả
                </Button>
              )}
            </div>
          ) : undefined
        }
      />

      {!canRun && (
        <p className="text-sm text-ink-500">
          Bạn không có quyền chạy job đồng bộ nên chỉ xem được tiến độ.
        </p>
      )}

      {canRun && selectable.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-ink-200 bg-ink-50/60 p-3 mb-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs font-medium uppercase text-ink-500">Khung thời gian</span>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {selectable.map((tf) => (
                <Checkbox
                  key={tf.code}
                  label={tf.short_label}
                  checked={chosen.includes(tf.code)}
                  disabled={running}
                  onChange={() => toggleTimeframe(tf.code)}
                />
              ))}
            </div>
          </div>
          <p className="text-xs text-ink-500">
            Mẻ chạy {formatNumber(chosen.length)} lượt cho mỗi mã, nên bỏ bớt một khung là
            giảm đi chừng ấy thời gian. Khung gộp (4h · 1W · 1M) không có ở đây vì chúng được
            dựng lại từ khung gốc mỗi lần đọc, không tốn lượt tải nào.
          </p>
        </div>
      )}

      <ScheduleNote schedule={progress?.schedule} />

      <FullSyncProgressView progress={progress} meta={meta} />

      <ConfirmDialog
        open={confirmFull}
        onClose={() => setConfirmFull(false)}
        title="Tải lại toàn bộ lịch sử giá?"
        message={
          <>
            Mẻ này kéo lại <strong>trọn lịch sử</strong> của từng mã trong danh mục, không chỉ
            phần thiếu. Với hơn một nghìn mã thì thời gian tính bằng giờ và nhà cung cấp có thể
            chặn tạm nếu bị gọi quá dày. Chỉ dùng khi nghi ngờ dữ liệu cũ bị hỏng hoặc thủng
            khoảng — việc thường ngày hãy chọn <strong>Bù phần thiếu</strong>. Dừng giữa chừng
            được, và phần đã tải vẫn giữ nguyên.
            <br />
            <br />
            Lưu ý: “tải lại toàn bộ” chỉ có tác dụng với <strong>nến ngày</strong>. Khung trong
            ngày luôn chỉ lấy được cửa sổ vài trăm nến gần đây mà nhà cung cấp phục vụ — mọi
            khoảng quá khứ đều trả về rỗng, nên phần lịch sử trong ngày đã mất thì không nạp lại
            được bằng nút này.
          </>
        }
        confirmLabel="Tải lại toàn bộ"
        loading={start.loading}
        onConfirm={async () => {
          await launch('full');
          setConfirmFull(false);
        }}
      />
    </Card>
  );
}

/**
 * Dòng nói về lịch tự chạy.
 *
 * Đặt ngay trên thanh tiến độ vì người mở màn này để xem "đã đồng bộ tới đâu" thì câu hỏi kế
 * tiếp luôn là "bao giờ chạy lại" — bắt họ mở sang màn Cấu hình để biết là chia một câu hỏi
 * thành hai màn hình.
 */
function ScheduleNote({ schedule }: { schedule?: FullSyncProgress['schedule'] }) {
  if (!schedule) return null;

  if (!schedule.scheduler_running) {
    return (
      <p className="rounded-lg border border-dashed border-amber-300 bg-amber-50/50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/20">
        Scheduler đang tắt (<code>ENABLE_SCHEDULER=false</code>), nên không có mẻ nào tự chạy.
        Nút đồng bộ ở trên vẫn dùng được bình thường.
      </p>
    );
  }

  if (!schedule.enabled) {
    return (
      <p className="rounded-lg border border-dashed border-ink-200 px-3 py-2 text-xs text-ink-500">
        Chưa bật tự đồng bộ toàn bộ nến — chỉ chạy khi bấm nút. Đặt chu kỳ ở màn{' '}
        <strong className="text-ink-700">Cấu hình hệ thống → Dữ liệu thị trường</strong>.
      </p>
    );
  }

  return (
    <p className="rounded-lg border border-line bg-ink-50 px-3 py-2 text-xs text-ink-600">
      Tự đồng bộ toàn bộ nến mỗi{' '}
      <strong className="text-ink-900">{schedule.interval_hours} giờ</strong>
      {schedule.next_run && (
        <>
          {' '}· mẻ kế tiếp{' '}
          <strong className="text-ink-900">{formatDateTime(schedule.next_run)}</strong>
        </>
      )}
      . Đổi chu kỳ ở màn Cấu hình hệ thống.
    </p>
  );
}

/**
 * Thẻ theo dõi nguồn giá thời gian thực.
 *
 * Lý do màn này tồn tại: một nguồn im lặng ngừng trả dữ liệu và một nguồn đang chạy bình thường
 * trông **y hệt nhau** trên bảng giá — số cũ vẫn nằm đó, chỉ là không đổi nữa. Không có chỗ nào
 * khác trong hệ thống lộ ra được kiểu hỏng đó.
 */
function RealtimePanel() {
  const toast = useToast();
  const { can } = useStaffSession();

  const { data, refresh } = useApiQuery<RealtimeStatus>(
    `${ADMIN}/market/realtime`,
    undefined,
    { refreshInterval: 5000 },
  );

  const poll = useApiMutation<{ status: RealtimeStatus }, void>(() =>
    api.post<{ status: RealtimeStatus }>(`${ADMIN}/market/realtime/poll`),
  );

  if (!data) return null;

  const healthy = data.enabled && !data.stale;
  const tone: 'gray' | 'amber' | 'green' = !data.enabled
    ? 'gray'
    : data.stale
      ? 'amber'
      : 'green';
  const label = !data.enabled
    ? 'Đang tắt'
    : data.stale
      ? data.in_session_window
        ? 'Dữ liệu chậm'
        : 'Ngoài giờ giao dịch'
      : 'Đang chạy';

  const stats: Array<[string, string]> = [
    ['Nguồn', data.provider],
    ['Nhịp lấy giá', `${data.interval_seconds}s`],
    ['Mã trong kho', formatNumber(data.quotes)],
    ['Mã theo dõi', formatNumber(data.symbols_tracked)],
    ['Độ trễ nhịp cuối', data.last_duration_ms !== null ? `${formatNumber(data.last_duration_ms)} ms` : '—'],
    ['Nhịp thành công', formatNumber(data.polls_ok)],
    ['Nhịp lỗi', formatNumber(data.polls_failed)],
    ['Lỗi liên tiếp', formatNumber(data.consecutive_errors)],
    ['Bảng giá đang mở', `${formatNumber(data.subscribers)} kết nối`],
    ['Mã đang được xem', formatNumber(data.subscribed_symbols)],
    ['Cửa sổ phiên', `${data.window.start}–${data.window.end}`],
    [
      'Bù nến trong phiên',
      data.intraday_sync_minutes > 0 ? `mỗi ${data.intraday_sync_minutes} phút` : 'tắt',
    ],
  ];

  return (
    <Card>
      <CardHeader
        title="Giá thời gian thực"
        description={`${data.session_label} · ảnh chụp gần nhất ${
          data.as_of ? formatDateTime(data.as_of) : 'chưa có'
        }`}
        action={
          can('sync.run') ? (
            <Button
              size="sm"
              variant="secondary"
              loading={poll.loading}
              onClick={async () => {
                const result = await poll.mutate();
                if (result) {
                  toast.success('Đã lấy giá một nhịp');
                  refresh();
                }
              }}
            >
              Lấy giá ngay
            </Button>
          ) : null
        }
      />

      <div className="mb-3 flex items-center gap-2">
        <Badge tone={tone}>{label}</Badge>
        {healthy && (
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
        )}
      </div>

      {data.last_error && (
        <Alert tone="warning" className="mb-3">
          Nhịp gần nhất lỗi: <code className="text-xs">{data.last_error}</code>
        </Alert>
      )}

      {!data.enabled && (
        <Alert tone="info" className="mb-3">
          Đặt <code>MARKET_REALTIME_ENABLED=true</code> trong <code>backend/.env</code> rồi khởi
          động lại backend để bật. Tắt thì bảng giá quay về đúng hành vi cũ — giá cuối phiên đọc
          từ cơ sở dữ liệu.
        </Alert>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {stats.map(([key, value]) => (
          <div key={key}>
            <dt className="text-xs text-ink-500">{key}</dt>
            <dd className="mt-0.5 text-sm font-medium tabular-nums text-ink-900">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-3 text-xs text-ink-500">
        Kho giá sống trong bộ nhớ và <strong>không bao giờ ghi xuống cơ sở dữ liệu</strong>. Nến
        chốt vẫn chỉ đến từ job 16:00 — xem BR-832.
      </p>
    </Card>
  );
}

/** Phần hiển thị tiến độ — tách khỏi thẻ để phần điều khiển ở trên đọc được trong một màn hình. */
function FullSyncProgressView({
  progress,
  meta,
}: {
  progress: FullSyncProgress | undefined;
  meta: (typeof SYNC_STATE)[keyof typeof SYNC_STATE];
}) {
  if (!progress || progress.state === 'idle') {
    return (
      <p className="rounded-lg border border-dashed border-ink-200 px-3 py-6 text-center text-sm text-ink-500">
        Chưa có mẻ đồng bộ toàn danh mục nào trong lần chạy này của máy chủ.
      </p>
    );
  }

  const running = progress.state === 'running';
  const percent = Math.min(100, Math.max(0, progress.percent));

  return (
    <div className="space-y-3 rounded-lg border border-ink-200 bg-ink-50/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          {/* Tên mã đang tải là bằng chứng duy nhất cho thấy mẻ còn sống chứ không phải đã treo. */}
          {running && progress.current_symbol && (
            <span className="text-sm text-ink-600">
              Đang tải <strong className="text-ink-900">{progress.current_symbol}</strong>
              {progress.current_timeframe && (
                <>
                  {' '}
                  khung <strong className="text-ink-900">{progress.current_timeframe}</strong>
                </>
              )}
              …
            </span>
          )}
          {progress.triggered_by && (
            <span className="text-xs text-ink-500">· do {progress.triggered_by} chạy</span>
          )}
        </div>
        {/* Đơn vị là **lượt (mã × khung)**, không phải mã: chạy 150 mã trên 5 khung là 750
            lượt, và ghi "150" ở đây thì thanh tiến độ đứng im suốt bốn phần năm thời gian. */}
        <p className="text-sm font-medium tabular-nums">
          {formatNumber(progress.processed)} / {formatNumber(progress.total)} lượt · {percent}%
          {progress.timeframes?.length > 1 && (
            <span className="ml-1 font-normal text-ink-500">
              ({progress.timeframes.join(' · ')})
            </span>
          )}
        </p>
      </div>

      <div
        className="h-2 w-full overflow-hidden rounded-full bg-ink-200"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Tiến độ đồng bộ giá toàn danh mục"
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ${meta.bar}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <dt className="text-xs text-ink-500">Thành công</dt>
          <dd className="font-medium tabular-nums text-green-600">
            {formatNumber(progress.synced)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">Lỗi</dt>
          <dd className={`font-medium tabular-nums ${progress.failed ? 'text-red-600' : ''}`}>
            {formatNumber(progress.failed)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">Bỏ qua</dt>
          <dd
            className="font-medium tabular-nums"
            title="Đã có dữ liệu tới phiên gần nhất, hoặc nguồn không có nến nào cho khung đó"
          >
            {formatNumber(progress.skipped)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">Nến ghi thêm</dt>
          <dd className="font-medium tabular-nums">{formatNumber(progress.rows_written)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">Đã chạy</dt>
          <dd className="font-medium">{formatDuration(progress.elapsed_seconds)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">Ước còn lại</dt>
          <dd className="font-medium">{running ? formatDuration(progress.eta_seconds) : '—'}</dd>
        </div>
      </dl>

      {progress.message && (
        <Alert tone={progress.state === 'failed' ? 'danger' : running ? 'info' : 'success'}>
          {progress.message}
        </Alert>
      )}

      {progress.errors.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-500">
            {progress.errors.length} lỗi gần nhất
          </summary>
          <ul className="mt-2 divide-y divide-ink-100">
            {progress.errors.map((item, index) => (
              <li key={`${item.symbol}-${index}`} className="flex gap-3 py-1.5">
                <span className="w-16 shrink-0 font-medium text-ink-900">{item.symbol}</span>
                <span className="text-ink-600">{item.issue}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-500">
            Danh sách đầy đủ nằm ở tab <strong>Nhật ký đồng bộ</strong>.
          </p>
        </details>
      )}
    </div>
  );
}

function SymbolTable({ canRun, canManage }: { canRun: boolean; canManage: boolean }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [exchange, setExchange] = useState('');
  const [dataState, setDataState] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MarketSymbol | null>(null);
  const [deleting, setDeleting] = useState<MarketSymbol | null>(null);
  const { page, size, setPage, setSize, reset } = usePagination(20);

  const { data, isLoading, refresh } = useApiQuery<Page<MarketSymbol>>(`${ADMIN}/market/symbols`, {
    page,
    size,
    q: search || undefined,
    exchange: exchange || undefined,
    data_state: dataState || undefined,
  });

  const syncOne = useApiMutation<Message, string>((symbol) =>
    api.post<Message>(`${ADMIN}/market/sync-ohlcv`, undefined, { symbols: [symbol] }),
  );

  const columns: Column<MarketSymbol>[] = [
    {
      key: 'symbol',
      header: 'Mã',
      width: '13rem',
      sticky: 'left',
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-ink-900">{row.symbol}</p>
          <p className="truncate text-xs text-ink-500">{row.company_name ?? '—'}</p>
        </div>
      ),
    },
    {
      key: 'exchange',
      header: 'Sàn',
      render: (row) => <Badge tone="gray">{row.exchange}</Badge>,
    },
    {
      key: 'industry',
      header: 'Ngành',
      render: (row) => row.industry ?? '—',
      hideOnMobile: true,
    },
    {
      key: 'tier',
      header: 'Tier',
      render: (row) =>
        row.tier ? (
          <Badge tone={TIER_TONE[row.tier]} title={TIER_HINT[row.tier]}>
            {row.tier}
          </Badge>
        ) : (
          '—'
        ),
      hideOnMobile: true,
    },
    {
      key: 'state',
      header: 'Tình trạng dữ liệu',
      render: (row) => (
        <Badge tone={DATA_STATE[row.data_state].tone}>{DATA_STATE[row.data_state].label}</Badge>
      ),
    },
    {
      key: 'last_date',
      header: 'Phiên cuối',
      render: (row) => (row.last_ohlcv_date ? formatDate(row.last_ohlcv_date) : '—'),
    },
    {
      key: 'bars',
      header: 'Số nến',
      align: 'right',
      render: (row) => <span className="tabular-nums">{formatNumber(row.bars)}</span>,
      hideOnMobile: true,
    },
    {
      key: 'synced',
      header: 'Đồng bộ lúc',
      render: (row) => (row.last_synced_at ? formatDateTime(row.last_synced_at) : '—'),
      hideOnMobile: true,
    },
    {
      key: 'actions',
      header: 'Hành động',
      width: canManage ? '11rem' : '7rem',
      align: 'right',
      sticky: 'right',
      render: (row) => (
        <div className="flex justify-center gap-0.5">
          <RowAction
            label={canRun ? `Tải lại giá cho ${row.symbol}` : 'Bạn không có quyền chạy đồng bộ'}
            icon={<Icon name="download" size={16} />}
            disabled={!canRun || syncOne.loading}
            onClick={async () => {
              const result = await syncOne.mutate(row.symbol);
              if (result) {
                toast.success(result.message);
                refresh();
              } else {
                toast.error(syncOne.error?.message ?? 'Không chạy được');
              }
            }}
          />
          {canManage && (
            <>
              <RowAction
                label={`Sửa ngành, tier, trạng thái của ${row.symbol}`}
                icon={<Icon name="edit" size={16} />}
                onClick={() => setEditing(row)}
              />
              <RowAction
                label={`Xoá ${row.symbol} khỏi danh mục`}
                icon={<Icon name="trash" size={16} />}
                danger
                onClick={() => setDeleting(row)}
              />
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-3">
      <div
        className={`shrink-0 grid gap-3 sm:items-end ${
          canManage
            ? 'sm:grid-cols-[minmax(0,1fr)_12rem_14rem_auto]'
            : 'sm:grid-cols-[minmax(0,1fr)_12rem_14rem]'
        }`}
      >
        <SearchInput
          placeholder="Mã hoặc tên công ty…"
          value={search}
          onSearch={(value) => {
            setSearch(value);
            reset();
          }}
        />
        <Select
          value={exchange}
          onChange={(e) => {
            setExchange(e.target.value);
            reset();
          }}
          placeholder="Tất cả sàn"
          options={['HOSE', 'HNX', 'UPCOM'].map((v) => ({ value: v, label: v }))}
        />
        <Select
          value={dataState}
          onChange={(e) => {
            setDataState(e.target.value);
            reset();
          }}
          placeholder="Tất cả tình trạng"
          options={Object.entries(DATA_STATE).map(([value, meta]) => ({
            value,
            label: meta.label,
          }))}
        />
        {canManage && (
          <Button leftIcon={<Icon name="plus" size={16} />} onClick={() => setAdding(true)}>
            Thêm mã
          </Button>
        )}
      </div>

      <Table
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id}
        loading={isLoading}
        emptyMessage="Không tìm thấy mã nào khớp bộ lọc"
        fill
        minWidth="66rem"
        pagination={data ? { page: data.page, size: data.size, total: data.total } : undefined}
        onPageChange={setPage}
        onPageSizeChange={(next) => {
          setSize(next);
          reset();
        }}
        mobileCard={(row) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium text-ink-900">{row.symbol}</p>
                <p className="truncate text-xs text-ink-500">{row.company_name ?? '—'}</p>
              </div>
              <Badge tone={DATA_STATE[row.data_state].tone}>
                {DATA_STATE[row.data_state].label}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
              <span>{row.exchange}</span>
              <span>
                Phiên cuối {row.last_ohlcv_date ? formatDate(row.last_ohlcv_date) : '—'}
              </span>
              <span>{formatNumber(row.bars)} nến</span>
            </div>
          </div>
        )}
      />

      {adding && (
        <AddSymbolModal
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
      {editing && (
        <EditSymbolModal
          row={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {deleting && (
        <DeleteSymbolModal
          row={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Thêm mã vào danh mục theo dõi.
 *
 * Chỉ hỏi mã, ngành và tier. Sàn và tên doanh nghiệp do máy chủ tra từ nhà cung cấp — bắt người
 * nhập tự nhớ mã nào thuộc sàn nào là mời gọi sai sót, mà sai sàn thì không lộ ra ngay.
 */
function AddSymbolModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [symbol, setSymbol] = useState('');
  const [industry, setIndustry] = useState('');
  const [tier, setTier] = useState('');

  const create = useApiMutation<{ symbol: string; message: string }, void>(() =>
    api.post(`${ADMIN}/market/symbols`, {
      symbol: symbol.trim().toUpperCase(),
      industry: industry.trim() || null,
      tier: tier || null,
    }),
  );

  const submit = async () => {
    if (!symbol.trim()) {
      toast.error('Nhập mã chứng khoán');
      return;
    }
    const result = await create.mutate();
    if (result) {
      toast.success(result.message);
      onDone();
    } else {
      toast.error(create.error?.message ?? 'Không thêm được mã');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Thêm mã vào danh mục theo dõi"
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Huỷ
          </Button>
          <Button loading={create.loading} onClick={() => void submit()}>
            Thêm và tải dữ liệu
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Mã chứng khoán"
          required
          value={symbol}
          maxLength={20}
          placeholder="VD: DGC"
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          hint="Máy chủ tự tra sàn và tên doanh nghiệp. Mã không có thật sẽ bị từ chối."
        />
        <Input
          label="Ngành"
          value={industry}
          maxLength={150}
          placeholder="VD: Hoá chất"
          onChange={(e) => setIndustry(e.target.value)}
        />
        <Select
          label="Tier"
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          placeholder="Chưa xếp"
          options={(['A', 'B', 'C'] as const).map((v) => ({ value: v, label: `${v} — ${TIER_HINT[v]}` }))}
        />
        <Alert tone="info">
          Sau khi thêm, hệ thống tải toàn bộ giá lịch sử của mã này ở chạy nền. Mã lâu đời có thể
          hơn 6.000 phiên nên mất một lúc — cột <strong>Tình trạng dữ liệu</strong> sẽ chuyển sang
          “Đủ dữ liệu” khi xong.
        </Alert>
      </div>
    </Modal>
  );
}

function EditSymbolModal({
  row,
  onClose,
  onDone,
}: {
  row: MarketSymbol;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [industry, setIndustry] = useState(row.industry ?? '');
  const [tier, setTier] = useState(row.tier ?? '');
  const [isActive, setIsActive] = useState(row.is_active);

  const update = useApiMutation<{ message: string }, void>(() =>
    api.patch(`${ADMIN}/market/symbols/${row.symbol}`, {
      industry: industry.trim() || null,
      tier: tier || null,
      is_active: isActive,
    }),
  );

  const submit = async () => {
    const result = await update.mutate();
    if (result) {
      toast.success(result.message);
      onDone();
    } else {
      toast.error(update.error?.message ?? 'Không lưu được');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Sửa ${row.symbol}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Huỷ
          </Button>
          <Button loading={update.loading} onClick={() => void submit()}>
            Lưu
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-ink-50 px-3 py-2 text-sm">
          <p className="font-medium text-ink-900">
            {row.symbol} · {row.exchange}
          </p>
          <p className="text-xs text-ink-500">{row.company_name ?? '—'}</p>
        </div>

        <Input
          label="Ngành"
          value={industry}
          maxLength={150}
          onChange={(e) => setIndustry(e.target.value)}
        />
        <Select
          label="Tier"
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          placeholder="Chưa xếp"
          options={(['A', 'B', 'C'] as const).map((v) => ({ value: v, label: `${v} — ${TIER_HINT[v]}` }))}
        />
        <Checkbox
          label="Đang theo dõi"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          hint="Bỏ chọn thì mã vẫn giữ nguyên giá lịch sử nhưng không còn được đồng bộ hằng ngày."
        />

        <p className="text-xs text-ink-500">
          Không sửa được mã và sàn. Đổi mã tức là đổi sang doanh nghiệp khác, giá lịch sử đang gắn
          với mã cũ sẽ thành vô nghĩa — trường hợp đó hãy xoá rồi thêm lại.
        </p>
      </div>
    </Modal>
  );
}

/** Xoá mã — bắt buộc nhập lý do vì thao tác này kéo theo toàn bộ giá lịch sử của mã. */
function DeleteSymbolModal({
  row,
  onClose,
  onDone,
}: {
  row: MarketSymbol;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');

  const remove = useApiMutation<Message, void>(() =>
    api.del<Message>(`${ADMIN}/market/symbols/${row.symbol}`, { reason: reason.trim() }),
  );

  const submit = async () => {
    if (reason.trim().length < 3) {
      toast.error('Nhập lý do xoá — nội dung này được ghi vào audit log');
      return;
    }
    const result = await remove.mutate();
    if (result) {
      toast.success(result.message);
      onDone();
    } else {
      toast.error(remove.error?.message ?? 'Không xoá được');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Xoá ${row.symbol} khỏi danh mục?`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="danger" loading={remove.loading} onClick={() => void submit()}>
            Xoá mã
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Alert tone="warning">
          Xoá {row.symbol} sẽ xoá luôn <strong>{formatNumber(row.bars)} nến giá</strong> và gỡ mã
          này khỏi mọi chiến lược đang dùng nó. Không hoàn tác được.
        </Alert>

        <p className="text-sm text-ink-600">
          Nếu {row.symbol} đã từng phát tín hiệu tới khách hàng, hệ thống sẽ <strong>giữ lại</strong>{' '}
          để tra cứu khiếu nại và chỉ dừng theo dõi.
        </p>

        <Textarea
          label="Lý do"
          required
          rows={3}
          value={reason}
          maxLength={500}
          placeholder="VD: mã đã huỷ niêm yết, thanh khoản không còn đủ để vào lệnh…"
          onChange={(e) => setReason(e.target.value)}
          hint="Ghi vào audit log."
        />
      </div>
    </Modal>
  );
}

function SyncLogList() {
  const [detail, setDetail] = useState<SyncLog | null>(null);
  const { page, size, setPage, setSize } = usePagination(20);

  const { data, isLoading } = useApiQuery<Page<SyncLog>>(`${ADMIN}/market/sync-logs`, {
    page,
    size,
  });

  const columns: Column<SyncLog>[] = [
    { key: 'run_date', header: 'Ngày chạy', render: (row) => formatDate(row.run_date) },
    {
      key: 'total',
      header: 'Mã xử lý',
      align: 'right',
      render: (row) => <span className="tabular-nums">{formatNumber(row.symbols_total)}</span>,
    },
    {
      key: 'synced',
      header: 'Thành công',
      align: 'right',
      render: (row) => (
        <span className="tabular-nums text-green-600">{formatNumber(row.symbols_synced)}</span>
      ),
    },
    {
      key: 'failed',
      header: 'Thất bại',
      align: 'right',
      render: (row) => (
        <span className={`tabular-nums ${row.symbols_failed ? 'text-red-600' : 'text-ink-400'}`}>
          {formatNumber(row.symbols_failed)}
        </span>
      ),
    },
    {
      key: 'rows',
      header: 'Nến ghi thêm',
      align: 'right',
      render: (row) => <span className="tabular-nums">{formatNumber(row.rows_written)}</span>,
      hideOnMobile: true,
    },
    {
      key: 'duration',
      header: 'Thời gian',
      render: (row) => (row.duration_seconds != null ? `${row.duration_seconds}s` : '—'),
      hideOnMobile: true,
    },
    {
      key: 'actions',
      header: 'Hành động',
      width: '7rem',
      align: 'right',
      sticky: 'right',
      render: (row) => (
        <div className="flex justify-center gap-0.5">
          <RowAction
            label={
              row.anomalies?.count
                ? `Xem ${row.anomalies.count} bất thường`
                : 'Mẻ này không có bất thường'
            }
            icon={<Icon name="eye" size={16} />}
            disabled={!row.anomalies?.count}
            onClick={() => setDetail(row)}
          />
        </div>
      ),
    },
  ];

  return (
    <>
      <Table
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id}
        loading={isLoading}
        emptyMessage="Chưa có mẻ đồng bộ nào"
        fill
        minWidth="54rem"
        pagination={data ? { page: data.page, size: data.size, total: data.total } : undefined}
        onPageChange={setPage}
        onPageSizeChange={setSize}
      />

      {detail && (
        <Modal
          open
          onClose={() => setDetail(null)}
          title={`Bất thường ngày ${formatDate(detail.run_date)}`}
          description="BR-835 — ghi lại để phát hiện dữ liệu hỏng sớm, trước khi nó lọt vào thống kê."
          size="lg"
        >
          <ul className="divide-y divide-ink-100">
            {(detail.anomalies?.items ?? []).map((item, index) => (
              <li key={`${item.symbol}-${index}`} className="flex gap-3 py-2 text-sm">
                <span className="w-20 shrink-0 font-medium text-ink-900">{item.symbol}</span>
                <span className="text-ink-600">{item.issue}</span>
              </li>
            ))}
          </ul>
          {(detail.anomalies?.count ?? 0) > (detail.anomalies?.items?.length ?? 0) && (
            <p className="mt-3 text-xs text-ink-500">
              Hiển thị {detail.anomalies?.items?.length} trên tổng {detail.anomalies?.count} bất
              thường. Phần còn lại xem trong log máy chủ.
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
