'use client';

/**
 * Kết quả một lượt phân tích — dùng chung cho hai chỗ bấm nút.
 *
 * Màn chiến lược và màn bảng giá hỏi hai câu khác nhau (tài liệu chiến lược, hay bộ chỉ báo
 * trên biểu đồ), nhưng **câu trả lời có cùng hình dạng**: tiêu đề, bản tin, kịch bản vào lệnh,
 * lý do, bài viết liên quan. Vẽ hai lần là để chúng trôi khỏi nhau — sửa cách hiện kịch bản ở
 * một chỗ rồi quên chỗ kia, và khách gặp hai giao diện khác nhau cho cùng một thứ.
 *
 * Ba trạng thái đều nằm ở đây vì chúng thay nhau trên cùng một khoảng màn hình: đang chạy,
 * chạy hỏng, và có kết quả.
 */
import Link from 'next/link';

import { Alert, Badge, Button, Card, Icon, Spinner, StatusBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/datetime';
import { formatNumber } from '@/lib/format';
import { ANALYSIS_SOURCE, ANALYSIS_STATUS } from '@/lib/status';
import type { Analysis, AnalysisSetup, RelatedArticle } from '@/types';

/** Trạng thái còn đang chạy — vẫn phải hỏi lại máy chủ. */
export const PENDING_STATUS = ['QUEUED', 'RUNNING'];

function SetupCard({ setup }: { setup: AnalysisSetup }) {
  const isBuy = setup.direction === 'BUY';
  return (
    <div
      className={cn(
        'rounded-xl border p-4',
        isBuy
      ? 'border-tone-green-line bg-tone-green-bg/50'
      : 'border-tone-red-line bg-tone-red-bg/50',
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className={cn('text-sm font-semibold', isBuy ? 'text-up' : 'text-down')}>
          {isBuy ? '▲ Kịch bản MUA' : '▼ Kịch bản BÁN'}
        </span>
        {setup.confidence && (
          <Badge
            tone={
              setup.confidence === 'HIGH' ? 'green' : setup.confidence === 'LOW' ? 'gray' : 'blue'
            }
          >
            {setup.confidence === 'HIGH'
              ? 'Tin cậy cao'
              : setup.confidence === 'LOW'
                ? 'Tin cậy thấp'
                : 'Tin cậy trung bình'}
          </Badge>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-ink-500">Giá vào</dt>
          <dd className="mt-0.5 font-semibold tabular-nums text-ink-900">
            {formatNumber(setup.entry_price)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">Cắt lỗ</dt>
          <dd className="mt-0.5 font-medium tabular-nums text-down">
            {setup.sl !== null ? formatNumber(setup.sl) : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">Chốt lời</dt>
          <dd className="mt-0.5 font-medium tabular-nums text-up">
            {setup.tp !== null ? formatNumber(setup.tp) : '—'}
          </dd>
        </div>
      </dl>

      {setup.note && <p className="mt-3 text-sm leading-relaxed text-ink-600">{setup.note}</p>}
    </div>
  );
}

/**
 * Bài viết doanh nghiệp gắn theo thẻ.
 *
 * Đặt **sau** phần lý do phân tích: đây là đọc thêm, không phải kết luận. Bài bị khoá theo gói
 * vẫn hiện tên kèm ổ khoá — trang bài viết đã tự chặn nội dung, nên dẫn sang đó là an toàn và
 * khách biết mình đang bỏ lỡ gì.
 *
 * Mở sang tab mới: kết quả phân tích là thứ khách vừa chờ vài phút để có. Điều hướng đè lên nó
 * để đọc một bài phụ rồi phải bấm quay lại — mất luôn vị trí cuộn và lượt hỏi lại máy chủ đang
 * chạy — là đổi cái chính lấy cái phụ.
 */
function RelatedArticles({ articles, symbol }: { articles: RelatedArticle[]; symbol: string }) {
  if (articles.length === 0) return null;

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
        Phần tích cơ bản về doanh nghiệp: {symbol}
      </p>
      <ul className="divide-y divide-ink-100 rounded-xl border border-ink-100">
        {articles.map((article) => (
          <li key={article.id}>
            <Link
              href={`/articles/${article.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-ink-50"
            >
              <Icon name="document" size={16} className="mt-0.5 shrink-0 text-ink-400" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-ink-900">{article.title}</span>
                  {article.locked && (
                    <Icon name="lock" size={13} className="shrink-0 text-tone-amber-fg" />
                  )}
                  {/* Báo trước là sẽ mở tab mới — người dùng không thích bị bất ngờ về điều đó. */}
                  <Icon name="external" size={12} className="shrink-0 text-ink-400" />
                </span>
                {article.excerpt && (
                  <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-ink-500">
                    {article.excerpt}
                  </span>
                )}
                {article.published_at && (
                  <span className="mt-1 block text-xs text-ink-400">
                    {formatDateTime(article.published_at)}
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AnalysisResult({
  analysis,
  onRetry,
  retrying,
  retryError,
}: {
  analysis: Analysis;
  onRetry?: () => void;
  retrying?: boolean;
  retryError?: string | null;
}) {
  const running = PENDING_STATUS.includes(analysis.status);
  /** Bản theo biểu đồ: căn cứ là bộ chỉ báo của người dùng, không phải chiến lược nào cả. */
  const fromChart = analysis.strategy_id === null;

  if (running) {
    return (
      <Card>
        <div className="py-10">
          <Spinner
            label={
              analysis.status === 'QUEUED'
                ? 'Đang xếp hàng chờ tới lượt…'
                : 'Đang đọc dữ liệu và viết nhận định…'
            }
          />
          <p className="mt-3 text-center text-sm text-ink-500">
            Thường mất vài chục giây tới vài phút. Bạn có thể rời trang và quay lại sau — kết quả
            vẫn được lưu.
          </p>
        </div>
      </Card>
    );
  }

  if (analysis.status === 'FAILED') {
    return (
      <Card>
        <Alert tone="danger" title="Không phân tích được">
          {analysis.error_message ?? 'Không rõ lý do.'}
        </Alert>
        {onRetry && (
          <Button
            className="mt-3"
            variant="outline"
            loading={retrying}
            onClick={onRetry}
            leftIcon={<Icon name="refresh" size={15} />}
          >
            Thử lại
          </Button>
        )}
        {retryError && (
          <Alert tone="danger" className="mt-3">
            {retryError}
          </Alert>
        )}
      </Card>
    );
  }

  return (
    <Card className="space-y-5">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <StatusBadge map={ANALYSIS_STATUS} code={analysis.status} />
          <StatusBadge map={ANALYSIS_SOURCE} code={analysis.source} />
          <span className="text-xs text-ink-500">
            {formatDateTime(analysis.completed_at ?? analysis.created_at)} ·{' '}
            {formatNumber(analysis.view_count)} lượt xem
          </span>
        </div>
        {analysis.title && (
          <h3 className="text-lg font-semibold leading-snug text-ink-900">{analysis.title}</h3>
        )}
      </div>

      {/* Bộ chỉ báo mà nhận định dựa vào. Người dùng tự chọn bộ này nên nó không phải bí mật
          như `evidence` — và không nói ra thì họ không kiểm chứng được nhận định bằng gì. */}
      {analysis.used_indicators && analysis.used_indicators.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ink-500">Dựa trên chỉ báo:</span>
          {analysis.used_indicators.map((name) => (
            <Badge key={name} tone="gray">
              {name}
            </Badge>
          ))}
        </div>
      )}

      {/* Câu hỏi đã gửi kèm. Đọc một nhận định mà không nhớ mình hỏi gì thì không đánh giá
          được nó có trả lời trúng hay không — nhất là khi mở lại trang sau vài giờ. */}
      {analysis.note && (
        <div className="rounded-lg border-l-2 border-ink-300 bg-ink-50 px-3 py-2">
          <p className="text-xs text-ink-500">Bạn đã hỏi</p>
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink-700">{analysis.note}</p>
        </div>
      )}

      {analysis.summary && (
        /* `summary` đã được lọc ở máy chủ **lúc lưu** (`html_sanitizer`), nên render HTML ở đây
           là an toàn. `rationale` bên dưới thì không — nó là văn bản thuần. */
        <div className="prose-article" dangerouslySetInnerHTML={{ __html: analysis.summary }} />
      )}

      {analysis.setups.length > 0 ? (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
            {analysis.setups.length} kịch bản vào lệnh
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {analysis.setups.map((setup) => (
              <SetupCard key={setup.id} setup={setup} />
            ))}
          </div>
        </div>
      ) : (
        <Alert tone="info">
          Phiên này <strong>không có điểm vào lệnh</strong>{' '}
          {fromChart ? 'theo các chỉ báo đang bật' : 'theo chiến lược'}. Đứng ngoài cũng là một
          quyết định — đó là kết quả, không phải lỗi.
        </Alert>
      )}

      {analysis.rationale && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
            Lý do phân tích
          </p>
          {/* Văn bản thuần, KHÔNG phải HTML — `whitespace-pre-wrap` giữ lại xuống dòng. */}
          <p className="whitespace-pre-wrap text-article leading-relaxed text-ink-700">
            {analysis.rationale}
          </p>
        </div>
      )}

      <RelatedArticles articles={analysis.related_articles ?? []} symbol={analysis.symbol} />
    </Card>
  );
}
