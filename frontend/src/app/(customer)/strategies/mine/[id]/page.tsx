'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AnalysisPanel } from '@/components/domain/AnalysisPanel';
import { PersonalDocuments } from '@/components/domain/PersonalDocuments';
import { RuleBuilder, emptyRules } from '@/components/domain/RuleBuilder';
import { StrategyRunView } from '@/components/domain/StrategyRunView';
import { SymbolCombobox } from '@/components/domain/SymbolCombobox';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  PageHeader,
  Spinner,
  StatusBadge,
  Tabs,
} from '@/components/ui';
import { useApiQuery, useRuleCatalog, useStrategyRun, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { SCHOOL_LABEL, STRATEGY_KIND } from '@/lib/status';
import type { Message, Strategy, StrategyRules } from '@/types';

/**
 * Thẻ hiển thị theo **loại chiến lược**, không phải một bộ cố định.
 *
 * Chiến lược theo tài liệu không có bộ điều kiện để dựng, và chiến lược theo điều kiện không
 * nhận tài liệu. Hiện cả hai thẻ rồi báo lỗi khi bấm là bắt người dùng tự đoán luật.
 */
function tabsFor(kind: string) {
  const base = [{ key: 'analysis', label: 'Phân tích' }];
  return kind === 'DOCUMENT'
    ? [...base, { key: 'docs', label: 'Tài liệu' }]
    : [...base, { key: 'run', label: 'Chạy thử trên mã' }, { key: 'rules', label: 'Bộ điều kiện' }];
}

/**
 * Chi tiết chiến lược cá nhân.
 *
 * Tách khỏi màn chiến lược hệ thống vì hai thứ khác nhau về quyền: chiến lược cá nhân không có
 * ràng buộc gói, nhưng có phân biệt chủ sở hữu và người được chia sẻ. Và khác biệt quan trọng
 * nhất — ở đây khách hàng **xem được bộ lọc**, vì chính họ là tác giả (BR-848 chỉ bảo vệ chiến
 * lược của hệ thống).
 */
export default function MyStrategyDetailPage() {
  const params = useParams<{ id: string }>();
  const strategyId = Number(params.id);
  const toast = useToast();

  const [tab, setTab] = useState('analysis');
  const [symbol, setSymbol] = useState('');
  const [rules, setRules] = useState<StrategyRules | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading, error, refresh } = useApiQuery<{
    strategy: Strategy;
    is_owner: boolean;
    /** Số người đang được chia sẻ — chỉ chủ sở hữu nhận được con số này. */
    share_count: number | null;
    rules: StrategyRules | null;
  }>(Number.isFinite(strategyId) ? `${CUSTOMER}/my-strategies/${strategyId}` : null);

  const catalog = useRuleCatalog(`${CUSTOMER}/my-strategies/catalog`);
  const runner = useStrategyRun(`${CUSTOMER}/market/ohlcv`);

  const strategy = data?.strategy;
  const isOwner = data?.is_owner ?? false;
  const hasRules = Boolean(data?.rules);

  // Mặc định chạy trên mã đầu tiên trong phạm vi chiến lược — người dùng đổi sang mã khác được.
  useEffect(() => {
    if (!symbol && strategy?.symbols.length) setSymbol(strategy.symbols[0]);
  }, [strategy, symbol]);

  useEffect(() => {
    if (data) setRules(data.rules ?? emptyRules());
  }, [data]);

  if (isLoading) {
    return (
      <div className="py-20">
        <Spinner label="Đang tải chiến lược…" />
      </div>
    );
  }

  if (error || !strategy) {
    return (
      <EmptyState
        title="Không tìm thấy chiến lược"
        description="Chiến lược không tồn tại, đã bị xoá, hoặc quyền xem của bạn đã bị thu hồi."
        action={
          <Link href="/strategies">
            <Button variant="outline">Về danh sách chiến lược</Button>
          </Link>
        }
      />
    );
  }

  const runOnSymbol = async () => {
    if (!symbol) {
      toast.error('Chọn mã cổ phiếu trước khi chạy');
      return;
    }
    const result = await runner.run(`${CUSTOMER}/my-strategies/${strategyId}/run`, symbol);
    if (!result && runner.error) toast.error(runner.error);
  };

  const saveRules = async () => {
    if (!rules) return;
    setSaving(true);
    try {
      await api.put<Message>(`${CUSTOMER}/my-strategies/${strategyId}`, {
        name: strategy.name,
        school: strategy.school,
        symbols: strategy.symbols,
        description: strategy.description,
        rules,
      });
      toast.success('Đã lưu bộ lọc');
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
          <Link href="/strategies" className="hover:text-ink-700">
            ← Danh sách chiến lược
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {strategy.name}
            <Badge tone="blue">{SCHOOL_LABEL[strategy.school] ?? strategy.school}</Badge>
            <StatusBadge map={STRATEGY_KIND} code={strategy.kind} />
            <Badge tone={isOwner ? 'purple' : 'cyan'}>
              {isOwner ? 'Của tôi' : 'Được chia sẻ'}
            </Badge>
            {isOwner && data?.share_count != null && (
              <Badge
                tone={data.share_count > 0 ? 'green' : 'gray'}
                title="Số người đang được bạn chia sẻ chiến lược này (đã trừ các lượt đã thu hồi)."
              >
                <Icon name="users" size={13} /> {data.share_count} người đang dùng
              </Badge>
            )}
          </span>
        }
        description={strategy.description ?? undefined}
      />

      {!isOwner && (
        <Alert tone="info">
          Chiến lược này được người khác chia sẻ với bạn. Bạn xem và chạy phân tích được, nhưng
          không sửa và không chia sẻ tiếp. Chủ sở hữu có thể thu hồi quyền xem bất cứ lúc nào.
        </Alert>
      )}

      <Tabs items={tabsFor(strategy.kind)} active={tab} onChange={setTab} />

      {tab === 'analysis' ? (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Chọn mã để phân tích"
              description="Kết quả của mỗi mã được giữ tới hết ngày. Người được bạn chia sẻ chiến lược cũng đọc được bản đó mà không tốn lượt."
            />
            <SymbolCombobox
              value={symbol}
              onChange={setSymbol}
              className="w-56"
              hint={
                strategy.symbols.length
                  ? `Phạm vi khai báo: ${strategy.symbols.join(', ')}`
                  : undefined
              }
            />
          </Card>
          <AnalysisPanel strategyId={strategyId} symbol={symbol} kind={strategy.kind} />
        </div>
      ) : tab === 'docs' ? (
        <PersonalDocuments strategyId={strategyId} canEdit={isOwner} />
      ) : tab === 'run' ? (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Chạy chiến lược lên một mã"
              description="Chọn mã bất kỳ đang niêm yết để xem chiến lược này sinh ra điểm mua bán nào và kết quả ra sao."
            />

            <div className="flex flex-wrap items-end gap-3">
              <SymbolCombobox
                value={symbol}
                onChange={setSymbol}
                className="w-56"
                hint={
                  strategy.symbols.length
                    ? `Phạm vi khai báo: ${strategy.symbols.join(', ')}`
                    : undefined
                }
              />
              <Button
                loading={runner.loading}
                disabled={!hasRules}
                leftIcon={<Icon name="chart" size={16} />}
                onClick={() => void runOnSymbol()}
              >
                Chạy phân tích
              </Button>
              {symbol && (
                <Link href={`/market?symbol=${symbol}`}>
                  <Button variant="ghost" size="sm" leftIcon={<Icon name="external" size={15} />}>
                    Xem ở bảng giá
                  </Button>
                </Link>
              )}
            </div>

            {!hasRules && (
              <Alert tone="warning" className="mt-3">
                Chiến lược này chưa có bộ lọc nên chưa chạy phân tích được.
                {isOwner ? (
                  <>
                    {' '}
                    Sang thẻ <strong>Bộ lọc</strong> để dựng điều kiện vào và thoát lệnh.
                  </>
                ) : (
                  ' Chủ sở hữu cần bổ sung bộ lọc.'
                )}
              </Alert>
            )}
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
            hasRules && (
              <EmptyState
                title="Chưa chạy phân tích"
                description="Chọn một mã rồi bấm Chạy phân tích để xem điểm mua bán trên biểu đồ."
              />
            )
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {!isOwner ? (
            <Card>
              <CardHeader title="Bộ lọc" />
              <p className="text-sm text-ink-600">
                Chỉ người tạo chiến lược mới sửa được bộ lọc. Bạn vẫn chạy phân tích được ở thẻ
                bên cạnh.
              </p>
            </Card>
          ) : !catalog || !rules ? (
            <Card>
              <div className="py-12">
                <Spinner label="Đang tải danh mục chỉ báo…" />
              </div>
            </Card>
          ) : (
            <>
              <Alert tone="info">
                Điều kiện được tính trên giá đóng cửa từng phiên. Phiên nào thoả thì lệnh mở ở giá
                mở cửa <strong>phiên kế tiếp</strong> — đúng như khi giao dịch thật, không dùng
                thông tin của tương lai.
              </Alert>

              <RuleBuilder value={rules} onChange={setRules} catalog={catalog} disabled={saving} />

              <div className="flex flex-wrap gap-2">
                <Button loading={saving} onClick={() => void saveRules()}>
                  Lưu bộ lọc
                </Button>
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() => setRules(data?.rules ?? emptyRules())}
                >
                  Khôi phục bộ lọc đã lưu
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
