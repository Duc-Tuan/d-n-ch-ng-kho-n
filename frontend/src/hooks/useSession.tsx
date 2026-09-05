'use client';

/**
 * Phiên đăng nhập khách hàng.
 *
 * BR-001 — mọi trang đều cần biết `access.allowed` và `access.banner`.
 * Đặt ở context để không phải gọi `/auth/me` lặp lại ở từng màn.
 */
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import useSWR from 'swr';

import { ApiError, CUSTOMER, api } from '@/lib/api';
import type { SessionResponse } from '@/types';

type SessionContextValue = {
  session: SessionResponse | null;
  loading: boolean;
  /** Đã đăng nhập (kể cả khi bị BR-001 chặn). */
  isAuthenticated: boolean;
  /** Đăng nhập VÀ được phép dùng dịch vụ. */
  canUseService: boolean;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue>({
  session: null,
  loading: true,
  isAuthenticated: false,
  canUseService: false,
  refresh: async () => undefined,
  logout: async () => undefined,
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();

  const { data, error, isLoading, mutate } = useSWR<SessionResponse, ApiError>(
    `${CUSTOMER}/auth/me`,
    () => api.get<SessionResponse>(`${CUSTOMER}/auth/me`),
    {
      revalidateOnFocus: true,
      // 401 là trạng thái bình thường của khách chưa đăng nhập, không phải lỗi cần thử lại.
      shouldRetryOnError: false,
      onError: () => undefined,
    },
  );

  const logout = useCallback(async () => {
    try {
      await api.post(`${CUSTOMER}/auth/logout`);
    } finally {
      await mutate(undefined, { revalidate: false });
      router.push('/login');
    }
  }, [mutate, router]);

  const value = useMemo<SessionContextValue>(() => {
    const session = error ? null : (data ?? null);
    return {
      session,
      loading: isLoading,
      isAuthenticated: Boolean(session),
      canUseService: Boolean(session?.access.allowed),
      refresh: mutate,
      logout,
    };
  }, [data, error, isLoading, mutate, logout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}

/** Tiện ích: banner GRACE / WARNING / PENDING_LINK hiển thị trên mọi trang. */
export function useAccessBanner() {
  const { session } = useSession();
  return session?.access.banner ?? null;
}
