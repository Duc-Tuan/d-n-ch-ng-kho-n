'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  Modal,
  PageHeader,
  Pagination,
  Select,
  Spinner,
  StatusBadge,
} from '@/components/ui';
import { useApiMutation, useApiQuery, usePagination, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { formatDateTime } from '@/lib/datetime';
import { SKIP_REASON_LABEL, TELEGRAM_STATUS } from '@/lib/status';
import type {
  Message,
  NotificationPreference,
  Page,
  Strategy,
  StrategyAlert,
  TelegramStatus,
} from '@/types';

const ALERT_TYPE_LABEL: Record<string, string> = {
  ENTRY: 'Vào lệnh',
  TP: 'Chốt lời',
  SL: 'Cắt lỗ',
  CANCELLED: 'Huỷ lệnh',
};

function NotificationSettings() {
  const toast = useToast();
  const searchParams = useSearchParams();

  const [subscribeOpen, setSubscribeOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  const { data: telegram, refresh: refreshTelegram } = useApiQuery<TelegramStatus>(
    `${CUSTOMER}/telegram`,
  );
  const alertsPage = usePagination(20);
  const { data: alerts, refresh: refreshAlerts } = useApiQuery<Page<StrategyAlert>>(
    `${CUSTOMER}/telegram/alerts`,
    { page: alertsPage.page, size: alertsPage.size },
  );
  const { data: preferences, refresh: refreshPreferences } = useApiQuery<NotificationPreference[]>(
    `${CUSTOMER}/notification-preferences`,
  );

  // Mở sẵn hộp đăng ký khi KH bấm nút 🔔 từ màn biểu đồ chiến lược (mục 15.1).
  useEffect(() => {
    if (searchParams.get('strategy')) setSubscribeOpen(true);
  }, [searchParams]);

  const isConnected = telegram?.status === 'VERIFIED';
  const usage = telegram?.usage;

  const disconnect = useApiMutation<Message, void>(() =>
    api.post<Message>(`${CUSTOMER}/telegram/disconnect`),
  );
  const testSend = useApiMutation<Message, void>(() =>
    api.post<Message>(`${CUSTOMER}/telegram/test`),
  );
  const removeAlert = useApiMutation<Message, number>((id) =>
    api.del<Message>(`${CUSTOMER}/telegram/alerts/${id}`),
  );
  const savePreferences = useApiMutation<Message, NotificationPreference[]>((items) =>
    api.put<Message>(`${CUSTOMER}/notification-preferences`, items),
  );

  // Nhóm cặp đăng ký theo chiến lược, đúng như bố cục ở mục 15.7.
  const grouped = (alerts?.items ?? []).reduce<Record<string, StrategyAlert[]>>((acc, alert) => {
    const key = alert.strategy_name ?? `Chiến lược #${alert.strategy_id}`;
    (acc[key] ??= []).push(alert);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <PageHeader
        title="Cài đặt thông báo"
        description="Kết nối Telegram và quản lý các cặp chiến lược × mã bạn muốn nhận tín hiệu"
      />

      {/* ---------- Kết nối Telegram ---------- */}
      <Card>
        <CardHeader
          title="Kết nối Telegram"
          description="Nhận tín hiệu ngay khi phát sinh, gửi riêng tới tài khoản Telegram của bạn."
          action={<StatusBadge map={TELEGRAM_STATUS} code={telegram?.status ?? 'NOT_CONNECTED'} />}
        />

        {telegram?.status === 'BLOCKED' && (
          <Alert tone="danger" title="Kết nối đã ngừng hoạt động" className="mb-3">
            Bot Telegram đang bị chặn nên hệ thống không gửi được tín hiệu. Hãy bỏ chặn bot trong
            Telegram rồi kết nối lại.
          </Alert>
        )}

        {isConnected ? (
          <div className="space-y-3">
            <dl className="divide-y divide-ink-100 text-sm">
              <div className="flex justify-between gap-3 py-2">
                <dt className="text-ink-500">Tài khoản Telegram</dt>
                <dd className="font-medium">
                  {telegram.telegram_username ? `@${telegram.telegram_username}` : `#${telegram.chat_id}`}
                </dd>
              </div>
              <div className="flex justify-between gap-3 py-2">
                <dt className="text-ink-500">Kết nối lúc</dt>
                <dd>{formatDateTime(telegram.verified_at)}</dd>
              </div>
            </dl>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                loading={testSend.loading}
                onClick={async () => {
                  const result = await testSend.mutate();
                  if (result) toast.success(result.message);
                  else toast.error(testSend.error?.message ?? 'Gửi thất bại');
                }}
              >
                Gửi tin thử
              </Button>
              <Button
                variant="ghost"
                loading={disconnect.loading}
                onClick={async () => {
                  const result = await disconnect.mutate();
                  if (result) {
                    toast.success(result.message);
                    refreshTelegram();
                  }
                }}
              >
                Ngắt kết nối
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-ink-600">
              Bạn chỉ cần bấm 2 nút — hệ thống tự lấy đúng tài khoản Telegram của bạn, không phải
              nhập ID thủ công.
            </p>
            <Button onClick={() => setConnectOpen(true)}>Kết nối Telegram</Button>
          </div>
        )}
      </Card>

      {/* ---------- Danh sách cặp đăng ký ---------- */}
      <Card>
        <CardHeader
          title="Đăng ký nhận tín hiệu"
          description="Mỗi đăng ký là một cặp: chiến lược × mã cổ phiếu."
          action={
            <Button size="sm" onClick={() => setSubscribeOpen(true)} disabled={!isConnected}>
              + Thêm đăng ký
            </Button>
          }
        />

        {/* BR-860 — bộ đếm hạn mức, để KH thấy giới hạn và có lý do nâng gói. */}
        {usage && (
          <div className="mb-4 rounded-lg bg-ink-50 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-600">Lượt đăng ký đã dùng</span>
              <span className="font-medium text-ink-900">
                {usage.unlimited ? `${usage.used} · Không giới hạn` : `${usage.used}/${usage.quota}`}
              </span>
            </div>
            {!usage.unlimited && usage.quota > 0 && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-200">
                <div
                  className="h-full rounded-full bg-brand transition-all"
                  style={{ width: `${Math.min((usage.used / usage.quota) * 100, 100)}%` }}
                />
              </div>
            )}
          </div>
        )}

        {!isConnected && (
          <Alert tone="warning" className="mb-4">
            Kết nối Telegram trước khi đăng ký nhận tín hiệu.
          </Alert>
        )}

        {Object.keys(grouped).length ? (
          <div className="space-y-4">
            {Object.entries(grouped).map(([strategyName, items]) => (
              <div key={strategyName} className="rounded-lg border border-ink-200 p-3">
                <p className="mb-2 text-sm font-semibold text-ink-900">{strategyName}</p>
                <div className="flex flex-wrap gap-2">
                  {items.map((alert) => (
                    <span
                      key={alert.id}
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 ring-inset ${
                        alert.is_active
                          ? 'bg-ink-100 text-ink-900 ring-ink-200'
                          : 'bg-ink-100 text-ink-500 ring-ink-200'
                      }`}
                    >
                      <span className="font-medium">{alert.symbol}</span>
                      <span className="text-[10px] opacity-70">
                        {(alert.alert_types?.types ?? [])
                          .map((t) => ALERT_TYPE_LABEL[t] ?? t)
                          .join(' · ')}
                      </span>
                      <button
                        onClick={async () => {
                          const result = await removeAlert.mutate(alert.id);
                          if (result) {
                            toast.success('Đã huỷ đăng ký');
                            refreshAlerts();
                            refreshTelegram();
                          }
                        }}
                        aria-label={`Huỷ đăng ký ${alert.symbol}`}
                        className="ml-0.5 text-ink-400 hover:text-tone-red-fg"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>

                {/* BR-860c — không xoá âm thầm; giải thích rõ vì sao ngừng nhận. */}
                {items.some((a) => !a.is_active) && (
                  <p className="mt-2 text-xs text-tone-amber-fg">
                    Một số mã đã tạm dừng:{' '}
                    {items
                      .filter((a) => !a.is_active)
                      .map(
                        (a) =>
                          `${a.symbol} (${
                            a.inactive_reason === 'SYSTEM_SCOPE_CHANGED'
                              ? 'mã đã gỡ khỏi phạm vi chiến lược'
                              : a.inactive_reason === 'PACKAGE'
                                ? 'vượt mức gói hiện tại'
                                : 'bạn đã tắt'
                          })`,
                      )
                      .join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="Bạn chưa đăng ký nhận tín hiệu nào"
            description="Chọn chiến lược và mã cổ phiếu để nhận thông báo ngay khi có tín hiệu."
          />
        )}

        {alerts && (
          <Pagination
            page={alerts.page}
            pages={alerts.pages}
            total={alerts.total}
            size={alerts.size}
            onPageChange={alertsPage.setPage}
            onSizeChange={alertsPage.setSize}
          />
        )}
      </Card>

      {/* ---------- Trung tâm tuỳ chọn ---------- */}
      <Card>
        <CardHeader
          title="Loại thông báo"
          description="Bạn có thể tắt các nhóm thông tin. Nhóm bảo mật, giao dịch và điều kiện tài khoản không thể tắt."
        />
        <div className="space-y-3">
          {(preferences ?? []).map((pref) => (
            <div
              key={`${pref.code}-${pref.channel}`}
              className="flex items-center justify-between gap-3 border-b border-ink-100 pb-3 last:border-0"
            >
              <div className="min-w-0">
                <p className="text-sm text-ink-800">{pref.label ?? pref.code}</p>
                <p className="text-xs text-ink-500">
                  {pref.channel === 'EMAIL' ? 'Qua email' : 'Trong ứng dụng'}
                  {/* BR-815 — nêu rõ lý do không tắt được, không chỉ khoá im lặng. */}
                  {pref.locked && ' · Bắt buộc nhận vì liên quan tới bảo mật và quyền lợi tài khoản'}
                </p>
              </div>
              {pref.locked ? (
                <Badge tone="gray">Bắt buộc</Badge>
              ) : (
                <input
                  type="checkbox"
                  checked={pref.enabled}
                  onChange={async (e) => {
                    const next = (preferences ?? []).map((p) =>
                      p.code === pref.code && p.channel === pref.channel
                        ? { ...p, enabled: e.target.checked }
                        : p,
                    );
                    const result = await savePreferences.mutate(next);
                    if (result) refreshPreferences();
                  }}
                  className="h-6 w-6 rounded border-ink-300 text-ink-900"
                  aria-label={pref.label ?? pref.code}
                />
              )}
            </div>
          ))}
        </div>
      </Card>

      <ConnectTelegramModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onConnected={() => {
          refreshTelegram();
          setConnectOpen(false);
        }}
      />

      <SubscribeModal
        open={subscribeOpen}
        onClose={() => setSubscribeOpen(false)}
        defaultStrategyId={searchParams.get('strategy')}
        defaultSymbol={searchParams.get('symbol')}
        onSuccess={() => {
          refreshAlerts();
          refreshTelegram();
          setSubscribeOpen(false);
        }}
      />
    </div>
  );
}

/** BR-861 — luồng deep-link, KH chỉ bấm 2 nút và không phải tự đi tìm chat ID. */
function ConnectTelegramModal({
  open,
  onClose,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const toast = useToast();
  const [consent, setConsent] = useState(false);
  const [link, setLink] = useState<{ deep_link: string; bot_username: string } | null>(null);

  const connect = useApiMutation<{ deep_link: string; bot_username: string }, void>(() =>
    api.post(`${CUSTOMER}/telegram/connect`),
  );
  const { refresh } = useApiQuery<TelegramStatus>(open ? `${CUSTOMER}/telegram` : null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Kết nối Telegram"
      footer={
        link ? (
          <>
            <Button variant="outline" onClick={onClose}>
              Đóng
            </Button>
            <Button
              onClick={async () => {
                await refresh();
                onConnected();
                toast.info('Nếu bạn đã bấm "Bắt đầu" trong Telegram, trạng thái sẽ cập nhật ngay.');
              }}
            >
              Tôi đã bấm Bắt đầu
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button
              disabled={!consent}
              loading={connect.loading}
              onClick={async () => {
                const result = await connect.mutate();
                if (result) setLink(result);
              }}
            >
              Tạo liên kết
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {connect.error && <Alert tone="danger">{connect.error.message}</Alert>}

        {link ? (
          <div className="space-y-3 text-center">
            <p className="text-sm text-ink-600">
              Bấm nút dưới đây để mở Telegram, sau đó bấm <strong>“Bắt đầu”</strong> trong cửa sổ
              chat với bot.
            </p>
            <a href={link.deep_link} target="_blank" rel="noopener noreferrer">
              <Button fullWidth size="lg">
                Mở Telegram (@{link.bot_username})
              </Button>
            </a>
            <p className="text-xs text-ink-500">
              Liên kết có hiệu lực trong 15 phút. Bước “Bắt đầu” là bắt buộc — bot Telegram không
              thể nhắn tin cho người chưa từng mở cuộc trò chuyện với bot.
            </p>
          </div>
        ) : (
          <>
            <ol className="space-y-2 text-sm text-ink-700">
              <li>1. Bấm “Tạo liên kết”, hệ thống sinh một mã dùng một lần.</li>
              <li>2. Bấm nút mở Telegram và bấm “Bắt đầu” trong cửa sổ chat với bot.</li>
              <li>3. Xong — bạn sẽ nhận được tin nhắn xác nhận kết nối.</li>
            </ol>

            {/* BR-879 — checkbox đồng ý riêng, nêu rõ Telegram là bên thứ ba. */}
            <Checkbox
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              label={
                <>
                  Tôi đồng ý việc hệ thống gửi thông tin tín hiệu giao dịch qua nền tảng{' '}
                  <strong>Telegram — một dịch vụ của bên thứ ba nằm ngoài kiểm soát</strong> của
                  đơn vị cung cấp dịch vụ.
                </>
              }
            />
          </>
        )}
      </div>
    </Modal>
  );
}

/** BR-858 — cho tick nhiều mã cùng lúc; dữ liệu vẫn sinh N bản ghi cặp riêng biệt. */
function SubscribeModal({
  open,
  onClose,
  defaultStrategyId,
  defaultSymbol,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  defaultStrategyId: string | null;
  defaultSymbol: string | null;
  onSuccess: () => void;
}) {
  const toast = useToast();
  const [strategyId, setStrategyId] = useState(defaultStrategyId ?? '');
  const [symbols, setSymbols] = useState<string[]>(defaultSymbol ? [defaultSymbol] : []);
  const [types, setTypes] = useState<string[]>(['ENTRY', 'TP', 'SL', 'CANCELLED']);

  // Hộp chọn chiến lược: xin một trang lớn để danh sách đủ dùng mà không kéo cả bảng thống kê.
  const { data: strategies } = useApiQuery<Page<Strategy>>(open ? `${CUSTOMER}/strategies` : null, {
    size: 100,
  });
  const selected = strategies?.items.find((s) => String(s.id) === strategyId);

  useEffect(() => {
    if (defaultStrategyId) setStrategyId(defaultStrategyId);
    if (defaultSymbol) setSymbols([defaultSymbol]);
  }, [defaultStrategyId, defaultSymbol]);

  const subscribe = useApiMutation<
    { created: unknown[]; errors: Array<{ symbol: string; error: string }> },
    { strategy_id: number; symbols: string[]; alert_types: string[] }
  >((input) => api.post(`${CUSTOMER}/telegram/alerts`, input));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Đăng ký nhận tín hiệu"
      description="Chọn chiến lược và các mã bạn muốn theo dõi."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={subscribe.loading}
            disabled={!strategyId || symbols.length === 0 || types.length === 0}
            onClick={async () => {
              const result = await subscribe.mutate({
                strategy_id: Number(strategyId),
                symbols,
                alert_types: types,
              });
              if (result) {
                if (result.created.length) {
                  toast.success(`Đã đăng ký ${result.created.length} cặp`);
                }
                result.errors.forEach((e) => toast.error(`${e.symbol}: ${e.error}`));
                if (result.created.length) onSuccess();
              }
            }}
          >
            Đăng ký
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {subscribe.error && <Alert tone="danger">{subscribe.error.message}</Alert>}

        <Select
          label="Chiến lược"
          required
          value={strategyId}
          onChange={(e) => {
            setStrategyId(e.target.value);
            setSymbols([]);
          }}
          placeholder="— Chọn chiến lược —"
          options={(strategies?.items ?? [])
            .filter((s) => !s.locked)
            .map((s) => ({ value: s.id, label: `${s.name} (${s.timeframe})` }))}
          hint="Chỉ hiển thị chiến lược mà gói hiện tại của bạn được xem."
        />

        {selected && (
          <div>
            <p className="mb-2 text-sm font-medium text-ink-700">
              Mã cổ phiếu <span className="text-tone-red-fg">*</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {selected.symbols.map((symbol) => {
                const active = symbols.includes(symbol);
                return (
                  <button
                    key={symbol}
                    onClick={() =>
                      setSymbols((current) =>
                        active ? current.filter((s) => s !== symbol) : [...current, symbol],
                      )
                    }
                    className={`min-h-touch rounded-lg border px-3 text-sm font-medium transition-colors ${
                      active
                        ? 'border-ink-800 bg-ink-100 text-ink-900'
                        : 'border-ink-300 text-ink-600 hover:bg-ink-50'
                    }`}
                  >
                    {symbol}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-ink-500">
              Đã chọn {symbols.length} mã — mỗi mã tính là một lượt đăng ký.
            </p>
          </div>
        )}

        <div>
          <p className="mb-2 text-sm font-medium text-ink-700">Loại thông báo</p>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(ALERT_TYPE_LABEL).map(([key, label]) => (
              <Checkbox
                key={key}
                checked={types.includes(key)}
                onChange={(e) =>
                  setTypes((current) =>
                    e.target.checked ? [...current, key] : current.filter((t) => t !== key),
                  )
                }
                label={label}
              />
            ))}
          </div>
        </div>

        {/* BR-872/877 — nói trước để KH không thắc mắc khi tin về muộn hoặc bị gom. */}
        <Alert tone="info">
          Tín hiệu chỉ được gửi trong giờ giao dịch. Nếu số tín hiệu trong ngày vượt hạn mức, phần
          còn lại được gom thành một tin tổng hợp cuối phiên.
        </Alert>
      </div>
    </Modal>
  );
}

export default function NotificationSettingsPage() {
  return (
    <Suspense fallback={<Spinner label="Đang tải…" />}>
      <NotificationSettings />
    </Suspense>
  );
}
