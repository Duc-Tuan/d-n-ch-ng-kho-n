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
  Tabs,
} from '@/components/ui';
import { useApiMutation, useApiQuery, useDebounced, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { cn } from '@/lib/cn';
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
 * Một ô chỉ số trong dải KPI.
 *
 * Giá trị **trên**, nhãn **dưới**. Mắt quét một dải chỉ số theo hàng ngang và bắt vào hàng chữ
 * to trước; đặt nhãn lên trên thì mỗi ô bắt người đọc đi qua một dòng chữ xám trước khi tới con
 * số họ cần.
 */
function Kpi({
  label,
  value,
  bar,
  hint,
  strong = false,
}: {
  label: string;
  value: string;
  /** 0–100. Có thì vẽ một thanh mảnh ngay dưới con số. */
  bar?: number | null;
  hint?: string;
  /** Con số chủ đạo của cả hàng — to hơn hẳn ba ô còn lại. */
  strong?: boolean;
}) {
  return (
    <div title={hint} className="min-w-0">
      <p
        className={cn(
          'font-semibold tabular-nums leading-none text-ink-900',
          strong ? 'text-2xl' : 'text-base',
        )}
      >
        {value}
      </p>

      {bar !== undefined && bar !== null && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-200">
          <div
            className="h-full rounded-full bg-up"
            style={{ width: `${Math.min(Math.max(bar, 0), 100)}%` }}
          />
        </div>
      )}

      <p className="mt-1.5 truncate text-[11px] leading-tight text-ink-500">{label}</p>
    </div>
  );
}

/**
 * Dải chỉ số của tín hiệu **thực**.
 *
 * BR-841 — LIVE và BACKTEST hiển thị tách biệt. Bản trước cho hai loại hai cái hộp bằng nhau,
 * cạnh nhau, cùng cỡ chữ: đúng về mặt "có tách" nhưng sai về mặt người đọc thực sự thấy gì —
 * hai khối giống hệt nhau đọc ra là hai thứ ngang giá trị, và con số mô phỏng bao giờ cũng đẹp
 * hơn con số thực. Ở đây winrate thực là con số lớn nhất hàng, còn mô phỏng co lại thành một
 * dòng chữ nhỏ màu chìm (`BacktestLine`).
 *
 * BR-843 — mọi con số đều kèm khoảng thời gian được tính, không có ngoại lệ.
 */
function LiveStats({ stats }: { stats: StrategyStats | null }) {
  if (!stats || stats.total_trades === 0) {
    return (
      <p className="text-xs text-ink-400">
        Chưa có tín hiệu thực — chiến lược chưa phát lệnh nào trên thị trường.
      </p>
    );
  }

  /* Khối này mở ra theo `total_trades` nhưng mọi con số bên trong đều tính trên lệnh **đã
     đóng**. Chiến lược vừa phát tín hiệu, chưa lệnh nào chạm TP/SL, sẽ hiện "Số lệnh 0" kèm ba
     dấu gạch — đọc y hệt như lỗi, hoặc tệ hơn là như chiến lược thua sạch. BR-843: nói thẳng là
     chưa có gì để tính, thay vì bỏ số không vào ô. */
  if (stats.closed_trades === 0) {
    return (
      <p className="text-xs leading-relaxed text-ink-600">
        {stats.open_trades > 0
          ? `Đang mở ${stats.open_trades} lệnh, chưa lệnh nào đóng nên chưa tính được winrate.`
          : `${stats.total_trades} tín hiệu đều đã huỷ, không còn lệnh nào để tính.`}
      </p>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4 lg:gap-x-8">
        <Kpi
          strong
          label="Winrate"
          value={formatPercent(stats.win_rate)}
          bar={stats.win_rate}
          hint="Tỉ lệ lệnh đã đóng có lãi"
        />
        <Kpi label="R trung bình" value={formatR(stats.avg_r)} hint="Lãi/lỗ trung bình mỗi lệnh" />
        <Kpi
          label="Sụt giảm lớn nhất"
          value={stats.max_dd !== null ? `${stats.max_dd.toFixed(2)}R` : '—'}
          hint="Chuỗi lỗ sâu nhất tính theo R"
        />
        <Kpi
          label="Lệnh đã đóng"
          value={String(stats.closed_trades)}
          hint="Số lệnh dùng để tính các con số trên"
        />
      </div>

      <p className="mt-3 text-[11px] text-ink-500">
        Tín hiệu thực · {formatDate(stats.period_from)} – {formatDate(stats.period_to)}
        {stats.open_trades > 0 && ` · còn ${stats.open_trades} lệnh đang mở, chưa tính vào`}
      </p>
    </div>
  );
}

/**
 * Mô phỏng — một dòng, chữ nhỏ, màu chìm.
 *
 * Không phải để giấu: con số mô phỏng vẫn đứng đó đủ cả winrate, R và số lệnh, và vẫn kèm
 * khoảng thời gian (BR-843). Nhưng nó **chưa từng xảy ra trên thị trường**, nên nó không được
 * quyền có cùng cỡ chữ với con số thực — đó là toàn bộ tinh thần của BR-841.
 */
function BacktestLine({ stats }: { stats: StrategyStats | null }) {
  if (!stats || stats.closed_trades === 0) return null;

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-500">
      <span className="rounded bg-ink-100 px-1.5 py-0.5 font-medium text-ink-600">Mô phỏng</span>
      <span className="tabular-nums">{formatPercent(stats.win_rate)} winrate</span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">{formatR(stats.avg_r)}</span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">{stats.closed_trades} lệnh</span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">
        {formatDate(stats.period_from)} – {formatDate(stats.period_to)}
      </span>
      <span className="text-ink-400">— chưa từng phát ra thực tế</span>
    </p>
  );
}

