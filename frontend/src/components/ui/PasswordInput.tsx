'use client';

/**
 * Ô nhập mật khẩu kèm nút hiện/ẩn.
 *
 * Hệ thống có mười ba ô mật khẩu; trước đây đúng **một** ô có nút này, và nó được dựng tay ngay
 * trong trang đăng nhập. Nút hiện mật khẩu không phải chi tiết trang trí: mật khẩu bắt buộc có
 * cả chữ lẫn số (BR-2.1), gõ mù trên bàn phím điện thoại thì tỉ lệ sai cao, mà sai năm lần là
 * khoá tài khoản mười lăm phút (BR-110). Người dùng cần nhìn được thứ mình vừa gõ.
 */
import { forwardRef, useState, type InputHTMLAttributes } from 'react';

import { Icon } from './Icon';
import { Input } from './Input';

export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label?: string;
  hint?: string;
  error?: string;
  /** Đặt `false` cho ô mật khẩu hiện tại ở màn đổi mật khẩu, nơi người dùng chỉ xác nhận danh tính. */
  revealable?: boolean;
};

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ revealable = true, ...props }, ref) {
    const [visible, setVisible] = useState(false);

    return (
      <Input
        ref={ref}
        type={visible ? 'text' : 'password'}
        {...props}
        rightAddon={
          revealable ? (
            <button
              type="button"
              // `tabIndex={-1}`: Tab từ ô mật khẩu phải sang thẳng nút Đăng nhập. Chen một nút
              // phụ vào giữa khiến người dùng bàn phím nhấn Enter trên nút hiện mật khẩu thay vì
              // gửi biểu mẫu.
              tabIndex={-1}
              onClick={() => setVisible((v) => !v)}
              className="flex h-9 w-9 items-center justify-center rounded text-ink-400 transition-colors hover:text-ink-700"
              aria-label={visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
              title={visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
            >
              <Icon name={visible ? 'eye-off' : 'eye'} size={18} />
            </button>
          ) : undefined
        }
      />
    );
  },
);
