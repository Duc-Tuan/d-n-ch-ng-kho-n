'use client';

/** Thông báo nổi dùng chung — không component nào tự dựng toast riêng. */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { Icon, type IconName } from '@/components/ui/Icon';
import { cn } from '@/lib/cn';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

type Toast = { id: number; tone: ToastTone; message: string };

type ToastContextValue = {
  show: (message: string, tone?: ToastTone) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
};

const ToastContext = createContext<ToastContextValue>({
  show: () => undefined,
  success: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warning: () => undefined,
});

const TONE_CLASS: Record<ToastTone, string> = {
  success: 'bg-green-600',
  error: 'bg-red-600',
  // Không dùng được độ xám cố định: ở nền tối đó là một hộp sáng, mà chữ ở đây luôn trắng.
  info: 'bg-primary',
  warning: 'bg-amber-600',
};

const TONE_ICON: Record<ToastTone, IconName> = {
  success: 'check',
  error: 'close',
  info: 'info',
  warning: 'warning',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, message }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 4500);
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      success: (m: string) => show(m, 'success'),
      error: (m: string) => show(m, 'error'),
      info: (m: string) => show(m, 'info'),
      warning: (m: string) => show(m, 'warning'),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-bottom-nav z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:right-6 sm:left-auto sm:items-end"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg px-4 py-3 text-sm text-white shadow-lg animate-slide-up',
              TONE_CLASS[toast.tone],
            )}
          >
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20">
              <Icon name={TONE_ICON[toast.tone]} size={13} />
            </span>
            <span className="flex-1 leading-snug">{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
