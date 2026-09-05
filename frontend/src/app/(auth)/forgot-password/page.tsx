'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Alert, Button, Card, Input } from '@/components/ui';
import { fieldError, useApiMutation, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import type { Message } from '@/types';

/**
 * Mục 2.3 — hai bước: gửi mã, rồi nhập mã + mật khẩu mới.
 *
 * Bước 1 **luôn** trả về cùng một thông báo dù email có tồn tại hay không.
 * Nếu báo "email không tồn tại", kẻ tấn công sẽ dò được danh sách khách hàng.
 */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const toast = useToast();

  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const requestOtp = useApiMutation<Message, { email: string }>((input) =>
    api.post<Message>(`${CUSTOMER}/auth/forgot-password`, input),
  );

  const resetPassword = useApiMutation<
    Message,
    { email: string; otp: string; new_password: string }
  >((input) => api.post<Message>(`${CUSTOMER}/auth/reset-password`, input));

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    const result = await requestOtp.mutate({ email: email.trim() });
    if (result) setStep('reset');
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);

    if (password !== confirm) {
      setLocalError('Mật khẩu nhập lại không khớp');
      return;
    }

    const result = await resetPassword.mutate({
      email: email.trim(),
      otp: otp.trim(),
      new_password: password,
    });
    if (result) {
      toast.success('Đổi mật khẩu thành công. Vui lòng đăng nhập lại.');
      router.push('/login');
    }
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-4">
      <div className="text-center">
        <h1 className="text-xl font-semibold text-ink-900">
          {step === 'request' ? 'Quên mật khẩu' : 'Đặt lại mật khẩu'}
        </h1>
        <p className="mt-1 text-sm text-ink-500">
          {step === 'request'
            ? 'Nhập email đã đăng ký để nhận mã xác thực'
            : 'Nhập mã 6 số đã gửi tới email của bạn'}
        </p>
      </div>

      <Card>
        {step === 'request' ? (
          <form onSubmit={handleRequest} className="space-y-4" noValidate>
            {requestOtp.error && <Alert tone="danger">{requestOtp.error.message}</Alert>}

            <Input
              label="Email"
              placeholder="ban@email.com"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <Button type="submit" fullWidth size="lg" loading={requestOtp.loading}>
              Gửi mã xác thực
            </Button>
          </form>
        ) : (
          <form onSubmit={handleReset} className="space-y-4" noValidate>
            <Alert tone="info">
              Nếu email tồn tại, mã xác thực đã được gửi. Mã có hiệu lực 10 phút và chỉ dùng được
              một lần.
            </Alert>

            {(resetPassword.error || localError) && (
              <Alert tone="danger">{localError ?? resetPassword.error?.message}</Alert>
            )}

            <Input
              label="Mã xác thực"
              placeholder="6 chữ số gửi tới email của bạn"
              // Mục 11.2 — bàn phím số cho OTP, tự động điền OTP nếu trình duyệt hỗ trợ.
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
              className="text-center text-2xl tracking-[0.5em]"
              error={fieldError(resetPassword.error, 'otp')}
            />

            <Input
              label="Mật khẩu mới"
              placeholder="Tối thiểu 8 ký tự, gồm chữ và số"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint="Tối thiểu 8 ký tự, gồm cả chữ và số."
              error={fieldError(resetPassword.error, 'new_password')}
            />

            <Input
              label="Nhập lại mật khẩu mới"
              placeholder="Gõ lại mật khẩu vừa tạo"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />

            <Alert tone="warning">
              Sau khi đổi mật khẩu, toàn bộ phiên đăng nhập trên mọi thiết bị sẽ bị đăng xuất.
            </Alert>

            <Button type="submit" fullWidth size="lg" loading={resetPassword.loading}>
              Đổi mật khẩu
            </Button>

            <Button
              type="button"
              variant="ghost"
              fullWidth
              onClick={() => setStep('request')}
              disabled={resetPassword.loading}
            >
              Gửi lại mã
            </Button>
          </form>
        )}
      </Card>

      <p className="text-center text-sm">
        <Link href="/login" className="text-ink-900 hover:underline">
          Quay lại đăng nhập
        </Link>
      </p>
    </div>
  );
}
