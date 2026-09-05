'use client';

/**
 * Nút "AI phân tích" ở màn bảng giá.
 *
 * Khác nút bên màn chiến lược ở **căn cứ**: ở đó mô hình đọc tài liệu của chiến lược, ở đây nó
 * đọc đúng bộ chỉ báo người dùng đang bật trên biểu đồ ngay phía trên. Kết quả có cùng hình
 * dạng nên phần hiển thị dùng chung `AnalysisResult`.
 *
 * Màn này **chỉ hiện nhận định của đúng bộ chỉ báo đang bật**, không hiện bản gần nhất bất kỳ
 * của mã. Một nhận định chỉ có nghĩa cùng với những đường đã sinh ra nó: để bản viết khi chưa
 * bật gì nằm ngay dưới một biểu đồ đầy chỉ báo là mời người đọc hiểu nhầm căn cứ, mà trên màn
 * hình thì không có gì tố cáo điều đó. Đổi chỉ báo ⇒ quay về trạng thái chưa phân tích.
 *
 * Câu hỏi kèm theo cũng là một phần của câu hỏi, đúng nghĩa đen: cùng bộ chỉ báo mà hỏi "vào
 * được chưa" hay "cắt lỗ ở đâu" là hai bản phân tích khác nhau, nên nó nằm trong vân tay và một
 * lời dặn mới tốn một lượt mới.
 *
 * Hai điều màn hình phải nói rõ, vì người dùng không đoán được:
 *
 *   1. **Nhận định dựa trên cái gì** — liệt kê tên các chỉ báo sẽ gửi đi, trước khi họ bấm.
 *   2. **Bấm lại có mất lượt không** — cùng bộ chỉ báo *và* cùng lời dặn trong ngày thì không.
 */
import { useEffect, useMemo, useState } from 'react';

