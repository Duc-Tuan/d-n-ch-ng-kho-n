'use client';

/**
 * Giá thời gian thực cho bảng giá — BR-831.
 *
 * Khác `useRealtime` ở chỗ kênh này **hai chiều**: trình duyệt nói cho máy chủ biết nó đang xem
 * mã nào, và chỉ nhận về đúng những mã đó, chỉ khi giá thực sự đổi. Một bảng giá 60 dòng nhận
 * vài trăm byte mỗi nhịp thay vì cả bảng 143 KB.
 *
 * Kênh chết thì hook **không** báo lỗi ra giao diện: `refreshInterval` của SWR vẫn là đường lùi
 * và bảng giá vẫn cập nhật, chỉ chậm hơn. Một lỗi đỏ giữa màn hình cho một tính năng phụ đang
 * hỏng là đổi một bất tiện nhỏ lấy một cú hoảng lớn.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Một bậc dư mua hoặc dư bán. */
export type QuoteLevel = { price: number; volume: number };

/** Ảnh chụp giá của một mã — khớp `Quote.as_dict()` bên máy chủ. */
export type Quote = {
  symbol: string;
  price: number | null;
  reference: number | null;
  ceiling: number | null;
  floor: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  avg_price: number | null;
  change: number | null;
  change_pct: number | null;
  volume: number;
  value: number | null;
  last_volume: number;
  bids: QuoteLevel[];
  asks: QuoteLevel[];
  foreign_buy: number;
  foreign_sell: number;
  foreign_room: number | null;
  as_of: string;
};

const MAX_RETRY_DELAY = 30_000;

/**
 * Nhịp gửi ping.
 *
 * Không phải để phát hiện kết nối chết — trình duyệt tự làm việc đó. Đây là để **giữ kết nối
 * qua nginx**: `proxy_read_timeout 300s` đóng mọi kết nối im lặng quá 5 phút, mà phiên nghỉ
 * trưa dài 90 phút và không có giá nào đổi trong khoảng đó. Máy chủ trả `pong` nên có lưu lượng
 * cả hai chiều.
 */
const PING_INTERVAL = 30_000;

export function useMarketRealtime(symbols: string[], enabled = true) {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [connected, setConnected] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const closedByUs = useRef(false);

  // Danh sách mã giữ trong ref chứ không trong dependency của `connect`: bảng giá đổi mã mỗi lần
  // người dùng gõ vào ô tìm kiếm, và mở lại WebSocket sau mỗi phím gõ là vừa chậm vừa khiến máy
  // chủ thấy hàng chục kết nối cho một người.
  const symbolsRef = useRef<string[]>(symbols);
  const key = symbols.join(',');

  const connect = useCallback(() => {
    if (typeof window === 'undefined') return;

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/api/v1/ws/market`);
    socketRef.current = socket;

    socket.onopen = () => {
      setConnected(true);
      retryRef.current = 0;
      socket.send(JSON.stringify({ op: 'subscribe', symbols: symbolsRef.current }));

      pingRef.current = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 'ping' }));
      }, PING_INTERVAL);
    };

    socket.onmessage = (message) => {
      try {
        const data = JSON.parse(message.data) as { type: string; quotes?: Quote[] };
        if (data.type !== 'quotes' || !data.quotes?.length) return;
        setQuotes((current) => {
          const next = { ...current };
          for (const quote of data.quotes!) next[quote.symbol] = quote;
          return next;
        });
      } catch {
        /* gói tin hỏng — bỏ qua, không để làm chết kênh */
      }
    };

    socket.onclose = () => {
      setConnected(false);
      if (pingRef.current) clearInterval(pingRef.current);
      if (closedByUs.current) return;

      const delay = Math.min(1000 * 2 ** retryRef.current, MAX_RETRY_DELAY);
      retryRef.current += 1;
      timerRef.current = setTimeout(connect, delay);
    };

    socket.onerror = () => socket.close();
  }, []);

  useEffect(() => {
    if (!enabled) return;

    closedByUs.current = false;
    connect();

    return () => {
      closedByUs.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (pingRef.current) clearInterval(pingRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [enabled, connect]);

  // Đổi danh sách mã thì gửi lại lệnh đăng ký trên **kết nối đang mở**, không mở kết nối mới.
  useEffect(() => {
    symbolsRef.current = symbols;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op: 'subscribe', symbols }));
    }
    // `key` là chuỗi nối các mã: mảng mới mỗi lần render nhưng cùng nội dung thì không gửi lại.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { quotes, connected };
}

/**
 * Nhớ hướng đổi giá của từng mã trong một nhịp ngắn, để nháy nền.
 *
 * Tách khỏi hook trên vì nó là chuyện hiển thị thuần tuý, và vì nó cần một đồng hồ riêng cho
 * mỗi mã: sáu mươi dòng cùng nháy theo một đồng hồ chung sẽ chớp thành từng đợt như đèn nhấp
 * nháy — thứ người dùng tắt đi chứ không phải thứ họ đọc.
 */
export function useFlash(quotes: Record<string, Quote>, durationMs = 700) {
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({});
  const previous = useRef<Record<string, number | null>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const changes: Record<string, 'up' | 'down'> = {};

    for (const [symbol, quote] of Object.entries(quotes)) {
      const before = previous.current[symbol];
      const now = quote.price;
      if (before != null && now != null && now !== before) {
        changes[symbol] = now > before ? 'up' : 'down';
      }
      previous.current[symbol] = now;
    }

    if (!Object.keys(changes).length) return;

    setFlash((current) => ({ ...current, ...changes }));
    for (const symbol of Object.keys(changes)) {
      clearTimeout(timers.current[symbol]);
      timers.current[symbol] = setTimeout(() => {
        setFlash((current) => {
          const next = { ...current };
          delete next[symbol];
          return next;
        });
      }, durationMs);
    }
  }, [quotes, durationMs]);

  // Dọn mọi đồng hồ còn treo khi rời trang.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      Object.values(pending).forEach(clearTimeout);
    };
  }, []);

  return flash;
}
