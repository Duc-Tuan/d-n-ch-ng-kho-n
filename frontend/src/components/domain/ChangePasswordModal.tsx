'use client';

import { useEffect, useState } from 'react';

import { Alert, Button, Input, Modal } from '@/components/ui';
import { fieldError, useApiMutation, useStaffSession, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import type { Message } from '@/types';

/** Mã sống 5 phút — trùng với `PASSWORD_CHANGE_TTL_MINUTES` ở máy chủ. */
const CODE_TTL_SECONDS = 5 * 60;

/**
 * Đổi mật khẩu tài khoản quản trị — hai bước, có xác nhận qua email.
 *
 * Vì sao không đổi thẳng: mật khẩu quản trị mở được toàn bộ dữ liệu khách hàng. Chỉ hỏi mật khẩu
 * cũ thì một lần nhìn trộm bàn phím là đủ để chiếm tài khoản. Bước mã qua email buộc kẻ tấn công
 * phải kiểm soát thêm hòm thư, và quan trọng không kém: **chủ tài khoản thật nhận được email**
 * nên biết ngay có người đang cố đổi mật khẩu của mình.
 *
 * Component đặt ở tầng dùng chung để mở được từ menu tài khoản trên header ở **bất kỳ màn nào**,
 * không phải điều hướng sang trang hồ sơ rồi mới mở được.
 */
export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { logout } = useStaffSession();

  const [step, setStep] = useState<'password' | 'code'>('password');
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);

  const request = useApiMutation<Message, { current_password: string; new_password: string }>(
    (body) => api.post<Message>(`${ADMIN}/auth/change-password/request`, body),
  );
  const confirm = useApiMutation<Message, { code: string }>((body) =>
    api.post<Message>(`${ADMIN}/auth/change-password/confirm`, body),
  );

  // Đếm ngược hiệu lực của mã. Hết giờ thì khoá nút xác nhận và mời lấy mã mới — để người dùng
  // biết trước, thay vì gõ mã rồi mới nhận thông báo hết hạn.
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setInterval(() => setSecondsLeft((n) => Math.max(n - 1, 0)), 1000);
    return () => clearInterval(timer);
  }, [secondsLeft]);

  const mismatch = form.confirm.length > 0 && form.next !== form.confirm;
  const canRequest = form.current.length > 0 && form.next.length >= 8 && !mismatch;
  const expired = step === 'code' && secondsLeft === 0;

  const sendCode = async () => {
    const result = await request.mutate({
      current_password: form.current,
      new_password: form.next,
    });
    if (result) {
      setSentTo(result.message);
      setSecondsLeft(CODE_TTL_SECONDS);
      setCode('');
      setStep('code');
    }
  };

  const mmss = `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(
    secondsLeft % 60,
  ).padStart(2, '0')}`;

  return (
    <Modal
      open
      onClose={onClose}
      title="Đổi mật khẩu"
      description={
        step === 'password'
          ? 'Bước 1/2 — xác nhận mật khẩu hiện tại và đặt mật khẩu mới.'
          : 'Bước 2/2 — nhập mã xác nhận đã gửi tới email của bạn.'
      }
      footer={
        step === 'password' ? (
          <>
            <Button variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button loading={request.loading} disabled={!canRequest} onClick={sendCode}>
              Gửi mã xác nhận
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setStep('password');
                setCode('');
              }}
            >
              Quay lại
            </Button>
            <Button
              variant="outline"
              loading={request.loading}
              onClick={() => void sendCode()}
            >
              Gửi lại mã
            </Button>
            <Button
              loading={confirm.loading}
              disabled={code.length !== 6 || expired}
              onClick={async () => {
                const result = await confirm.mutate({ code });
                if (result) {
                  toast.success(result.message);
                  // Máy chủ đã thu hồi mọi phiên và xoá cookie — dọn nốt phía trình duyệt rồi
                  // đưa về màn đăng nhập, thay vì để người dùng gặp lỗi 401 ở khắp nơi.
                  await logout();
                }
              }}
            >
              Xác nhận đổi mật khẩu
            </Button>
          </>
        )
      }
    >
      {step === 'password' ? (
        <div className="space-y-4">
          {request.error && <Alert tone="danger">{request.error.message}</Alert>}

          <Input
            label="Mật khẩu hiện tại"
            placeholder="Mật khẩu bạn đang dùng"
            type="password"
            required
            autoComplete="current-password"
            value={form.current}
            onChange={(e) => setForm({ ...form, current: e.target.value })}
            error={fieldError(request.error, 'current_password')}
          />
          <Input
            label="Mật khẩu mới"
            placeholder="Tối thiểu 8 ký tự, gồm chữ và số"
            type="password"
            required
            autoComplete="new-password"
            value={form.next}
            onChange={(e) => setForm({ ...form, next: e.target.value })}
            error={fieldError(request.error, 'new_password')}
            hint="Tối thiểu 8 ký tự, gồm chữ hoa, chữ thường, chữ số và ký tự đặc biệt."
          />
          <Input
            label="Nhập lại mật khẩu mới"
            placeholder="Gõ lại mật khẩu mới"
            type="password"
            required
            autoComplete="new-password"
            value={form.confirm}
            onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            error={mismatch ? 'Hai lần nhập chưa khớp' : undefined}
          />

          <Alert tone="info">
            Sau khi bấm tiếp, hệ thống gửi một mã 6 số về email của bạn. Mật khẩu{' '}
            <strong>chưa đổi</strong> cho tới khi bạn nhập đúng mã đó.
          </Alert>
        </div>
      ) : (
        <div className="space-y-4">
          {sentTo && <Alert tone="success">{sentTo}</Alert>}
          {confirm.error && <Alert tone="danger">{confirm.error.message}</Alert>}

          <Input
            label="Mã xác nhận"
            placeholder="6 chữ số gửi tới email của bạn"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            error={fieldError(confirm.error, 'code')}
            className="text-center text-2xl tracking-[0.5em]"
          />

          {expired ? (
            <Alert tone="warning">
              Mã đã hết hạn. Bấm <strong>Gửi lại mã</strong> để nhận mã mới.
            </Alert>
          ) : (
            <p className="text-center text-sm text-ink-500">
              Mã còn hiệu lực <strong className="tabular-nums text-ink-900">{mmss}</strong>
            </p>
          )}

          <Alert tone="warning">
            Đổi mật khẩu thành công sẽ <strong>kết thúc mọi phiên đăng nhập</strong>, kể cả phiên
            bạn đang dùng. Bạn sẽ cần đăng nhập lại bằng mật khẩu mới.
          </Alert>
        </div>
      )}
    </Modal>
  );
}