import { AnalysisResult, PENDING_STATUS } from '@/components/domain/AnalysisResult';
import { Alert, Badge, Button, Card, EmptyState, Icon, Spinner, Textarea } from '@/components/ui';
import { useApiMutation, useApiQuery, useDebounced, useLocalStorage, useToast } from '@/hooks';
import { ApiError, CUSTOMER, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { buildIndicatorSnapshot, toIndicatorCandles } from '@/lib/indicators/snapshot';
import type { IndicatorInstance } from '@/lib/indicators/types';
import type { Analysis, AnalysisQuota, AnalysisRequestResult, Candle } from '@/types';

type Response = { analysis: Analysis | null; quota: AnalysisQuota };

export function MarketAnalysisPanel({
  symbol,
  candles,
  instances,
}: {
  symbol: string;
  candles: Candle[];
  /** Chỉ báo đang bật trên biểu đồ — chính là căn cứ của lượt phân tích. */
  instances: IndicatorInstance[];
}) {
  const toast = useToast();
  const [polling, setPolling] = useState(false);

  /**
   * Lời dặn, nhớ theo từng mã và giữ qua lần tải trang.
   *
   * Phải giữ vì nó nằm trong vân tay: quên câu hỏi là màn hình đi tìm một vân tay khác và báo
   * "chưa phân tích" cho một bản mà khách vừa trả một lượt để có. Theo từng mã vì lời dặn hầu
   * như luôn gắn với mã ("tôi đang giữ giá vốn 21.5"), đem nguyên văn đó sang mã khác là sai.
   */
  const [notes, setNotes] = useLocalStorage<Record<string, string>>('market-analysis-notes', {});
  const note = notes[symbol] ?? '';
  /** Hoãn một nhịp trước khi đi tìm: gõ tới đâu gọi máy chủ tới đó thì mỗi phím là một lượt gọi. */
  const askedNote = useDebounced(note, 400);

  /** Ảnh chụp bộ chỉ báo, tính lại mỗi khi người dùng đổi chỉ báo hoặc đổi mã. */
  const snapshot = useMemo(
    () => buildIndicatorSnapshot(instances, toIndicatorCandles(candles)),
    [instances, candles],
  );
  const labels = snapshot.map((item) => item.label);

  /**
   * Địa chỉ của bản phân tích cần hiện: mã + bộ chỉ báo đang bật.
   *
   * Chỉ gửi `id` và `params` — vừa đủ để máy chủ dựng lại vân tay. Giá trị từng phiên chỉ cần
   * khi thật sự chạy, và nhét chúng vào một địa chỉ GET thì vượt giới hạn độ dài ngay.
   */
  const applied = useMemo(
    () => JSON.stringify(snapshot.map(({ id, params }) => ({ id, params }))),
    [snapshot],
  );

  const { data, error, isLoading, refresh } = useApiQuery<Response>(
    symbol ? `${CUSTOMER}/analysis/market` : null,
    { symbol, indicators: applied, note: askedNote },
    // 3 giây, cùng lý do như bên chiến lược: một lượt AI mất vài chục giây tới vài phút nên hỏi
    // dày hơn chỉ tốn lượt gọi. `0` là tắt hẳn trong SWR.
    { refreshInterval: polling ? 3000 : 0 },
  );

  const analysis = data?.analysis ?? null;
  const quota = data?.quota;
  const running = !!analysis && PENDING_STATUS.includes(analysis.status);

  useEffect(() => setPolling(running), [running]);

  const request = useApiMutation<AnalysisRequestResult, void>(() =>
    api.post<AnalysisRequestResult>(`${CUSTOMER}/analysis/market`, {
      symbol,
      indicators: snapshot,
      note,
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
    } else {
      toast.info('Bạn đã phân tích đúng bộ chỉ báo này hôm nay — đọc lại bản cũ, không tốn lượt.');
    }
    await refresh();
  };

  if (!symbol) return null;

  const outOfQuota = quota !== undefined && quota.remaining <= 0;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink-900">AI phân tích {symbol}</p>
            <p className="mt-1 text-sm text-ink-500">
              Mô hình đọc dữ liệu giá của {symbol} cùng <strong>các chỉ báo bạn đang bật</strong>{' '}
              trên biểu đồ, rồi viết nhận định.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {quota && (
              <span
                className={cn(
                  'text-sm tabular-nums',
                  quota.remaining === 0 ? 'font-medium text-tone-red-fg' : 'text-ink-500',
                )}
                title="Đọc lại bản đã có không tính vào hạn mức."
              >
                Còn {quota.remaining}/{quota.limit} lượt hôm nay
              </span>
            )}
            <Button
              loading={request.loading}
              disabled={running || !candles.length || (outOfQuota && !analysis)}
              onClick={() => void start()}
              leftIcon={<Icon name="sparkles" size={16} />}
            >
              {running ? 'Đang phân tích…' : 'Phân tích'}
            </Button>
          </div>
        </div>

        {/* Nói trước sẽ gửi gì đi. Sau khi bấm mới biết thì đã muộn — lượt đã bị trừ rồi. */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-ink-100 pt-3">
          <span className="text-xs text-ink-500">Sẽ phân tích theo:</span>
          {labels.length ? (
            labels.map((name) => (
              <Badge key={name} tone="gray">
                {name}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-ink-500">
              chưa bật chỉ báo nào — mô hình sẽ đọc thuần nến và khối lượng. Bấm{' '}
              <strong>Chỉ báo</strong> trên biểu đồ để thêm.
            </span>
          )}
        </div>

        {/* Ô dặn thêm. Đặt ngay dưới danh sách chỉ báo vì hai thứ này hợp thành một câu hỏi:
            chỉ báo là căn cứ, lời dặn là điều muốn biết. */}
        <div className="mt-3 border-t border-ink-100 pt-3">
          <Textarea
            label="Muốn hỏi thêm gì? (không bắt buộc)"
            hint="Ví dụ: tôi đang giữ giá vốn 21.5, nên chốt hay giữ tiếp? · Đổi câu hỏi là một câu hỏi khác nên tốn thêm một lượt."
            rows={10}
            maxLength={1000}
            value={note}
            placeholder="Để trống thì mô hình tự viết nhận định chung theo giá và các chỉ báo trên."
            onChange={(event) => setNotes({ ...notes, [symbol]: event.target.value })}
            disabled={running}
          />
        </div>

        {request.error && (
          <Alert tone="danger" className="mt-3">
            {request.error.message}
          </Alert>
        )}

        {outOfQuota && !analysis && !request.error && (
          <Alert tone="warning" className="mt-3">
            Bạn đã dùng hết lượt phân tích của hôm nay. Hạn mức đặt lại vào đầu ngày mai và dùng
            chung với nút Phân tích ở màn chiến lược.
          </Alert>
        )}
      </Card>

      {isLoading ? (
        <Card>
          <Spinner label="Đang kiểm tra kết quả phân tích…" />
        </Card>
      ) : error ? (
        <Alert tone="danger">{(error as ApiError).message}</Alert>
      ) : !analysis ? (
        <EmptyState
          title={
            note
              ? `Chưa phân tích ${symbol} theo câu hỏi này`
              : `Chưa phân tích ${symbol} theo bộ chỉ báo này`
          }
          description={
            labels.length
              ? `Bấm Phân tích để mô hình đọc giá cùng ${labels.join(', ')} rồi viết nhận định. Đổi chỉ báo là một câu hỏi khác, nên màn này chỉ hiện nhận định của đúng bộ đang bật.`
              : 'Bấm Phân tích để mô hình đọc nến và khối lượng rồi viết nhận định. Bật thêm chỉ báo trên biểu đồ thì đó là một câu hỏi khác, và màn này chỉ hiện nhận định của đúng bộ đang bật.'
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
