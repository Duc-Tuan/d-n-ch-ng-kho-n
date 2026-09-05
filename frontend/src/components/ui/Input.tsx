'use client';

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

import { cn } from '@/lib/cn';

type FieldShellProps = {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
};

/** Khung chung cho mọi trường nhập — nhãn, gợi ý, lỗi hiển thị thống nhất. */
export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
  className,
}: FieldShellProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-700">
          {label}
          {required && <span className="ml-0.5 text-tone-red-fg">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-sm text-tone-red-fg" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-500">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Ô nhập **không có dấu hiệu focus trực quan** — theo yêu cầu thiết kế: bỏ cả vòng sáng
 * (`ring`) lẫn việc đổi màu viền.
 *
 * Ghi lại để người sửa sau không tưởng là thiếu sót: đây là lựa chọn có chủ ý, và cái giá của
 * nó là người dùng bàn phím không nhìn thấy mình đang ở trường nào khi bấm Tab. Con trỏ nhấp
 * nháy là manh mối duy nhất còn lại. Muốn khôi phục thì thêm `focus:border-ink-900` vào nhánh
 * không lỗi bên dưới — chỉ một dòng.
 */
const CONTROL_BASE =
  'w-full rounded-lg border bg-surface px-3 text-ink-900 placeholder:text-ink-400 ' +
  'transition-colors focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:bg-ink-50 disabled:text-ink-500';

function controlClass(hasError?: boolean) {
  return cn(
    CONTROL_BASE,
    hasError ? 'border-tone-red-fg' : 'border-line-strong hover:border-ink-400',
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
  leftAddon?: ReactNode;
  rightAddon?: ReactNode;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, leftAddon, rightAddon, className, id, required, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={inputId}>
      <div className="relative">
        {leftAddon && (
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-ink-400">
            {leftAddon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          className={cn(
            controlClass(Boolean(error)),
            // Chiều cao 44px đáp ứng BR-822; text-base tránh iOS Safari tự zoom khi focus.
            'h-touch text-base sm:text-sm',
            leftAddon && 'pl-9',
            rightAddon && 'pr-10',
            className,
          )}
          {...props}
        />
        {rightAddon && (
          <span className="absolute inset-y-0 right-2 flex items-center">{rightAddon}</span>
        )}
      </div>
    </Field>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, id, required, rows = 4, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={inputId}>
      <textarea
        ref={ref}
        id={inputId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        className={cn(controlClass(Boolean(error)), 'py-2 text-base sm:text-sm', className)}
        {...props}
      />
    </Field>
  );
});

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: ReactNode;
  hint?: string;
  error?: string;
};

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, hint, error, className, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className="space-y-1">
      {/* Vùng chạm phủ cả nhãn để đạt 44px chiều cao hiệu dụng (BR-822). */}
      <label htmlFor={inputId} className="flex cursor-pointer items-start gap-2.5 py-1">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className={cn(
            'mt-0.5 h-5 w-5 shrink-0 rounded border-line-strong bg-surface text-primary',
            // Ô đánh dấu không có viền để làm đậm lên như ô nhập, nên vẫn giữ vòng sáng —
            // nhưng chỉ cho người dùng bàn phím, không hiện khi bấm chuột.
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-800/40',
            error && 'border-tone-red-fg',
            className,
          )}
          {...props}
        />
        <span className="text-sm leading-relaxed text-ink-700">{label}</span>
      </label>
      {error ? (
        <p className="pl-7 text-sm text-tone-red-fg" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="pl-7 text-xs text-ink-500">{hint}</p>
      ) : null}
    </div>
  );
});
