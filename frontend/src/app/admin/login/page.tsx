'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, Icon, Input, PasswordInput } from '@/components/ui';
import { useAction, useFormErrors, useStaffSession } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import * as v from '@/lib/validation';
import type { StaffProfile } from '@/types';

/**
 * Đăng nhập Admin Site — một bước: tên đăng nhập + mật khẩu.
 *
 * Bước nhập mã 6 số từ ứng dụng xác thực (2FA TOTP) đã được gỡ theo yêu cầu vận hành.
 *
 * Màn này cố ý **tối toàn trang**, khác hẳn trang đăng nhập khách hàng (nền sáng, chỉ tối một
 * nửa bên trái ở desktop). BR-000 tách hai site tới tận cookie và khoá ký JWT; phần giao diện
 * phải nói lên điều đó ngay từ cái nhìn đầu tiên, để không ai gõ mật khẩu quản trị vào ô đăng
 * nhập của khách hàng.
 */
/**
 * Ô nhập trên thẻ tối. Truyền qua `className` chứ không viết trong CSS toàn cục: `cn()` dùng
 * tailwind-merge nên các class này **thay thế** `bg-white`/`border-ink-300` mặc định của
 * `Input`, còn một quy tắc CSS cùng độ đặc hiệu thì thua utility của Tailwind vì thứ tự layer.
 */
const DARK_FIELD = 'border-ink-700 bg-ink-950 text-white placeholder:text-ink-500 hover:border-ink-600';

export default function AdminLoginPage() {
  const router = useRouter();
  const { refresh } = useStaffSession();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const { errors, validate, clear } = useFormErrors<'username' | 'password'>();

  // Lỗi từ máy chủ (sai thông tin đăng nhập, tài khoản ngừng hoạt động) hiện bằng toast.
  const login = useAction<{ staff: StaffProfile }, { username: string; password: string }>(
    (input) => api.post<{ staff: StaffProfile }>(`${ADMIN}/auth/login`, input),
  );

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();

    // Ô này nhận **cả** tên đăng nhập lẫn email, nên chỉ kiểm tra "đã điền" — áp luật định dạng
    // email vào đây sẽ từ chối nhầm những tên đăng nhập hợp lệ như `nguyenvana`.
    const ok = validate({
      username: v.check(username, v.required('tên đăng nhập hoặc email')),
      password: v.check(password, v.required('mật khẩu')),
    });
    if (!ok) return;

    const result = await login.run({ username: username.trim(), password });
    if (!result) return;

    await refresh();
    router.push('/admin');
  }

  return (
    <div className="flex min-h-dvh flex-col bg-ink-950 px-4 py-10">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center">
        <div className="mb-7 text-center">
          {/* Nền trắng trên nền ink-950. Bản trước dùng `bg-ink-900` — cùng tông với nền trang,
              nên chữ "QT" và cả khối logo biến mất hoàn toàn. */}
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-white text-sm font-semibold text-ink-950">
            QT
          </div>
          <h1 className="text-xl font-semibold text-white">Quản trị hệ thống</h1>
          <p className="mt-1.5 text-sm text-ink-400">Tư vấn chứng khoán</p>
        </div>

        {/* Thẻ cùng tông với nền trang thay vì một khối trắng: một mảng trắng giữa nền đen làm
            màn này trông y hệt trang khách hàng, đúng thứ BR-000 cần tránh. `form-on-dark`
            (xem `globals.css`) chỉnh màu nhãn và ô nhập cho nền tối. */}
        <div className="form-on-dark rounded-xl border border-ink-800 bg-ink-900 p-5 shadow-pop sm:p-6">
          <form onSubmit={handleLogin} className="space-y-4" noValidate>
            <Input
              label="Tên đăng nhập hoặc email"
              placeholder="Tên đăng nhập được cấp"
              required
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                clear('username');
              }}
              error={errors.username}
              className={DARK_FIELD}
            />
            <PasswordInput
              label="Mật khẩu"
              placeholder="Nhập mật khẩu của bạn"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                clear('password');
              }}
              error={errors.password}
              className={DARK_FIELD}
            />

            {/* Nút trắng trên thẻ tối — giữ nút chính là phần tương phản mạnh nhất màn hình. */}
            <Button
              type="submit"
              fullWidth
              size="sm"
              loading={login.loading}
              className="bg-white text-ink-950 hover:bg-ink-100 active:bg-ink-200 disabled:bg-ink-700"
            >
              Đăng nhập
            </Button>
          </form>
        </div>

        {/* BR-000 — nói thẳng rằng đây không phải cửa của khách hàng, kèm lối quay ra.
            Khách hàng lạc vào đây mà không có lối thoát sẽ gọi tổng đài. */}
        <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-ink-800 bg-ink-900/60 px-4 py-3 text-xs leading-relaxed text-ink-400">
          <Icon name="shield" size={15} className="mt-0.5 shrink-0 text-ink-500" />
          <p>
            Khu vực dành riêng cho nhân viên. Tài khoản khách hàng không đăng nhập được ở đây —
            hãy dùng{' '}
            <Link
              href="/login"
              className="font-medium text-ink-200 underline underline-offset-2 hover:text-white"
            >
              trang đăng nhập khách hàng
            </Link>
            .
          </p>
        </div>

        <p className="mt-4 text-center text-xs text-ink-500">
          Quên mật khẩu? Liên hệ Quản trị tối cao để được cấp lại.
        </p>
      </div>
    </div>
  );
}