/** Chữ lồng của trường phái, dùng làm dấu nhận biết nhanh ở đầu mỗi hàng. */
function schoolMonogram(school: string): string {
  const label = SCHOOL_LABEL[school] ?? school;
  const words = label.split(/[\s_]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

/**
 * Một chiến lược = một **hàng** trong danh sách, không phải một cái thẻ riêng.
 *
 * Đây là thay đổi lớn nhất so với bản trước, và lý do thuần tuý là thị giác: mười cái thẻ có
 * viền, mỗi thẻ lại bọc thêm một cái hộp thống kê có viền bên trong, cho ra một trang toàn
 * khung lồng khung — mắt phải vượt qua hai lớp đường kẻ mới tới được con số. Danh sách tài
 * chính dày (Ramp, Brex, các bảng xếp hạng quỹ) đi hướng ngược lại: **một** mặt phẳng, các
 * hàng ngăn nhau bằng đúng một đường kẻ 1px, và thông tin xếp thành cột có nhịp.
 *
 * Hàng chia ba tầng, và thứ tự này là thứ giữ cho hàng không bị cao:
 *
 *   1. **Đầu hàng** — chữ lồng, tên, nhãn, và nút hành động ở mép phải. Nút nằm ở đây chứ
 *      không nằm dưới dải chỉ số: để nó ở dưới thì nó tự chiếm một dòng riêng và kéo cả hàng
 *      cao thêm chừng 60px, nhân với mười hàng là mất hơn nửa màn hình.
 *   2. **Thân hàng** — hai cột: mô tả và phạm vi mã bên trái, dải chỉ số bên phải.
 *   3. **Chân hàng** — dòng mô phỏng, chữ nhỏ màu chìm, chạy hết bề ngang.
 */
function StrategyRow({
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
  const symbols = strategy.symbols.slice(0, 8);
  const overflow = strategy.symbols.length - symbols.length;

  return (
    <div className="group px-4 py-4 transition-colors hover:bg-ink-50/60 sm:px-5">
      {/* ---------- 1. Đầu hàng ---------- */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3.5">
          {/* Ô chữ lồng: ở một danh sách mười dòng toàn chữ, mắt cần một điểm neo để phân biệt
              các dòng trước khi kịp đọc tên. Dùng màu thương hiệu chứ không phải màu riêng theo
              trường phái — màu ở site này chỉ được phép mang thông tin trạng thái, mà "trường
              phái nào" không phải một trạng thái. */}
          <span
            aria-hidden
            className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-xs font-bold tracking-tight text-brand"
          >
            {schoolMonogram(strategy.school)}
          </span>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={strategy.locked ? '/pricing' : href}
                className="text-[0.9375rem] font-semibold leading-snug text-ink-900 transition-colors hover:text-brand"
              >
                {strategy.name}
              </Link>
              {strategy.locked && <Badge tone="amber">Gói cao hơn</Badge>}
              {badge}
            </div>

            {/* Bốn thuộc tính gộp thành một dòng chữ nhỏ ngăn bằng dấu chấm giữa, thay cho bốn
                cái nhãn màu xếp cạnh tên. Nhãn màu chỉ nên dành cho thứ cần bắt mắt; dùng cho
                cả những thuộc tính bình thường thì không còn gì nổi lên nữa. */}
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
              <span>{SCHOOL_LABEL[strategy.school] ?? strategy.school}</span>
              <span aria-hidden>·</span>
              <span>{STRATEGY_KIND[strategy.kind]?.label ?? strategy.kind}</span>
              <span aria-hidden>·</span>
              <span>{strategy.timeframe}</span>
              <span aria-hidden>·</span>
              <span>{strategy.symbols.length} mã</span>
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {actions}
          <Link href={strategy.locked ? '/pricing' : href}>
            <Button
              size="sm"
              variant={strategy.locked ? 'outline' : 'primary'}
              rightIcon={strategy.locked ? undefined : <Icon name="chevron-right" size={15} />}
            >
              {strategy.locked ? 'Nâng cấp gói' : 'Xem biểu đồ'}
            </Button>
          </Link>
        </div>
      </div>

      {/* ---------- 2. Thân hàng ----------
          `lg:w-[27rem]` cố định bề rộng cột chỉ số: nhờ vậy dải chỉ số của mọi hàng **thẳng cột
          với nhau** dù tên chiến lược dài ngắn khác nhau. Để nó co giãn theo nội dung thì mỗi
          hàng một vị trí, và cả danh sách mất nhịp — đó chính là thứ phân biệt một bảng xếp
          hạng với một chồng thẻ.

          Lề trái `lg:pl-[3.375rem]` cho cột mô tả thụt vào đúng bằng bề rộng ô chữ lồng cộng
          khoảng cách, để nó thẳng hàng với tên chiến lược ở trên. */}
      <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-8">
        <div className="min-w-0 flex-1 lg:pl-[3.375rem]">
          {strategy.description && (
            <p className="line-clamp-2 max-w-prose text-sm leading-relaxed text-ink-600">
              {strategy.description}
            </p>
          )}

          {symbols.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1">
              {symbols.map((symbol) => (
                <span
                  key={symbol}
                  className="rounded-md bg-ink-100 px-2 py-0.5 text-xs font-medium tabular-nums text-ink-700"
                >
                  {symbol}
                </span>
              ))}
              {overflow > 0 && (
                <span
                  className="px-1 py-0.5 text-xs text-ink-400"
                  title={strategy.symbols.join(', ')}
                >
                  +{overflow}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 lg:w-[27rem]">
          <LiveStats stats={strategy.stats_live} />
        </div>
      </div>

      {/* ---------- 3. Chân hàng ---------- */}
      {strategy.stats_backtest && strategy.stats_backtest.closed_trades > 0 && (
        <div className="mt-3 border-t border-line pt-2.5 lg:pl-[3.375rem]">
          <BacktestLine stats={strategy.stats_backtest} />
        </div>
      )}
    </div>
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
          <Card padded={false} className="divide-y divide-line overflow-hidden">
            {visible.map((s) =>
              tab === 'system' ? (
                <StrategyRow key={s.id} strategy={s} href={`/strategies/${s.id}`} />
              ) : tab === 'mine' ? (
                <StrategyRow
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
                <StrategyRow
                  key={s.id}
                  strategy={s}
                  href={`/strategies/mine/${s.id}`}
                  badge={<Badge tone="cyan">Được chia sẻ</Badge>}
                />
              ),
            )}
          </Card>
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
