'use client';

/**
 * Nút Phân tích và kết quả của nó — dùng chung cho chiến lược hệ thống lẫn chiến lược cá nhân.
 *
 * Một cặp (chiến lược, mã) chỉ được phân tích **một lần mỗi ngày**, và kết quả dùng chung cho
 * mọi khách hàng. Nên màn hình này phải nói rõ ba điều mà người dùng không đoán được:
 *
 *   1. Kết quả có thể là **của người khác bấm** — hiện ngay cả khi họ chưa bấm gì.
 *   2. Bấm vào một cặp đã có kết quả thì **không mất lượt**; nút đổi chữ để nói điều đó.
 *   3. Chiến lược theo điều kiện **không tốn lượt nào** — đó là lý do đếm lượt chỉ hiện với
 *      chiến lược theo tài liệu.
 *   4. Bản của những ngày trước **vẫn còn** và xem lại không tốn lượt. Trước đây màn hình chỉ
 *      hỏi bản của hôm nay, nên khách phân tích hôm qua rồi hôm nay mở lại thì tưởng bản cũ đã
 *      mất — dữ liệu vẫn nằm nguyên trong CSDL, chỉ là không có đường nào đọc tới.
 */

import { useEffect, useState } from 'react';

import { AnalysisResult, PENDING_STATUS } from '@/components/domain/AnalysisResult';
import { Alert, Button, Card, EmptyState, Icon, Select, Spinner, StatusBadge } from '@/components/ui';
import { useApiMutation, useApiQuery, useToast } from '@/hooks';
import { ApiError, CUSTOMER, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, toInputDate } from '@/lib/datetime';
import { ANALYSIS_SOURCE } from '@/lib/status';
import type { Analysis, AnalysisDay, AnalysisQuota, AnalysisRequestResult } from '@/types';

type Response = { analysis: Analysis | null; quota: AnalysisQuota };

