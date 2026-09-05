'use client';

/**
 * Phiên đăng nhập Admin Site — tách hoàn toàn khỏi `useSession` của khách hàng (BR-000).
 *
 * `can()` chỉ dùng để ẩn/hiện menu. BR-533: chặn thật nằm ở backend trên từng endpoint —
 * FE không được coi việc ẩn menu là phân quyền.
 */
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import useSWR from 'swr';

import { ADMIN, ApiError, api } from '@/lib/api';
import type { StaffProfile } from '@/types';

type StaffContextValue = {
  staff: StaffProfile | null;
  loading: boolean;
  isAuthenticated: boolean;
  can: (...permissions: string[]) => boolean;
  isSuperAdmin: boolean;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
};

const StaffContext = createContext<StaffContextValue>({
  staff: null,
  loading: true,
  isAuthenticated: false,
  can: () => false,
  isSuperAdmin: false,
  refresh: async () => undefined,
  logout: async () => undefined,
});

export function StaffSessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();

  const { data, error, isLoading, mutate } = useSWR<StaffProfile, ApiError>(
    `${ADMIN}/auth/me`,
    () => api.get<StaffProfile>(`${ADMIN}/auth/me`),
    { revalidateOnFocus: true, shouldRetryOnError: false, onError: () => undefined },
  );

  const logout = useCallback(async () => {
    try {
      await api.post(`${ADMIN}/auth/logout`);
    } finally {
      await mutate(undefined, { revalidate: false });
      router.push('/admin/login');
    }
  }, [mutate, router]);

  const value = useMemo<StaffContextValue>(() => {
    const staff = error ? null : (data ?? null);
    const permissions = new Set(staff?.permissions ?? []);
    return {
      staff,
      loading: isLoading,
      isAuthenticated: Boolean(staff),
      can: (...required: string[]) => required.some((p) => permissions.has(p)),
      isSuperAdmin: Boolean(staff?.roles.includes('SUPER_ADMIN')),
      refresh: mutate,
      logout,
    };
  }, [data, error, isLoading, mutate, logout]);

  return <StaffContext.Provider value={value}>{children}</StaffContext.Provider>;
}

export function useStaffSession() {
  return useContext(StaffContext);
}
