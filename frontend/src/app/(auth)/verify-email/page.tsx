'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { Icon, Alert, Button, Card, Input, Spinner } from '@/components/ui';
import { useApiMutation, useSession, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import type { Message, SessionResponse } from '@/types';

function VerifyEmailContent() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { refresh } = useSession();

  const token = params.get('token');
  const [status, setStatus] = useState<'idle' | 'verifying' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [email, setEmail] = useState('');
  const attempted = useRef(false);

  const verify = useApiMutation<SessionResponse, { token: string }>((input) =>
    api.post<SessionResponse>(`${CUSTOMER}/auth/verify-email`, input),
  );

  const resend = useApiMutation<Message, { email: string }>((input) =>
    api.post<Message>(`${CUSTOMER}/auth/resend-verification`, input),
  );

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    (async () => {
      setStatus('verifying');
      const result = await verify.mutate({ token });
      if (result) {
        setStatus('success');
        await refresh();
        // BR-100 — xác thực xong là đồng hồ 7 ngày bắt đầu chạy, đưa KH vào ngay.
        setTimeout(() => router.push('/'), 1600);
      } else {
        setStatus('error');
        setErrorMessage(verify.error?.message ?? 'Link xác thực không hợp lệ hoặc đã hết hạn');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (status === 'verifying') {
    return (
      <Card className="mx-auto w-full max-w-md py-10">
        <Spinner label="Đang xác thực email…" />
      </Card>
    );
  }

  if (status === 'success') {
    return (
      <Card className="mx-auto w-full max-w-md space-y-3 text-center">
        <Icon name="check" size={40} className="mx-auto text-tone-green-fg" />
        <h1 className="text-lg font-semibold text-ink-900">Xác thực thành công</h1>
        <p className="text-sm text-ink-600">
          Tài khoản đã kích hoạt. Bạn có 7 ngày dùng thử đầy đủ chức năng bắt đầu từ bây giờ.
        </p>
        <Spinner label="Đang chuyển vào hệ thống…" />
      </Card>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-4">
      <div className="text-center">
        <h1 className="text-xl font-semibold text-ink-900">Xác thực email</h1>
        <p className="mt-1 text-sm text-ink-500">
          {token ? 'Link xác thực không dùng được' : 'Nhập email để nhận lại link xác thực'}
        </p>
      </div>

      <Card>
        <div className="space-y-4">
          {status === 'error' && <Alert tone="danger">{errorMessage}</Alert>}
          {resend.error && <Alert tone="danger">{resend.error.message}</Alert>}

          <p className="text-sm text-ink-600">
            Nhập email đã đăng ký, chúng tôi sẽ gửi lại link xác thực mới. Giới hạn 3 lần mỗi ngày.
          </p>

          <Input
            label="Email"
            placeholder="ban@email.com"
            type="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <Button
            fullWidth
            size="lg"
            loading={resend.loading}
            onClick={async () => {
              const result = await resend.mutate({ email: email.trim() });
              if (result) toast.success(result.message);
            }}
          >
            Gửi lại link xác thực
          </Button>
        </div>
      </Card>

      <p className="text-center text-sm">
        <Link href="/login" className="text-ink-900 hover:underline">
          Quay lại đăng nhập
        </Link>
      </p>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<Spinner label="Đang tải…" />}>
      <VerifyEmailContent />
    </Suspense>
  );
}
