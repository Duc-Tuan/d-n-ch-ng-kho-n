'use client';

import Link from 'next/link';
import { useState } from 'react';

import { MyStrategyEditor, ShareStrategyModal } from '@/components/domain/MyStrategyForms';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Disclaimer,
  EmptyState,
  Icon,
  Input,
  Pagination,
  Spinner,
  StatusBadge,
  Tabs,
} from '@/components/ui';
import { useApiMutation, useApiQuery, useDebounced, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { formatDate } from '@/lib/datetime';
import { formatPercent, formatR } from '@/lib/format';
import { SCHOOL_LABEL, STRATEGY_KIND } from '@/lib/status';
import type { Message, Page, Strategy, StrategyStats } from '@/types';

/** Chiến lược của tôi mang thêm số người đang được chia sẻ — backend gộp sẵn cho cả trang. */
type OwnStrategy = Strategy & { share_count: number };

type MyStrategiesResponse = {
  own: OwnStrategy[];
  shared: Array<Strategy & { share_id: number; shared_at: string; note: string | null }>;
  limit: number;
  used: number;
};

const TABS = [
  { key: 'system', label: 'Chiến lược hệ thống' },
  { key: 'mine', label: 'Của tôi' },
  { key: 'shared', label: 'Được chia sẻ' },
];

/**
 * BR-843 — thống kê phải trung thực: luôn kèm khoảng thời gian được tính.
 * BR-841 — LIVE và BACKTEST hiển thị tách biệt, có nhãn rõ ràng.
 */
function StatsBlock({ stats, type }: { stats: StrategyStats | null; type: 'LIVE' | 'BACKTEST' }) {
  const isLive = type === 'LIVE';

  if (!stats || stats.total_trades === 0) {
    return (
      <p className="text-xs text-ink-400">
        {isLive ? 'Chưa có tín hiệu thực' : 'Chưa có dữ liệu mô phỏng'}
      </p>
    );
  }

  return (
    <div
      className={
        isLive
          ? 'rounded-lg border border-tone-green-line bg-tone-green-bg/60 p-3'
          : 'rounded-lg border border-dashed border-ink-300 bg-ink-50 p-3'
      }
    >
      <div className="mb-2 flex items-center gap-2">
        <Badge tone={isLive ? 'green' : 'gray'}>{isLive ? 'Tín hiệu thực' : 'Mô phỏng'}</Badge>
        {!isLive && <span className="text-[11px] text-ink-500">Chưa từng phát ra thực tế</span>}
      </div>
      {/* Khối này mở ra theo `total_trades` nhưng mọi con số bên trong đều tính trên lệnh **đã
          đóng**. Chiến lược vừa phát tín hiệu, chưa lệnh nào chạm TP/SL, sẽ hiện “Số lệnh 0” kèm ba
          dấu gạch — đọc y hệt như lỗi, hoặc tệ hơn là như chiến lược thua sạch. BR-843: nói thẳng
          là chưa có gì để tính, thay vì bỏ số không vào ô. */}
      {stats.closed_trades === 0 ? (
        <p className="text-xs text-ink-600">
          {stats.open_trades > 0
            ? `Đang mở ${stats.open_trades} lệnh, chưa lệnh nào đóng nên chưa tính được winrate.`
            : `${stats.total_trades} tín hiệu đều đã huỷ, không còn lệnh nào để tính.`}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-ink-500">Số lệnh đã đóng</dt>
              <dd className="font-medium tabular-nums text-ink-900">{stats.closed_trades}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Winrate</dt>
              <dd className="font-medium tabular-nums text-ink-900">
                {formatPercent(stats.win_rate)}
              </dd>
            </div>
            <div>
              <dt className="text-ink-500">R trung bình</dt>
              <dd className="font-medium tabular-nums text-ink-900">{formatR(stats.avg_r)}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Sụt giảm lớn nhất</dt>
              <dd className="font-medium tabular-nums text-ink-900">
                {stats.max_dd !== null ? `${stats.max_dd.toFixed(2)}R` : '—'}
              </dd>
            </div>
          </dl>
          {stats.open_trades > 0 && (
            <p className="mt-1.5 text-[11px] text-ink-500">
              Còn {stats.open_trades} lệnh đang mở, chưa tính vào các số trên.
            </p>
          )}
        </>
      )}
      <p className="mt-2 text-[11px] text-ink-500">
        Tính trên toàn bộ lịch sử: {formatDate(stats.period_from)} – {formatDate(stats.period_to)}
      </p>
    </div>
  );
}

function StrategyCard({
  strategy,
  href,
  actions,
  badge,
}: {
  strategy: Strategy;
  href: string;
  actions?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-ink-900">{strategy.name}</h3>
              <Badge tone="blue">{SCHOOL_LABEL[strategy.school] ?? strategy.school}</Badge>
              <StatusBadge map={STRATEGY_KIND} code={strategy.kind} />
              {badge}
              {strategy.locked && <Badge tone="amber">Gói cao hơn</Badge>}
            </div>
            {strategy.description && (
              <p className="mt-1.5 text-sm text-ink-600">{strategy.description}</p>
            )}
            {strategy.symbols.length > 0 && (
              <p className="mt-2 flex flex-wrap gap-1">
                {strategy.symbols.slice(0, 12).map((symbol) => (
                  <span
                    key={symbol}
                    className="rounded bg-ink-100 px-1.5 py-0.5 text-xs font-medium text-ink-600"
                  >
                    {symbol}
                  </span>
                ))}
                {strategy.symbols.length > 12 && (
                  <span className="px-1 text-xs text-ink-400">
                    +{strategy.symbols.length - 12}
                  </span>
                )}
              </p>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            {actions}
            <Link href={strategy.locked ? '/pricing' : href}>
              <Button size="sm" variant={strategy.locked ? 'outline' : 'primary'}>
                {strategy.locked ? 'Nâng cấp gói' : 'Xem biểu đồ'}
              </Button>
            </Link>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <StatsBlock stats={strategy.stats_live} type="LIVE" />
          <StatsBlock stats={strategy.stats_backtest} type="BACKTEST" />
        </div>
      </div>
    </Card>
  );
}

const PAGE_SIZE = 10;

/** Lọc theo tên, mã và mã chứng khoán trong phạm vi — ba thứ người dùng thật sự gõ để tìm. */
function matches(strategy: Strategy, keyword: string): boolean {
  if (!keyword) return true;
  const needle = keyword.trim().toLowerCase();
  return (
    strategy.name.toLowerCase().includes(needle) ||
    (strategy.description ?? '').toLowerCase().includes(needle) ||
    strategy.symbols.some((s) => s.toLowerCase().includes(needle))
  );
}

export default function StrategiesPage() {
  const toast = useToast();
  const [tab, setTab] = useState('system');
  const [editing, setEditing] = useState<{ id: number | null } | null>(null);
  const [sharing, setSharing] = useState<Strategy | null>(null);
  const [deleting, setDeleting] = useState<Strategy | null>(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [page, setPage] = useState(1);

  /**
   * Tab "hệ thống" phân trang ở **máy chủ**: mỗi chiến lược trong danh sách phải chạy hai truy vấn
   * thống kê, nên kéo cả danh sách về rồi chỉ hiện mười cái là tính thừa gần hết.
   *
   * Hai tab còn lại lấy từ `/my-strategies` — một lần gọi trả cả `own` và `shared`, số lượng bị
   * chặn cứng bởi hạn mức chiến lược cá nhân, nên cắt trang ngay ở trình duyệt là đủ.
   */
  const { data: system, isLoading } = useApiQuery<Page<Strategy>>(`${CUSTOMER}/strategies`, {
    page: tab === 'system' ? page : 1,
    size: PAGE_SIZE,
    q: debouncedSearch || undefined,
  });
  const { data: mine, refresh } = useApiQuery<MyStrategiesResponse>(`${CUSTOMER}/my-strategies`);

  const personalList: Strategy[] =
    tab === 'mine' ? (mine?.own ?? []) : tab === 'shared' ? (mine?.shared ?? []) : [];
  const personalFiltered = personalList.filter((s) => matches(s, search));

  const isSystemTab = tab === 'system';
  const totalItems = isSystemTab ? (system?.total ?? 0) : personalFiltered.length;
  const totalPages = isSystemTab
    ? Math.max(system?.pages ?? 1, 1)
    : Math.max(Math.ceil(personalFiltered.length / PAGE_SIZE), 1);
  const currentPage = Math.min(page, totalPages);
  const visible = isSystemTab
    ? (system?.items ?? [])
    : personalFiltered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const changeTab = (key: string) => {
    setTab(key);
    setPage(1);
  };

  const remove = useApiMutation<Message, number>((id) =>
    api.del<Message>(`${CUSTOMER}/my-strategies/${id}`),
  );

  const tabsWithCount = TABS.map((t) => ({
    ...t,
    badge:
      t.key === 'mine' ? mine?.own.length : t.key === 'shared' ? mine?.shared.length : undefined,
  }));

  return (
    <div className="flex h-full flex-col space-y-3">
      {/*
        Cùng bố cục với site quản trị: thanh công cụ và phân trang đứng yên, chỉ danh sách cuộn.
      */}
      <div className="shrink-0 space-y-3">
        <Tabs items={tabsWithCount} active={tab} onChange={changeTab} />

        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[16rem] flex-1">
            <Input
              placeholder="Tìm theo tên chiến lược hoặc mã cổ phiếu…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              leftAddon={<Icon name="search" size={16} />}
            />
          </div>
          <Button
            onClick={() => setEditing({ id: null })}
            leftIcon={<Icon name="plus" size={16} />}
          >
            Tạo chiến lược
          </Button>
        </div>

        {tab === 'mine' && (
          <Alert tone="info">
            Chiến lược bạn tạo <strong>chỉ mình bạn nhìn thấy</strong>. Muốn người khác dùng được thì
            bấm Chia sẻ — người nhận chỉ được xem, không sửa và không chia sẻ tiếp.
            {mine && (
              <>
                {' '}
                Đã dùng {mine.used}/{mine.limit} chiến lược.
              </>
            )}
          </Alert>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {isLoading && tab === 'system' ? (
          <div className="py-16">
            <Spinner label="Đang tải chiến lược…" />
          </div>
        ) : !visible.length ? (
          <EmptyState
            title={
              search
                ? 'Không tìm thấy chiến lược nào'
                : tab === 'system'
                  ? 'Chưa có chiến lược nào'
                  : tab === 'mine'
                    ? 'Bạn chưa tạo chiến lược nào'
                    : 'Chưa có chiến lược nào được chia sẻ cho bạn'
            }
            description={
              search
                ? 'Thử từ khoá khác, ví dụ tên chiến lược hoặc một mã trong danh mục.'
                : tab === 'system'
                  ? 'Chiến lược sẽ xuất hiện tại đây khi đội phân tích công bố.'
                  : tab === 'mine'
                    ? 'Tạo chiến lược riêng để theo dõi bộ mã và ghi lại quy tắc vào lệnh của mình.'
                    : 'Khi ai đó chia sẻ chiến lược của họ, chiến lược sẽ xuất hiện tại đây.'
            }
            action={
              !search && tab === 'mine' ? (
                <Button onClick={() => setEditing({ id: null })}>Tạo chiến lược đầu tiên</Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-4">
            {visible.map((s) =>
              tab === 'system' ? (
                <StrategyCard key={s.id} strategy={s} href={`/strategies/${s.id}`} />
              ) : tab === 'mine' ? (
                <StrategyCard
                  key={s.id}
                  strategy={s}
                  href={`/strategies/mine/${s.id}`}
                  badge={
                    <>
                      <Badge tone="purple">Của tôi</Badge>
                      {/* Chủ sở hữu muốn biết chiến lược của mình đang được bao nhiêu người dùng.
                          Đếm lượt chia sẻ **còn hiệu lực** — đã thu hồi thì không tính. */}
                      <Badge
                        tone={(s as OwnStrategy).share_count > 0 ? 'green' : 'gray'}
                        title="Số người đang được bạn chia sẻ chiến lược này."
                      >
                        <Icon name="users" size={13} />
                        {(s as OwnStrategy).share_count} người đang dùng
                      </Badge>
                    </>
                  }
                  actions={
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSharing(s)}
                        leftIcon={<Icon name="share" size={15} />}
                      >
                        Chia sẻ
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ id: s.id })}>
                        Sửa
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(s)}>
                        Xoá
                      </Button>
                    </>
                  }
                />
              ) : (
                <StrategyCard
                  key={s.id}
                  strategy={s}
                  href={`/strategies/mine/${s.id}`}
                  badge={<Badge tone="cyan">Được chia sẻ</Badge>}
                />
              ),
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-3">
        {visible.length > 0 && (
          <Pagination
            page={currentPage}
            pages={totalPages}
            total={totalItems}
            size={PAGE_SIZE}
            onPageChange={setPage}
          />
        )}

        <Disclaimer />
      </div>

      {editing && (
        <MyStrategyEditor
          strategyId={editing.id}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            toast.success(message);
            setEditing(null);
            refresh();
            setTab('mine');
          }}
        />
      )}

      {sharing && (
        <ShareStrategyModal
          strategy={sharing}
          onClose={() => setSharing(null)}
          onChanged={refresh}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Xoá chiến lược"
        message={`Xoá "${deleting?.name}"? Mọi lượt chia sẻ sẽ bị thu hồi và người nhận không còn xem được.`}
        danger
        loading={remove.loading}
        onConfirm={async () => {
          if (!deleting) return;
          const result = await remove.mutate(deleting.id);
          if (result) {
            toast.success(result.message);
            setDeleting(null);
            refresh();
          }
        }}
      />
    </div>
  );
}