export function AnalysisPanel({
  strategyId,
  symbol,
  kind,
}: {
  strategyId: number;
  symbol: string;
  /** Quyết định có hiện phần hạn mức hay không — loại điều kiện chạy miễn phí. */
  kind: 'RULE' | 'DOCUMENT';
}) {
  const toast = useToast();
  const [polling, setPolling] = useState(false);
  /** Ngày đang xem. `null` = hôm nay — để **máy chủ** quyết định hôm nay là ngày nào.
   *
   * Không gửi ngày do trình duyệt tự tính cho trường hợp mặc định: đồng hồ máy khách có thể
   * lệch, và khi đó màn hình sẽ đi hỏi một ngày trong khi nút Phân tích lại chạy cho ngày khác. */
  const [day, setDay] = useState<string | null>(null);

  // Đổi mã (hoặc đổi chiến lược) thì quay về hôm nay: ngày của mã cũ gần như chắc chắn không
  // phải ngày mã mới có bản, và giữ lại chỉ dẫn tới một màn hình trống khó hiểu.
  useEffect(() => setDay(null), [strategyId, symbol]);

  const { data: days, refresh: refreshDays } = useApiQuery<AnalysisDay[]>(
    symbol ? `${CUSTOMER}/analysis/dates` : null,
    { strategy_id: strategyId, symbol },
  );

  const { data, error, isLoading, refresh } = useApiQuery<Response>(
    symbol ? `${CUSTOMER}/analysis` : null,
    { strategy_id: strategyId, symbol, date: day ?? undefined },
    // 3 giây: một lượt chạy AI mất vài chục giây tới vài phút, nên hỏi dày hơn chỉ tốn lượt gọi
    // mà không sớm hơn được. Dừng hẳn khi việc đã xong — `0` là tắt trong SWR.
    { refreshInterval: polling ? 3000 : 0 },
  );

  const analysis = data?.analysis ?? null;
  const quota = data?.quota;
  const running = !!analysis && PENDING_STATUS.includes(analysis.status);
  const viewingToday = day === null;

  // Bật/tắt việc hỏi lại theo đúng trạng thái máy chủ trả về, không theo phỏng đoán phía giao
  // diện: người khác có thể vừa bấm phân tích cùng cặp này ở phiên của họ.
  useEffect(() => setPolling(running), [running]);

  // Bản vừa chạy xong là một ngày mới trong ô chọn — nạp lại danh sách để nó có mặt ở đó ngay,
  // thay vì chỉ xuất hiện sau khi khách tải lại trang.
  useEffect(() => {
    if (analysis?.status === 'DONE') void refreshDays();
  }, [analysis?.id, analysis?.status, refreshDays]);

  /** Ô chọn ngày. Mục đầu luôn là "Hôm nay" — kể cả khi hôm nay chưa ai bấm, vì đó là chỗ đặt
   *  nút Phân tích. Ngày hôm nay nếu đã có bản thì bị loại khỏi phần còn lại để không hiện hai
   *  dòng cùng trỏ về một bản. Ngày ở đây chỉ dùng để vẽ nhãn nên tính theo giờ VN phía máy
   *  khách là đủ; tham số gửi lên máy chủ vẫn là chuỗi ngày do chính máy chủ trả về. */
  const todayIso = toInputDate(new Date());
  const dayOptions = [
    { value: '', label: 'Hôm nay' },
    ...(days ?? [])
      .filter((item) => item.analysis_date !== todayIso)
      .map((item) => ({
        value: item.analysis_date,
        label: `${formatDate(item.analysis_date)}${
          item.setup_count > 0 ? ` · ${item.setup_count} kịch bản` : ''
        }`,
      })),
  ];

  const request = useApiMutation<AnalysisRequestResult, void>(() =>
    api.post<AnalysisRequestResult>(`${CUSTOMER}/analysis`, undefined, {
      strategy_id: strategyId,
      symbol,
    }),
  );

  const retry = useApiMutation<AnalysisRequestResult, number>((id) =>
    api.post<AnalysisRequestResult>(`${CUSTOMER}/analysis/${id}/retry`),
  );

  const start = async () => {
    const result = await request.mutate();
    if (!result) return;
    if (result.started) {
      toast.info('Đã bắt đầu phân tích. Kết quả hiện ngay tại đây khi xong.');
    } else if (PENDING_STATUS.includes(result.analysis.status)) {
      toast.info('Mã này đang được phân tích. Bạn không bị trừ lượt.');
    }
    await refresh();
  };

  if (!symbol) {
    return <EmptyState title="Chọn một mã để phân tích" />;
  }

  if (isLoading) {
    return (
      <div className="py-12">
        <Spinner label="Đang kiểm tra kết quả phân tích…" />
      </div>
    );
  }

  if (error) {
    return <Alert tone="danger">{(error as ApiError).message}</Alert>;
  }

  const outOfQuota = kind === 'DOCUMENT' && quota !== undefined && quota.remaining <= 0;

  return (
    <div className="space-y-4">
      {/* ---- Thanh hành động ---- */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink-900">
              Phân tích {symbol} {viewingToday ? 'hôm nay' : `ngày ${formatDate(day)}`}
              <StatusBadge map={ANALYSIS_SOURCE} code={kind === 'DOCUMENT' ? 'AI' : 'ENGINE'}
                           className="ml-2 align-middle" />
            </p>
            <p className="mt-1 text-sm text-ink-500">
              {kind === 'DOCUMENT'
                ? 'AI đọc tài liệu của chiến lược rồi đối chiếu với diễn biến giá.'
                : 'Máy chạy bộ điều kiện của chiến lược trên dữ liệu mới nhất — không tốn lượt.'}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-3">
            {/* Ô chọn ngày chỉ hiện khi thực sự có ngày cũ để chọn — một mình mục "Hôm nay"
                thì nó là một ô rỗng nghĩa, chỉ tổ làm rối thanh hành động. */}
            {dayOptions.length > 1 && (
              <Select
                className="w-44"
                options={dayOptions}
                value={day ?? ''}
                onChange={(event) => setDay(event.target.value || null)}
              />
            )}
            {viewingToday && kind === 'DOCUMENT' && quota && (
              <span
                className={cn(
                  'text-sm tabular-nums',
                  quota.remaining === 0 ? 'font-medium text-tone-red-fg' : 'text-ink-500',
                )}
                title="Đọc lại kết quả đã có không tính vào hạn mức."
              >
                Còn {quota.remaining}/{quota.limit} lượt hôm nay
              </span>
            )}
            {viewingToday ? (
              <Button
                loading={request.loading}
                disabled={running || (outOfQuota && !analysis)}
                onClick={() => void start()}
                leftIcon={<Icon name="sparkles" size={16} />}
              >
                {running ? 'Đang phân tích…' : analysis ? 'Xem lại kết quả' : 'Phân tích'}
              </Button>
            ) : (
              /* Đang xem bản cũ thì không cho bấm Phân tích ngay tại đây: lượt chạy luôn thuộc
                 về hôm nay, và một nút "Phân tích" nằm cạnh ngày 28/08 nói ngược lại điều đó. */
              <Button
                variant="outline"
                onClick={() => setDay(null)}
                leftIcon={<Icon name="refresh" size={15} />}
              >
                Về hôm nay
              </Button>
            )}
          </div>
        </div>

        {request.error && (
          <Alert tone="danger" className="mt-3">
            {request.error.message}
          </Alert>
        )}

        {viewingToday && outOfQuota && !analysis && !request.error && (
          <Alert tone="warning" className="mt-3">
            Bạn đã dùng hết lượt phân tích của hôm nay. Hạn mức đặt lại vào đầu ngày mai. Những mã
            đã có người phân tích hôm nay thì vẫn xem được bình thường, không tốn lượt.
          </Alert>
        )}
      </Card>

      {/* Đang đọc bản cũ thì phải nói thẳng ra. Một nhận định viết cho phiên 28/08 mà người đọc
          tưởng là của hôm nay là kiểu hiểu nhầm tốn tiền thật. */}
      {!viewingToday && (
        <Alert tone="info">
          Bạn đang xem bản phân tích của <strong>ngày {formatDate(day)}</strong> — nhận định viết
          theo dữ liệu của phiên đó, không phải cập nhật cho hôm nay. Xem lại bản cũ không tốn
          lượt phân tích nào.
        </Alert>
      )}

      {/* ---- Kết quả ---- */}
      {!analysis ? (
        <EmptyState
          title={
            viewingToday
              ? 'Chưa có phân tích cho mã này hôm nay'
              : `Không có bản phân tích ngày ${formatDate(day)}`
          }
          description={
            viewingToday
              ? 'Bấm Phân tích để chạy. Kết quả được giữ tới hết ngày và dùng chung cho mọi người xem cùng chiến lược này.'
              : 'Bản của ngày này có thể vừa bị gỡ. Chọn một ngày khác hoặc quay về hôm nay.'
          }
        />
      ) : (
        <AnalysisResult
          analysis={analysis}
          retrying={retry.loading}
          retryError={retry.error?.message ?? null}
          onRetry={async () => {
            const result = await retry.mutate(analysis.id);
            if (result) {
              toast.info('Đang chạy lại.');
              await refresh();
            }
          }}
        />
      )}
    </div>
  );
}
