'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

import { Card, EmptyState, Spinner } from '@/components/ui';
import { useApiQuery } from '@/hooks';
import { PUBLIC } from '@/lib/api';
import { formatDate } from '@/lib/datetime';
import type { LegalDocument } from '@/types';

/**
 * Văn bản pháp lý công khai — mục 9.1.
 *
 * Không đặt trong route group `(customer)` vì phải xem được **trước khi đăng ký**
 * (bước đăng ký có link mở trong tab mới) và ở footer khi chưa đăng nhập.
 */
const TYPE_MAP: Record<string, string> = {
  tos: 'TOS',
  privacy: 'PRIVACY',
  refund: 'REFUND',
  disclaimer: 'DISCLAIMER',
  cookie: 'COOKIE',
};

export default function LegalPage() {
  const params = useParams<{ type: string }>();
  const docType = TYPE_MAP[params.type?.toLowerCase()] ?? params.type?.toUpperCase();

  const { data, isLoading, error } = useApiQuery<LegalDocument>(
    docType ? `${PUBLIC}/legal/${docType}` : null,
  );

  return (
    <div className="min-h-dvh bg-ink-50">
      <header className="border-b border-ink-200 bg-surface">
        <div className="mx-auto flex h-14 max-w-3xl items-center px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold text-ink-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm text-primary-fg">
              CK
            </span>
            Tư vấn chứng khoán
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        {isLoading ? (
          <div className="py-20">
            <Spinner label="Đang tải văn bản…" />
          </div>
        ) : error || !data ? (
          <EmptyState
            title="Văn bản chưa được ban hành"
            description="Vui lòng liên hệ bộ phận hỗ trợ để được cung cấp nội dung."
          />
        ) : (
          <article className="space-y-4">
            <header>
              <h1 className="text-2xl font-semibold text-ink-900">{data.title}</h1>
              <p className="mt-1 text-sm text-ink-500">
                Phiên bản {data.version} · Hiệu lực từ {formatDate(data.effective_from)}
              </p>
            </header>

            <Card>
              {/* Nội dung soạn ở Admin Site dưới dạng markdown đơn giản; giữ nguyên xuống dòng. */}
              <div className="prose-article whitespace-pre-wrap">{data.content}</div>
            </Card>

            <p className="text-xs text-ink-500">
              Khi có phiên bản mới với thay đổi trọng yếu, bạn sẽ được thông báo trước tối thiểu 15
              ngày và được yêu cầu đồng ý lại trước khi tiếp tục sử dụng dịch vụ.
            </p>
          </article>
        )}
      </main>
    </div>
  );
}
