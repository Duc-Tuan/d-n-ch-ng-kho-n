'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Icon, Alert, Button, Card, Checkbox, Input, PasswordInput, Select } from '@/components/ui';
import { useAction, useFormErrors } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import * as v from '@/lib/validation';
import type { Message } from '@/types';

type Form = {
  email: string;
  password: string;
  confirm: string;
  full_name: string;
  phone: string;
  customer_type: string;
  referral_code: string;
  accept_tos: boolean;
  accept_privacy: boolean;
};

const EMPTY: Form = {
  email: '',
  password: '',
  confirm: '',
  full_name: '',
  phone: '',
  customer_type: 'IB_LINKED',
  referral_code: '',
  // BR-800 — checkbox KHÔNG được tick sẵn.
  accept_tos: false,
  accept_privacy: false,
};

/** Các ô có thể mang lỗi kiểm tra phía giao diện. */
type Field = 'full_name' | 'phone' | 'email' | 'password' | 'confirm';

export default function RegisterPage() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [sent, setSent] = useState(false);

  const { errors, validate, clear } = useFormErrors<Field>();

  // Lỗi từ máy chủ (email đã đăng ký, SĐT trùng, chạm giới hạn đăng ký theo IP) hiện bằng toast.
  const register = useAction<Message, Omit<Form, 'confirm'>>((input) =>
    api.post<Message>(`${CUSTOMER}/auth/register`, input),
  );

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /** Đổi giá trị một ô đồng thời xoá lỗi cũ của chính ô đó. */
  function edit(key: Field, value: string) {
    set(key, value);
    clear(key);
    // Sửa ô Mật khẩu làm lỗi "không khớp" ở ô nhập lại không còn đúng nữa.
    if (key === 'password') clear('confirm');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Chốt chặn duy nhất trước khi gọi API. Kiểm cả bảy trường một lượt thay vì dừng ở lỗi
    // đầu tiên: người dùng thấy hết những chỗ cần sửa trong một lần nhìn.
    const ok = validate({
      full_name: v.check(form.full_name, v.required('họ và tên')),
      phone: v.check(form.phone, v.vnPhone()),
      email: v.check(form.email, v.email()),
      password: v.check(form.password, v.password()),
      confirm: v.check(form.confirm, v.sameAs(form.password)),
    });
    if (!ok) return;

    const { confirm, ...payload } = form;
    const result = await register.run(payload);
    if (result) setSent(true);
  }

  if (sent) {
    return (
      <Card className="mx-auto w-full max-w-md space-y-4 text-center">
        <Icon name="mail" size={40} className="mx-auto text-ink-400" />
        <h1 className="text-lg font-semibold text-ink-900">Vui lòng kiểm tra email</h1>
        <p className="text-sm leading-relaxed text-ink-600">
          Chúng tôi đã gửi link xác thực tới <strong>{form.email}</strong>. Link có hiệu lực trong 24
          giờ.
        </p>
        {/* BR-100 — nêu rõ để KH không lo mất ngày dùng thử vì mở mail muộn. */}
        <Alert tone="info">
          Thời gian dùng thử 7 ngày chỉ bắt đầu tính <strong>sau khi bạn xác thực email</strong>,
          không phải từ lúc đăng ký.
        </Alert>
        <Link href="/login">
          <Button variant="outline" fullWidth>
            Về trang đăng nhập
          </Button>
        </Link>
      </Card>
    );
  }

  return (
    /*
      Rộng gấp đôi màn Đăng nhập và xếp **hai ô một hàng**.

      Phần cuộn — nếu cần — nằm **bên trong vùng nhập liệu**, không phải ở cả trang. Cho trang
      cuộn thì hai ô đánh dấu đồng ý điều khoản (BR-800) và nút Đăng ký trôi khỏi màn hình, mà
      đó đúng là hai thứ bắt buộc phải nhìn thấy: người dùng cần biết mình đang đồng ý cái gì
      ngay tại lúc bấm. Giữ chúng đứng yên ở đáy thẻ, chỉ các trường phía trên cuộn.
    */
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 lg:max-h-full lg:min-h-0">
      <div className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Đăng ký tài khoản</h1>
        <p className="mt-1.5 text-sm text-ink-500">Dùng thử đầy đủ chức năng trong 7 ngày.</p>
      </div>

      <Card className="flex min-h-0 flex-col overflow-hidden !p-0">
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col" noValidate>
          <div className="min-h-0 flex-1 space-y-4 p-4 sm:p-6">
          {/* Ghép cặp theo nghĩa, không ghép cho đủ đôi: danh tính → liên hệ → mật khẩu. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Họ và tên"
              placeholder="Nguyễn Văn An"
              required
              autoFocus
              autoComplete="name"
              value={form.full_name}
              onChange={(e) => edit('full_name', e.target.value)}
              error={errors.full_name}
            />
            <Input
              label="Số điện thoại"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              value={form.phone}
              onChange={(e) => edit('phone', e.target.value)}
              placeholder="0912345678"
              hint="Mỗi số chỉ dùng cho một tài khoản."
              error={errors.phone}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Email"
              placeholder="ban@email.com"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(e) => edit('email', e.target.value)}
              hint="Dùng để đăng nhập và đối chiếu tài khoản chứng khoán."
              error={errors.email}
            />
            <Input
              label="Mã giới thiệu"
              placeholder="Nhập nếu bạn được ai đó giới thiệu"
              value={form.referral_code}
              onChange={(e) => set('referral_code', e.target.value)}
              hint="Không bắt buộc."
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <PasswordInput
              label="Mật khẩu"
              placeholder="Nhập mật khẩu mới"
              autoComplete="new-password"
              required
              value={form.password}
              onChange={(e) => edit('password', e.target.value)}
              hint="Tối thiểu 8 ký tự, gồm cả chữ và số."
              error={errors.password}
            />
            <PasswordInput
              label="Nhập lại mật khẩu"
              placeholder="Gõ lại mật khẩu vừa tạo"
              autoComplete="new-password"
              required
              value={form.confirm}
              onChange={(e) => edit('confirm', e.target.value)}
              error={errors.confirm}
            />
          </div>

          {/* Chốt 7.1 — hai tuyến khách hàng, điều kiện duy trì khác nhau.
              Để nguyên một hàng: hai nhãn lựa chọn dài, ép nửa hàng sẽ bị cắt cụt. */}
          <Select
            label="Bạn thuộc nhóm nào?"
            required
            value={form.customer_type}
            onChange={(e) => set('customer_type', e.target.value)}
            options={[
              { value: 'IB_LINKED', label: 'Có/sẽ mở tài khoản chứng khoán dưới IB của chúng tôi' },
              { value: 'PAID_ONLY', label: 'Chỉ sử dụng dịch vụ theo thuê bao (không dưới IB)' },
            ]}
            hint={
              form.customer_type === 'IB_LINKED'
                ? 'Nhóm này cần duy trì NAV và giao dịch tối thiểu theo Điều khoản sử dụng.'
                : 'Nhóm này chỉ chịu ràng buộc về thời hạn gói, không áp điều kiện NAV/giao dịch.'
            }
          />
          </div>

          {/* Chân thẻ, **không cuộn**: điều khoản phải đọc được ngay tại lúc bấm đồng ý. */}
          <div className="shrink-0 space-y-4 p-4 sm:p-6">
            <div className="space-y-1">
            <Checkbox
              checked={form.accept_tos}
              onChange={(e) => set('accept_tos', e.target.checked)}
              label={
                <>
                  Tôi đã đọc và đồng ý với{' '}
                  <Link href="/legal/tos" target="_blank" className="text-ink-900 underline">
                    Điều khoản sử dụng
                  </Link>
                  , bao gồm điều kiện duy trì tài khoản và chính sách hoàn tiền.
                </>
              }
            />
            <Checkbox
              checked={form.accept_privacy}
              onChange={(e) => set('accept_privacy', e.target.checked)}
              label={
                <>
                  Tôi đồng ý với{' '}
                  <Link href="/legal/privacy" target="_blank" className="text-ink-900 underline">
                    Chính sách bảo mật
                  </Link>
                  .
                </>
              }
            />
            </div>

            <div className="flex flex-col-reverse items-center gap-3 sm:flex-row sm:justify-between">
              <p className="text-sm text-ink-600">
                Đã có tài khoản?{' '}
                <Link href="/login" className="font-medium text-ink-900 hover:underline">
                  Đăng nhập
                </Link>
              </p>
              <Button
                type="submit"
                size="lg"
                loading={register.loading}
                disabled={!form.accept_tos || !form.accept_privacy}
                className="w-full sm:w-auto sm:px-10"
              >
                Đăng ký
              </Button>
            </div>
          </div>
        </form>
      </Card>
    </div>
  );
}
