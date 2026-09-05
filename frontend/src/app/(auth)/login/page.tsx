'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { Alert, Button, Card, Input, PasswordInput } from '@/components/ui';
import { useAction, useFormErrors, useSession, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import * as v from '@/lib/validation';
import type { SessionResponse } from '@/types';

/** Điều hướng theo `access.action.type` — BR-112 yêu cầu nêu đúng hành động tiếp theo. */
const BLOCKED_ROUTE: Record<string, string> = {
  CHOOSE_PACKAGE: '/pricing',
  RENEW: '/pricing',
  VERIFY_EMAIL: '/verify-email',
  RESTORE_COMPLIANCE: '/account/blocked',
  CONTACT_SUPPORT: '/account/blocked',
};

/** Nhãn nút của khối bị chặn — nói rõ việc phải làm, không dùng một chữ chung chung. */
const BLOCKED_ACTION_LABEL: Record<string, string> = {
  CHOOSE_PACKAGE: 'Chọn gói',
  RENEW: 'Gia hạn ngay',
  VERIFY_EMAIL: 'Xác thực email',
  RESTORE_COMPLIANCE: 'Xem hướng dẫn',
  CONTACT_SUPPORT: 'Liên hệ hỗ trợ',
};

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { refresh } = useSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [blocked, setBlocked] = useState<SessionResponse['access'] | null>(null);

  const { errors, validate, clear } = useFormErrors<'email' | 'password'>();

  // Lỗi từ máy chủ (sai mật khẩu, tài khoản bị khoá) hiện bằng toast — mặc định của `useAction`.
  const login = useAction<SessionResponse, { email: string; password: string }>((input) =>
    api.post<SessionResponse>(`${CUSTOMER}/auth/login`, input),
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Chốt chặn: thiếu hoặc sai định dạng thì báo ngay dưới ô, **không** gọi API.
    // Gửi đi một biểu mẫu chưa điền xong chỉ tốn một vòng mạng để nhận lại đúng câu trả lời
    // mà trình duyệt đã biết từ trước.
    const ok = validate({
      email: v.check(email, v.email()),
      password: v.check(password, v.required('mật khẩu')),
    });
    if (!ok) return;

    setBlocked(null);

    const result = await login.run({ email: email.trim(), password });
    if (!result) return;

    // Backend trả 200 kể cả khi bị BR-001 chặn, để FE hiển thị đúng lý do và lối đi tiếp.
    if (!result.access.allowed) {
      setBlocked(result.access);
      return;
    }

    await refresh();
    toast.success(`Chào mừng ${result.user.full_name}`);
    router.push(params.get('next') || '/');
  }

  const blockedType = blocked?.action?.type as string | undefined;
  const blockedRoute = blockedType ? BLOCKED_ROUTE[blockedType] : undefined;

  return (
    <div className="mx-auto w-full max-w-md space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Đăng nhập</h1>
        <p className="mt-1.5 text-sm text-ink-500">
          Dùng email bạn đã đăng ký để tiếp tục.
        </p>
      </div>

      <Card className="sm:p-6">
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {blocked && (
            <Alert
              tone={blocked.reason.startsWith('COMPLIANCE') ? 'danger' : 'warning'}
              title="Chưa vào được hệ thống"
              action={
                blockedRoute ? (
                  <Link href={blockedRoute}>
                    <Button size="sm">
                      {BLOCKED_ACTION_LABEL[blockedType!] ?? 'Xử lý ngay'}
                    </Button>
                  </Link>
                ) : undefined
              }
            >
              {blocked.message}
            </Alert>
          )}

          <Input
            label="Email"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              clear('email');
            }}
            error={errors.email}
            placeholder="ban@email.com"
          />

          <div className="space-y-1.5">
            <PasswordInput
              label="Mật khẩu"
              placeholder="Nhập mật khẩu của bạn"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                clear('password');
              }}
              error={errors.password}
            />
            {/* Đặt ngay dưới ô mật khẩu: người bấm link này vừa gõ sai mật khẩu xong, họ tìm nó
                ở đây chứ không tìm ở cuối biểu mẫu. */}
            <div className="flex justify-end">
              <Link
                href="/forgot-password"
                className="text-sm text-ink-600 underline-offset-2 hover:text-ink-900 hover:underline"
              >
                Quên mật khẩu?
              </Link>
            </div>
          </div>

          <Button type="submit" fullWidth size="lg" loading={login.loading}>
            Đăng nhập
          </Button>
        </form>
      </Card>

      <p className="text-center text-sm text-ink-600">
        Chưa có tài khoản?{' '}
        <Link href="/register" className="font-medium text-ink-900 hover:underline">
          Đăng ký dùng thử 7 ngày
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
