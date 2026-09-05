'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Alert, Button, Card, Spinner } from '@/components/ui';
import { useApiMutation, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';

/**
 * Nhận chiến lược qua link chia sẻ.
 *
 * Nằm trong vùng đã đăng nhập nên khách chưa đăng nhập sẽ được đưa về trang đăng nhập kèm
 * `next`, rồi quay lại đúng đây sau khi đăng nhập xong.
 */
export default function AcceptSharedStrategyPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const toast = useToast();

  const [status, setStatus] = useState<'accepting' | 'done' | 'error'>('accepting');
  const [message, setMessage] = useState('');
  const attempted = useRef(false);

  const accept = useApiMutation<{ id: number; message: string }, string>((token) =>
    api.post(`${CUSTOMER}/my-strategies/accept/${token}`),
  );

  useEffect(() => {
    if (!params.token || attempted.current) return;
    attempted.current = true;

    (async () => {
      const result = await accept.mutate(params.token);
      if (result) {
        setStatus('done');
        setMessage(result.message);
        toast.success(result.message);
        setTimeout(() => router.replace(`/strategies/mine/${result.id}`), 1400);
      } else {
        setStatus('error');
        setMessage(accept.error?.message ?? 'Link chia sẻ không hợp lệ hoặc đã bị thu hồi');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.token]);

  return (
    <div className="mx-auto max-w-md py-10">
      <Card className="space-y-4 text-center">
        {status === 'accepting' && <Spinner label="Đang thêm chiến lược vào danh sách của bạn…" />}

        {status === 'done' && (
          <>
            <p className="text-lg font-semibold text-ink-900">Đã thêm chiến lược</p>
            <p className="text-sm text-ink-600">{message}</p>
            <Spinner label="Đang mở chiến lược…" />
          </>
        )}

        {status === 'error' && (
          <>
            <Alert tone="danger" title="Không nhận được chiến lược">
              {message}
            </Alert>
            <Button variant="outline" fullWidth onClick={() => router.push('/strategies')}>
              Về danh sách chiến lược
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
