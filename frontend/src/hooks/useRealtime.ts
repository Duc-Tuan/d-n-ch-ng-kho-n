'use client';

/**
 * Kênh real-time qua WebSocket — YC16, YC17.
 *
 * Tự kết nối lại khi rớt mạng, với khoảng chờ tăng dần để không dội bom máy chủ khi backend
 * đang khởi động lại.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type RealtimeEvent = {
  type: string;
  [key: string]: unknown;
};

const MAX_RETRY_DELAY = 30_000;

export function useRealtime(
  channel: 'customer' | 'admin',
  onEvent: (event: RealtimeEvent) => void,
  enabled = true,
) {
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUs = useRef(false);

  // Giữ callback mới nhất mà không mở lại kết nối mỗi lần component render.
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const connect = useCallback(() => {
    if (typeof window === 'undefined') return;

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/api/v1/ws/${channel}`);
    socketRef.current = socket;

    socket.onopen = () => {
      setConnected(true);
      retryRef.current = 0;
    };

    socket.onmessage = (message) => {
      try {
        onEventRef.current(JSON.parse(message.data) as RealtimeEvent);
      } catch {
        /* gói tin hỏng — bỏ qua, không để làm chết kênh */
      }
    };

    socket.onclose = () => {
      setConnected(false);
      if (closedByUs.current) return;

      // Chờ tăng dần: 1s, 2s, 4s… tối đa 30s.
      const delay = Math.min(1000 * 2 ** retryRef.current, MAX_RETRY_DELAY);
      retryRef.current += 1;
      timerRef.current = setTimeout(connect, delay);
    };

    socket.onerror = () => socket.close();
  }, [channel]);

  useEffect(() => {
    if (!enabled) return;

    closedByUs.current = false;
    connect();

    return () => {
      closedByUs.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [enabled, connect]);

  return { connected };
}

/**
 * Âm báo ngắn cho sự kiện cần chú ý — YC17.
 *
 * Dùng Web Audio API thay vì file mp3: không phải tải thêm tài nguyên, và trình duyệt chặn
 * autoplay file âm thanh nhưng cho phép phát âm sinh ra sau khi người dùng đã tương tác với trang.
 */
export function useNotificationSound() {
  const contextRef = useRef<AudioContext | null>(null);

  return useCallback((tone: 'info' | 'alert' = 'info') => {
    try {
      if (!contextRef.current) {
        const Ctor =
          window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        if (!Ctor) return;
        contextRef.current = new Ctor();
      }
      const ctx = contextRef.current;
      if (ctx.state === 'suspended') void ctx.resume();

      // Hai nốt ngắn — đủ để chú ý, không gây khó chịu khi lặp lại nhiều lần trong ca trực.
      const notes = tone === 'alert' ? [880, 660] : [660, 880];
      notes.forEach((frequency, index) => {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;

        const start = ctx.currentTime + index * 0.13;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.14, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);

        oscillator.connect(gain).connect(ctx.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.13);
      });
    } catch {
      /* trình duyệt chặn âm thanh — không phải lỗi nghiệp vụ, bỏ qua */
    }
  }, []);
}
