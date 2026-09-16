'use client';

/**
 * Biểu đồ nến cho bảng giá.
 *
 * Dùng chung `lightweight-charts` với `StrategyChart` để hai màn có cùng cảm giác thao tác
 * (phóng to, kéo, tooltip) thay vì mỗi nơi một thư viện.
 *
 * YC9 — cuộn về quá khứ thì **tự tải thêm nến cũ**. Không có phần này, người dùng kéo tới mép
 * trái là hết dữ liệu và tưởng hệ thống chỉ có bấy nhiêu lịch sử.
 *
 * Chỉ báo kỹ thuật dùng chung danh mục ở `@/lib/indicators`. Chúng chia làm hai chỗ vẽ, và sự
 * khác nhau đó quyết định toàn bộ cấu trúc bên dưới:
 *
 * * **Vẽ đè lên nến** (MA, Bollinger, Ichimoku, SuperTrend, bộ SMC…) — thêm đường vào chính
 *   biểu đồ giá, còn hộp/đường/nhãn thì vẽ tay lên `ShapesLayer`.
 * * **Cửa sổ riêng** (RSI, MACD, ADX…) — mỗi cái là một biểu đồ độc lập xếp bên dưới, vì thang
 *   giá của chúng không liên quan gì tới giá cổ phiếu. `useChartSync` ghép chúng lại thành một
 *   khối: cùng khoảng nhìn, cùng đường ngắm, cùng bề rộng cột giá.
 */
import {
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

import { SymbolCombobox } from '@/components/domain/SymbolCombobox';
import { Button, Icon, IconButton, Spinner } from '@/components/ui';
import { useIsMobile, useLocalStorage, useMediaQuery, useResolvedTheme } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Candle as IndicatorCandle } from '@/lib/indicators/math';
import { getIndicator, instanceLabel } from '@/lib/indicators/registry';
import type {
  IndicatorDef,
  IndicatorInstance,
  IndicatorShapes,
  PlotDef,
} from '@/lib/indicators/types';
import { toIndicatorCandles } from '@/lib/indicators/snapshot';
import type { AssetClass, Candle, OhlcvResponse } from '@/types';

import { removeChart } from './chart/chartLifecycle';
import {
  LINE_STYLE_MAP,
  TIME_SCALE_RIGHT_OFFSET,
  baseChartOptions,
  down,
  up,
} from './chart/chartTheme';
import { DrawingCanvas } from './chart/DrawingCanvas';
import { DrawingStyleBar } from './chart/DrawingStyleBar';
import { DrawingToolbar } from './chart/DrawingToolbar';
import { IndicatorPane, PaneButton } from './chart/IndicatorPane';
import { IndicatorSettingsModal } from './chart/IndicatorSettingsModal';
import { IndicatorsModal } from './chart/IndicatorsModal';
import { ShapesLayer } from './chart/ShapesLayer';
import { mergeCandles, prependOlder } from './chart/candles';
import { DEFAULT_TIMEFRAME, TimeframeBar, useTimeframes } from './chart/TimeframeBar';
import { useChartSync } from './chart/useChartSync';
import { useDrawings } from './chart/useDrawings';
import { useElementSize } from './chart/useElementSize';
import type { IndicatorStore } from './chart/useIndicators';

/**
 * Khoảng thời gian nhìn được, tính bằng **ngày lịch** chứ không bằng số nến.
 *
 * Trước đây mỗi khoảng là một con số nến cố định (3 tháng = 63 nến), đúng cho nến ngày và sai
 * cho mọi khung khác: 63 nến 1 phút là bốn tiếng, không phải ba tháng. Số nến giờ được suy ra
 * từ khoảng thời gian và độ dài nến, nên "3 tháng" luôn là ba tháng thật ở mọi khung.
 */
const RANGES = [
  // Tháng viết tắt `MN`, không phải `M`: `M` đứng cạnh hàng khung thời gian sẽ đọc thành khung
  // tháng, mà ngay trong hàng đó `1m` đã là một phút rồi. `MN` là cách viết tắt cho tháng mà
  // chính bảng quy đổi tên khung của máy chủ đang dùng, nên hai bên gọi cùng một tên.
  { key: '1mo', label: '1MN', days: 30 },
  { key: '3m', label: '3MN', days: 90 },
  { key: '6m', label: '6MN', days: 180 },
  { key: '1y', label: '1 năm', days: 365 },
  { key: 'all', label: 'Tất cả', days: 0 },
];

/** Số phiên giao dịch một năm — 365 ngày lịch trừ cuối tuần và nghỉ lễ. */
const SESSIONS_PER_YEAR = 252;

/** Độ dài một phiên: 09:00–11:30 và 13:00–14:45, tính bằng giây. */
const SESSION_SECONDS = 4.75 * 3600;

/** Một khoảng chỉ hiện khi nó đủ nến để đọc được hình, và không quá nhiều để vẽ nổi.
 *
 *  Trần đặt rộng tay (một tháng nến 1 phút là ~6.000 cây) vì hàng này chỉ còn năm nút: siết
 *  chặt thì ở khung 1 phút không nút nào lọt và người dùng còn mỗi *Tất cả*, tức là mất luôn
 *  đường thu hẹp tầm nhìn. Vẽ sáu nghìn nến vẫn nằm trong tầm của thư viện biểu đồ. */
const RANGE_MIN_BARS = 8;
const RANGE_MAX_BARS = 8000;

function barsForRange(days: number, tfSeconds: number): number {
  if (!days) return 0;
  const sessions = Math.max(1, Math.round((days * SESSIONS_PER_YEAR) / 365));
  // Khung từ một ngày trở lên đếm theo phiên; khung trong ngày đếm theo giờ giao dịch thật —
  // chia cho 24 tiếng sẽ cho ra số nến gấp năm lần số nến thị trường thực sự sinh ra.
  const seconds = tfSeconds >= 86400 ? sessions * 86400 : sessions * SESSION_SECONDS;
  return Math.max(1, Math.round(seconds / tfSeconds));
}

/** Số nến còn lại bên trái trước khi bắt đầu tải thêm — tải sớm để không thấy khoảng trắng. */
const LOAD_MORE_THRESHOLD = 20;
const LOAD_MORE_SIZE = 300;

/** Số nến nạp khi đổi sang một khung khác. Rộng hơn `LOAD_MORE_SIZE` để có sẵn phần cuộn. */
const INITIAL_SIZE = 500;

/** Chiều cao một cửa sổ chỉ báo. Đủ để đọc RSI, không lấn quá nhiều phần nến. */
const PANE_HEIGHT = 120;

/* ── Bề rộng hai cột lúc phóng to kín màn hình ────────────────────────────
     Trước đây cột phân tích cố định `lg:w-[26rem] xl:w-[30rem]`, tức mọi người cùng một tỉ lệ.
     Nhưng "bung hết cỡ để soi kỹ" có hai kiểu ngược nhau: người đọc nến muốn dồn hết bề ngang
     cho biểu đồ, người đối chiếu nhận định muốn bảng phân tích đủ rộng để không phải cuộn. Một
     con số chọn sẵn luôn sai với một trong hai bên, nên nó thành thứ kéo được — và nhớ lại ở
     lần mở sau, vì tỉ lệ này là thói quen đọc chứ không phải lựa chọn của một lần xem. */

const SIDE_WIDTH_KEY = 'market.chart.side-width';

/** Đúng bằng `26rem` cũ, để lần mở đầu tiên không khác gì bản trước. */
const SIDE_WIDTH_DEFAULT = 416;

/** Hẹp hơn mức này thì bảng phân tích gãy dòng liên tục, còn biểu đồ thì hết là biểu đồ. */
const SIDE_WIDTH_MIN = 288;
const CHART_WIDTH_MIN = 360;

/** Bước nhảy khi chỉnh bằng bàn phím — xem `SplitHandle`. */
const SIDE_WIDTH_STEP = 24;

/**
 * Giữ bề rộng cột phân tích trong khoảng dùng được với bề ngang đang có.
 *
 * Cần cả lúc kéo lẫn lúc cửa sổ đổi kích thước: một bề rộng chốt từ màn 27 inch mà mở lại trên
 * laptop 13 inch sẽ chiếm gần hết khung nhìn, và phần còn lại cho biểu đồ hẹp hơn cả cột bảng
 * giá mà người dùng vừa thoát khỏi.
 */
function clampSideWidth(next: number, containerWidth: number): number {
  const max = Math.max(SIDE_WIDTH_MIN, containerWidth - CHART_WIDTH_MIN);
  return Math.round(Math.min(Math.max(next, SIDE_WIDTH_MIN), max));
}

export function PriceChart({
  symbol,
  candles: initialCandles,
  tzOffsetSeconds = 0,
  indicators,
  height = 420,
  attribution,
  sidePanel,
  loading = false,
  assetClass,
  onExpandedChange,
  onSymbolChange,
}: {
  /** Truyền `symbol` để bật tải thêm lịch sử khi cuộn. Bỏ trống thì chỉ hiển thị tĩnh. */
  symbol?: string;
  candles: Candle[];
  /**
   * Chênh lệch múi giờ thị trường so với UTC (giây), lấy từ chính phản hồi đã sinh ra
   * `candles`. Xem `toIndicatorCandles` — thư viện biểu đồ vẽ nhãn thời gian theo UTC.
   */
  tzOffsetSeconds?: number;
  /**
   * Bộ chỉ báo, do màn cha giữ (`useIndicators`).
   *
   * Không tự giữ bên trong biểu đồ: nút AI phân tích ở màn bảng giá cần đúng bộ chỉ báo này để
   * gửi đi, mà nó nằm ngoài biểu đồ. Trạng thái nằm ở chỗ cả hai cùng với tới được.
   */
  indicators: IndicatorStore;
  height?: number;
  attribution?: string;
  /**
   * Nội dung cho cột bên phải khi biểu đồ **phóng to kín màn hình** (bảng phân tích, thẻ chỉ số…).
   *
   * Lúc thu nhỏ thì không dùng tới: những khối này đã nằm sẵn dưới biểu đồ trong trang, dựng thêm
   * một bản thứ hai chỉ tạo ra hai chỗ hiển thị cùng một thứ. Lớp phủ toàn màn hình mới là lúc
   * chúng bị che mất, và cũng là lúc màn hình đủ rộng để đặt chúng sang bên.
   */
  sidePanel?: ReactNode;
  /**
   * Báo cho màn cha biết biểu đồ vừa bung ra hay vừa thu lại.
   *
   * Cần thiết vì phần nội dung ở `sidePanel` **chuyển chỗ** chứ không nhân đôi: màn cha phải gỡ
   * bản nằm trong trang đi, nếu không sẽ có hai bảng phân tích cùng sống và cái bị lớp phủ che
   * chỉ tốn lượt gọi máy chủ.
   */
  onExpandedChange?: (expanded: boolean) => void;
  /**
   * Màn cha đang nạp chuỗi nến cho mã vừa chọn.
   *
   * Phải là **một lớp phủ bên trong biểu đồ**, không phải một khối chờ dựng thay cho biểu đồ ở
   * màn cha: gỡ biểu đồ ra khỏi cây là mất luôn mọi trạng thái nó đang giữ — trong đó có cờ
   * phóng to kín màn hình. Người dùng bung hết cỡ rồi đổi mã sẽ bị hất về lại cột hẹp, và đó
   * chính là lỗi cần chữa ở đây.
   */
  loading?: boolean;
  /** Loại tài sản của mã đang xem — để ô chọn mã lúc phóng to mở đúng tab. */
  assetClass?: AssetClass;
  /**
   * Đổi mã ngay trên biểu đồ. Chỉ dùng khi phóng to kín màn hình — lúc đó lớp phủ che mất bảng
   * giá, và bảng giá là chỗ duy nhất đổi mã được; không có nút này thì muốn xem mã khác phải
   * thoát ra, bấm, rồi phóng to lại.
   *
   * Tham số thứ hai là loại tài sản của mã mới, để màn cha đổi tab bảng giá theo.
   */
  onSymbolChange?: (symbol: string, assetClass?: AssetClass) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  /** `instanceId__plotKey` → đường của chỉ báo vẽ đè, để cập nhật và gỡ đúng cái. */
  const overlaySeriesRef = useRef<Map<string, ISeriesApi<SeriesType>>>(new Map());
  /** Hàng "biểu đồ + cột phân tích" lúc phóng to — mốc quy toạ độ chuột ra bề rộng khi kéo. */
  const splitRef = useRef<HTMLDivElement>(null);

  const isMobile = useIsMobile();
  // Biểu đồ vẽ lên canvas nên phải tự biết bảng màu đang là gì — xem effect đổi màu bên dưới.
  const theme = useResolvedTheme();
  const size = useElementSize(hostRef);
  // Đúng breakpoint `lg` của hàng bên dưới: hẹp hơn thì hai khối xếp dọc, và kéo ngang không còn
  // nghĩa gì.
  const wide = useMediaQuery('(min-width: 1024px)');

  const [range, setRange] = useState('1y');
  const [expanded, setExpanded] = useState(false);

  /**
   * Bề rộng cột phân tích, và bề rộng *đang* kéo dở.
   *
   * Hai biến chứ không một: `sideWidth` ghi xuống localStorage mỗi lần đổi, mà một nhịp kéo chuột
   * sinh ra vài chục lần đổi — ghi từng nhịp là vài chục lượt ghi đĩa cho một thao tác. `dragWidth`
   * giữ phần kéo dở trong bộ nhớ, thả tay mới chốt lại.
   */
  const [sideWidth, setSideWidth] = useLocalStorage(SIDE_WIDTH_KEY, SIDE_WIDTH_DEFAULT);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  /**
   * Chuỗi nến, kèm **dấu chủ sở hữu**: mã và khung mà nó thuộc về.
   *
   * Dấu này phải nằm trong cùng một ô trạng thái với chuỗi nến, không phải trong một `ref` bên
   * cạnh. Lý do là một lượt render duy nhất, lượt ngay sau cú bấm đổi mã: `symbol` đã là mã mới
   * (đến từ prop) trong khi `candles` vẫn là chuỗi của mã cũ (state chưa kịp cập nhật). Ở đúng
   * lượt ấy, bất cứ ai so `seriesKey` với thực tế đều bị lừa — xem chỗ vẽ ở dưới.
   */
  const [loaded, setLoaded] = useState<{ key: string; candles: Candle[] }>(() => ({
    key: `${symbol ?? ''}@${DEFAULT_TIMEFRAME}`,
    candles: initialCandles,
  }));
  const candles = loaded.candles;
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  /* ── Khung thời gian ────────────────────────────────────────────────────
       Khung nằm ở đây chứ không ở màn cha vì biểu đồ đã tự gọi máy chủ sẵn (cuộn tải thêm
       lịch sử), và vì mọi thứ đổi theo khung — vùng nhìn, hình vẽ tay, nhãn trục thời gian —
       đều thuộc về biểu đồ. Màn cha vẫn nạp sẵn nến ngày để lần vẽ đầu không phải chờ thêm
       một lượt gọi nữa. */
  const timeframes = useTimeframes();
  const [timeframe, setTimeframe] = useState(DEFAULT_TIMEFRAME);
  const [switching, setSwitching] = useState(false);
  const [tzOffset, setTzOffset] = useState(tzOffsetSeconds);

  const activeTimeframe = useMemo(
    () => timeframes.find((tf) => tf.code === timeframe),
    [timeframes, timeframe],
  );
  const tfSeconds = activeTimeframe?.seconds ?? 86400;
  const intraday = activeTimeframe?.intraday ?? false;

  /** Tăng mỗi lần biểu đồ được dựng lại. Series mới luôn **rỗng**, nên mọi effect nạp dữ liệu
   *  vào nó phải chạy lại — không có mốc này thì biểu đồ trắng cho tới lần đổi dữ liệu kế tiếp. */
  const [epoch, setEpoch] = useState(0);

  const sync = useChartSync();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);

  /** Hình vẽ tay: đường xu hướng, Fibonacci, vùng giá… Lưu trong máy người dùng.
   *
   *  Gắn theo **mã và khung**, không chỉ theo mã: một đường xu hướng nối hai đáy cách nhau sáu
   *  tháng trên biểu đồ ngày, khi hiện lại trên biểu đồ 1 phút, sẽ nằm ngoài toàn bộ vùng nhìn
   *  — người dùng chỉ thấy hình vẽ của mình biến mất mà không hiểu vì sao. */
  // Khoá kho hình là **mã trần**, không kèm khung thời gian: điểm neo là (thời gian, giá) nên
  // một đường hỗ trợ vẽ ở khung Ngày vẫn nằm đúng chỗ khi xem khung 1 giờ.
  const drawings = useDrawings(symbol);

  // Dùng ref trong callback của biểu đồ để không phải gắn lại sự kiện mỗi lần dữ liệu đổi.
  const stateRef = useRef({ candles, loadingMore, exhausted, symbol, timeframe, switching });
  stateRef.current = { candles, loadingMore, exhausted, symbol, timeframe, switching };

  /**
   * Chuỗi nến đang giữ thuộc về mã nào, khung nào.
   *
   * Đây là thứ phân biệt "đổi sang chuỗi khác, phải nạp lại từ đầu" với "vẫn chuỗi cũ, chỉ là
   * dữ liệu vừa được làm mới". Không có nó thì mọi lượt làm mới đều bị hiểu thành lượt đầu tiên,
   * và phần lịch sử đã cuộn về bị vứt đi mỗi lần.
   */
  const loadedKeyRef = useRef<string | null>(null);
  const seriesKey = `${symbol ?? ''}@${timeframe}`;

  /* ── Khung mặc định: dùng thẳng dữ liệu màn cha đã nạp ──────────────────
       Gọi lại lần nữa cho cùng một chuỗi chỉ làm biểu đồ chớp một cái lúc mở trang.

       Nhưng **chỉ lần đầu mới được gán đè**. Màn cha làm mới nến ngày theo chu kỳ của nó và mỗi
       lần chỉ đưa về vài trăm phiên gần nhất; gán thẳng chuỗi đó vào là xoá sạch phần quá khứ
       người dùng vừa kéo chuột để tải. Những lần sau chỉ gộp: cập nhật nến đã có, nối nến mới. */
  useEffect(() => {
    if (timeframe !== DEFAULT_TIMEFRAME) return;
    setTzOffset(tzOffsetSeconds);

    if (loadedKeyRef.current !== seriesKey) {
      loadedKeyRef.current = seriesKey;
      setLoaded({ key: seriesKey, candles: initialCandles });
      setExhausted(false);
      setSwitching(false);
      return;
    }
    setLoaded((current) => ({
      key: seriesKey,
      // Gộp chỉ có nghĩa khi chuỗi trên tay đúng là của chuỗi này; khác thì lấy nguyên chuỗi mới.
      candles:
        current.key === seriesKey ? mergeCandles(current.candles, initialCandles) : initialCandles,
    }));
  }, [timeframe, seriesKey, initialCandles, tzOffsetSeconds]);

  /* ── Các khung còn lại: biểu đồ tự gọi máy chủ ──────────────────────────
       Cố ý **không** phụ thuộc `initialCandles`. Chuỗi đó là nến ngày của màn cha, không liên
       quan gì tới khung 1 giờ đang xem; để nó trong danh sách phụ thuộc thì mỗi lượt màn cha
       làm mới nến ngày lại kéo theo một lượt nạp lại khung 1 giờ từ đầu — và cuốn sạch phần
       lịch sử đã cuộn về. Đó chính là lý do cuộn về quá khứ ở khung nhỏ trông như không tải. */
  useEffect(() => {
    if (timeframe === DEFAULT_TIMEFRAME || !symbol) return;
    if (loadedKeyRef.current === seriesKey) return;

    // Cờ huỷ cho phản hồi tới muộn: bấm nhanh 1m → 5m → 15m mà không có nó thì chuỗi của khung
    // bấm trước có thể về sau và ghi đè lên khung đang chọn, để lại một biểu đồ nói dối.
    let cancelled = false;
    setSwitching(true);

    api
      .get<OhlcvResponse>(`${CUSTOMER}/market/ohlcv`, {
        symbol,
        resolution: timeframe,
        limit: INITIAL_SIZE,
      })
      .then((response) => {
        if (cancelled) return;
        loadedKeyRef.current = seriesKey;
        setLoaded({ key: seriesKey, candles: response.candles ?? [] });
        setTzOffset(response.tz_offset_seconds ?? 0);
        setExhausted(false);
      })
      .catch(() => {
        if (cancelled) return;
        loadedKeyRef.current = seriesKey;
        // Khung chưa có dữ liệu (mã mới, hoặc khung 1 phút của mã ít thanh khoản) không phải
        // lỗi cần báo đỏ — biểu đồ trống kèm dòng chữ ở dưới đã nói đủ.
        setLoaded({ key: seriesKey, candles: [] });
        setExhausted(true);
      })
      .finally(() => {
        if (!cancelled) setSwitching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, seriesKey]);

  // Đổi mã thì quay về khung mặc định: giữ nguyên khung 1 phút khi nhảy sang mã khác nghe hợp
  // lý, nhưng mã mới thường chưa có nến 1 phút nào và người dùng nhận một biểu đồ trống.
  useEffect(() => {
    setTimeframe(DEFAULT_TIMEFRAME);
  }, [symbol]);

  // Cuộn tới đâu là chuyện của từng chuỗi. Không xoá cờ này khi đổi mã hay đổi khung thì chuỗi
  // mới thừa hưởng "đã hết lịch sử" của chuỗi cũ và không bao giờ tải thêm được nữa.
  useEffect(() => {
    setExhausted(false);
  }, [seriesKey]);

  /* ── Mở rộng kín khung nhìn ──────────────────────────────────────────────
       Lớp phủ `fixed inset-0` **trong trang**, không gọi `requestFullscreen`: biểu đồ chiếm
       trọn cả bề ngang lẫn bề dọc khung nhìn — thoát khỏi cột phải chật của bảng giá — nhưng
       trình duyệt vẫn là trình duyệt, thanh tab và thanh địa chỉ còn nguyên. */

  // Esc để thu nhỏ — nhưng nhường cho modal đang mở (Esc của nó phải đóng modal trước) và cho
  // công cụ vẽ: đang cầm công cụ hay đang chọn một hình thì Esc là "bỏ thao tác đó", thoát luôn
  // cả màn hình lớn sẽ hất người dùng ra ngoài giữa chừng.
  const drawingBusy = drawings.activeTool !== 'cursor' || drawings.selectedId !== null;
  useEffect(() => {
    if (!expanded) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pickerOpen && !settingsId && !drawingBusy) setExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded, pickerOpen, settingsId, drawingBusy]);

  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  /**
   * Hai cột nằm cạnh nhau — điều kiện duy nhất mà thanh kéo có nghĩa.
   *
   * Thiếu `sidePanel` thì lớp phủ chỉ có biểu đồ (không có gì để chia), và dưới `lg` thì hàng xếp
   * dọc nên thứ chia nhau là chiều cao chứ không phải bề ngang.
   */
  const split = expanded && Boolean(sidePanel) && wide;
  const sideWidthPx = dragWidth ?? sideWidth;

  // Thoát phóng to giữa lúc đang kéo (Esc, hoặc cửa sổ hẹp lại dưới `lg`) thì bỏ bề rộng kéo dở:
  // giữ lại thì lần bung ra sau mở bằng một con số chưa bao giờ được chốt, khác với thứ đã lưu.
  useEffect(() => {
    if (!split) setDragWidth(null);
  }, [split]);

  // Bề rộng đã chốt có thể quá rộng với khung nhìn hiện tại — xem `clampSideWidth`.
  useEffect(() => {
    if (!split) return;

    const fit = () => {
      const host = splitRef.current;
      if (!host) return;
      // `setSideWidth` của `useLocalStorage` chỉ nhận giá trị, không nhận hàm cập nhật — nên so
      // trước rồi mới ghi, để một lần đổi kích thước cửa sổ không sinh ra một lượt ghi đĩa thừa.
      const next = clampSideWidth(sideWidth, host.clientWidth);
      if (next !== sideWidth) setSideWidth(next);
    };

    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [split, sideWidth, setSideWidth]);

  // Khoá cuộn nền: lớp phủ che kín rồi, để trang phía sau cuộn được chỉ gây trôi vị trí khi thoát.
  useEffect(() => {
    if (!expanded) return;

    const { body } = document;
    const previous = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previous;
    };
  }, [expanded]);

  /** YC9 — tải thêm nến cũ hơn nến sớm nhất đang có. */
  const loadOlder = useCallback(async () => {
    const state = stateRef.current;
    if (!state.symbol || state.loadingMore || state.exhausted || !state.candles.length) return;
    // Đang đổi khung thì chuỗi trên tay còn là của khung cũ. Nối thêm lúc này là ghép nến hai
    // khung khác nhau vào một mảng, và nó chỉ lộ ra ở chỗ vài cây nến sai chiều giữa biểu đồ.
    if (state.switching) return;

    /**
     * Chuỗi mà lượt gọi này thuộc về.
     *
     * Giữa lúc chờ phản hồi, người dùng có thể đã bấm sang mã khác. Nối phần lịch sử ấy vào là
     * **dán nguyên chuỗi của mã cũ lên biểu đồ của mã mới** — `prependOlder` trả về chuỗi cũ
     * kèm phần nối thêm, nên cả bốn trăm cây nến của AAA, kể cả cây đang chạy mang giá thời gian
     * thực của nó, hiện ra dưới cái tên MSN. Cờ `switching` ở trên chỉ chặn đổi **khung**, và
     * chặn ở lúc bắt đầu chứ không phải lúc phản hồi về.
     */
    const requestedKey = `${state.symbol}@${state.timeframe}`;
    const stale = () => `${stateRef.current.symbol}@${stateRef.current.timeframe}` !== requestedKey;

    setLoadingMore(true);
    try {
      const earliest = state.candles[0];

      // Hỏi theo **mốc mở nến**, không theo ngày. Một phiên có 285 nến 1 phút; lùi theo ngày
      // thì mỗi lần cuộn nhảy qua trọn cả phiên và người dùng không bao giờ xem được đoạn giữa.
      // Máy chủ hiểu `before` là loại trừ, nên không cần tự lùi thêm một bước ở đây.
      const response = await api.get<OhlcvResponse>(`${CUSTOMER}/market/ohlcv`, {
        symbol: state.symbol,
        resolution: state.timeframe,
        before: earliest.time ?? `${earliest.trade_date}T00:00:00Z`,
        limit: LOAD_MORE_SIZE,
      });
      if (stale()) return;

      const older = response.candles ?? [];
      const merged = prependOlder(state.candles, older);
      if (!merged) {
        // Không có nến nào mới so với chuỗi đang giữ: hết lịch sử ở khung này.
        setExhausted(true);
        return;
      }
      setLoaded((current) =>
        current.key === requestedKey ? { key: requestedKey, candles: merged } : current,
      );
    } catch {
      // Hết dữ liệu hoặc lỗi mạng — dừng tải thêm, không báo lỗi ồn ào giữa thao tác cuộn.
      // Vẫn phải hỏi lại `stale`: đóng dấu "hết lịch sử" lên chuỗi của mã mới thì mã ấy không
      // bao giờ cuộn về quá khứ được nữa, cho tới khi rời trang.
      if (!stale()) setExhausted(true);
    } finally {
      // Cờ bận thì gỡ vô điều kiện — để sót lại một lần là chặn mọi lượt tải thêm sau đó.
      setLoadingMore(false);
    }
  }, []);

  /**
   * Áp khoảng đang chọn lên **vùng nhìn** của biểu đồ.
   *
   * Trước đây khoảng này cắt bớt mảng nến trước khi vẽ, kèm điều kiện "chỉ cắt khi số nến đã
   * tải không quá gấp đôi khoảng chọn". Màn bảng giá nạp sẵn 400 phiên, nên 3 tháng (63 phiên)
   * và 6 tháng (126 phiên) không bao giờ thoả điều kiện đó — bấm vào không có gì xảy ra. Nới
   * rộng khoảng cũng hỏng nốt: số nến vẽ tăng lên bị nhầm là "vừa nạp thêm lịch sử" nên vùng
   * nhìn được giữ nguyên thay vì mở ra.
   *
   * Giữ nguyên toàn bộ nến trong chuỗi và chỉ đổi vùng nhìn là cách các biểu đồ giá vẫn làm:
   * kéo ngược về quá khứ vẫn thấy phần ngoài khoảng, và nút khoảng luôn có tác dụng.
   */
  const applyRange = useCallback(
    (count: number) => {
      const chart = chartRef.current;
      if (!chart || !count) return;

      const days = RANGES.find((r) => r.key === range)?.days ?? 0;
      const span = barsForRange(days, tfSeconds);
      if (!span || span >= count) {
        chart.timeScale().fitContent();
        return;
      }
      chart.timeScale().setVisibleLogicalRange({ from: count - span, to: count - 1 });
    },
    [range, tfSeconds],
  );

  /** Nến ở dạng chỉ báo cần: thời gian là giây unix, mọi giá trị đã ép số.
   *
   *  Cộng luôn lệch múi giờ: thư viện in nhãn theo UTC, không cộng thì nến 09:15 hiện 02:15.
   *  Phép cộng không đụng tới thứ tự hay giá trị nến nên chỉ báo tính ra con số y hệt. */
  const series = useMemo<IndicatorCandle[]>(
    () => toIndicatorCandles(candles, tzOffset),
    [candles, tzOffset],
  );

  /**
   * Cách người dùng kéo và phóng biểu đồ. Tách thành một hằng vì lớp công cụ vẽ **tắt rồi bật
   * lại** phần này mỗi lần vẽ; bật lại bằng `true` sẽ mở luôn cả kéo dọc bằng ngón tay — thứ
   * BR-846 đã tắt trên điện thoại.
   */
  const interaction = useMemo(
    () => ({
      // Liệt kê **đủ** các cờ chứ không chỉ cái muốn đổi: lớp vẽ tắt cả nhóm bằng
      // `handleScroll: false`, và khi bật lại thư viện chỉ trộn đúng những khoá được nêu — thiếu
      // `mouseWheel` hay `pressedMouseMove` ở đây là sau nét vẽ đầu tiên biểu đồ hết kéo được.
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        // BR-846 — trên điện thoại không cho kéo dọc, tránh tranh chấp với cuộn trang.
        vertTouchDrag: !isMobile,
      },
      handleScale: {
        axisPressedMouseMove: true,
        axisDoubleClickReset: true,
        mouseWheel: true,
        pinch: true,
      },
    }),
    [isMobile],
  );

  /** Chỉ giữ những khoảng đủ nến để đọc được ở khung hiện tại: "1 ngày" trên biểu đồ tuần là
   *  chưa tới một cây nến, còn "1 năm" trên biểu đồ 1 phút là gần trăm nghìn nến. */
  const visibleRanges = useMemo(
    () =>
      RANGES.filter((item) => {
        if (!item.days) return true;
        const bars = barsForRange(item.days, tfSeconds);
        return bars >= RANGE_MIN_BARS && bars <= RANGE_MAX_BARS;
      }),
    [tfSeconds],
  );

  // Đổi khung có thể làm khoảng đang chọn biến mất khỏi hàng nút. Không kéo nó về một khoảng
  // còn hợp lệ thì không nút nào sáng, và bấm lại đúng nút cũ cũng không có gì xảy ra.
  useEffect(() => {
    if (visibleRanges.some((item) => item.key === range)) return;
    const widest = visibleRanges.filter((item) => item.days).at(-1);
    setRange(widest?.key ?? 'all');
  }, [visibleRanges, range]);

  /**
   * Số chữ số thập phân của nhãn giá trên hình vẽ. Bảng giá in giá nguyên (mã giá vài chục nghìn
   * đồng), nhưng chứng chỉ quỹ và mã giá thấp cần phần lẻ mới phân biệt được các mức Fibonacci.
   */
  const digits = useMemo(() => {
    const last = series.at(-1)?.close ?? 0;
    return last >= 1000 ? 0 : last >= 100 ? 1 : 2;
  }, [series]);

  const { bars, volumes } = useMemo(() => {
    const bars: CandlestickData<Time>[] = [];
    const volumes: HistogramData<Time>[] = [];

    for (const c of series) {
      const time = c.time as Time;
      bars.push({ time, open: c.open, high: c.high, low: c.low, close: c.close });
      volumes.push({
        time,
        value: c.volume,
        // Khối lượng tô theo chiều giá phiên đó — nhìn là biết phiên tăng hay giảm.
        color: c.close >= c.open ? up(0.33) : down(0.33),
      });
    }
    return { bars, volumes };
  }, [series]);

  /* ── Chỉ báo đang bật ──────────────────────────────────────────────────── */

  const activeOverlays = useMemo(
    () =>
      indicators.overlays
        .filter((instance) => instance.visible)
        .map((instance) => ({ instance, def: getIndicator(instance.defId) }))
        .filter((entry): entry is { instance: IndicatorInstance; def: IndicatorDef } =>
          Boolean(entry.def),
        ),
    [indicators.overlays],
  );

  const overlayData = useMemo(
    () =>
      activeOverlays.map(({ instance, def }) => ({
        instance,
        def,
        result: def.compute(series, instance.params),
      })),
    [activeOverlays, series],
  );

  /** Hộp, đường và nhãn của bộ SMC / ZigZag / UT Bot — gộp từ mọi chỉ báo đang bật. */
  const shapes = useMemo<IndicatorShapes>(() => {
    const boxes: NonNullable<IndicatorShapes['boxes']> = [];
    const lines: NonNullable<IndicatorShapes['lines']> = [];
    const markers: NonNullable<IndicatorShapes['markers']> = [];
    const labels: NonNullable<IndicatorShapes['labels']> = [];
    const tables: NonNullable<IndicatorShapes['tables']> = [];
    const gauges: NonNullable<IndicatorShapes['gauges']> = [];

    for (const { instance, def } of activeOverlays) {
      const out = def.computeShapes?.(series, instance.params);
      if (!out) continue;
      if (out.boxes) boxes.push(...out.boxes);
      if (out.lines) lines.push(...out.lines);
      if (out.markers) markers.push(...out.markers);
      if (out.labels) labels.push(...out.labels);
      if (out.tables) tables.push(...out.tables);
      if (out.gauges) gauges.push(...out.gauges);
    }

    // `setMarkers` đòi thứ tự thời gian tăng dần, nếu không nó bỏ qua phần lệch.
    markers.sort((a, b) => a.time - b.time);
    return { boxes, lines, markers, labels, tables, gauges };
  }, [activeOverlays, series]);

  /** Trục thời gian luôn nằm ở biểu đồ **cuối cùng còn hiện** — vẽ ở mọi cái là lặp ba lần. */
  const lastVisiblePane = indicators.panes.filter((item) => item.visible).at(-1)?.instanceId;

  /* ── Dựng biểu đồ giá ──────────────────────────────────────────────────── */

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      ...baseChartOptions(),
      height,
      ...interaction,
    });

    const price = chart.addCandlestickSeries({
      upColor: up(),
      downColor: down(),
      borderVisible: false,
      wickUpColor: up(),
      wickDownColor: down(),
    });

    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chartRef.current = chart;
    priceRef.current = price;
    volumeRef.current = volume;
    sync.register(chart);
    sync.registerSeries(chart, price);
    setEpoch((value) => value + 1);

    // YC9 — cuộn tới gần mép trái thì nạp thêm lịch sử.
    const onRangeChange = (logicalRange: LogicalRange | null) => {
      if (logicalRange && logicalRange.from < LOAD_MORE_THRESHOLD) void loadOlder();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      sync.unregister(chart);
      // Đánh dấu rồi mới gỡ: `ShapesLayer` và `DrawingCanvas` cầm chính handle này qua prop đọc
      // từ ref, và effect của chúng còn chạy một lượt nữa sau khi effect này đã dọn xong.
      removeChart(chart);
      chartRef.current = null;
      priceRef.current = null;
      volumeRef.current = null;
      overlaySeriesRef.current.clear();
    };
    // `interaction` cố ý **không** nằm trong danh sách phụ thuộc — nó được áp lại bằng
    // `applyOptions` ở effect ngay dưới. Để nó ở đây thì mỗi lần cờ `isMobile` lật là dựng lại
    // toàn bộ biểu đồ; xem lý do đầy đủ ở effect đó.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, loadOlder, sync]);

  /**
   * Áp cách kéo/phóng lên biểu đồ đang có, **không** dựng lại nó.
   *
   * `useIsMobile` luôn trả `false` ở lần render đầu rồi mới lật sau khi mount — nó phải hỏi
   * `window.matchMedia`, thứ không tồn tại lúc render trên máy chủ. Nên trên điện thoại, và chỉ
   * trên điện thoại, `interaction` chắc chắn đổi một lần ngay sau khi trang hiện ra.
   *
   * Khi `interaction` còn nằm trong deps của effect dựng biểu đồ, cú lật đó gỡ và dựng lại toàn
   * bộ biểu đồ: người dùng thấy nến chớp một cái, vùng nhìn về mặc định, và các lớp phủ nhận
   * một handle đã chết ngay trong cùng lượt commit (`chartLifecycle`). Đổi vài cờ cuộn thì
   * `applyOptions` làm được — không có lý do gì phải dựng lại cả biểu đồ.
   */
  useEffect(() => {
    chartRef.current?.applyOptions(interaction);
  }, [interaction, epoch]);

  // Bề rộng theo khung chứa chứ không theo cửa sổ trình duyệt: khung còn co giãn khi mở/đóng
  // một cửa sổ chỉ báo hay khi cột bảng giá bên trái đổi kích thước.
  useEffect(() => {
    if (size.width) chartRef.current?.applyOptions({ width: size.width });
  }, [size.width]);

  // Chiều cao cũng lấy từ khung chứa, không chỉ từ prop `height`: lúc toàn màn hình khung được
  // kéo giãn bằng CSS (`flex-1`) nên prop không đổi, mà biểu đồ thì phải cao lên theo.
  useEffect(() => {
    if (size.height) chartRef.current?.applyOptions({ height: size.height });
  }, [size.height]);

  useEffect(() => {
    chartRef.current?.applyOptions({ timeScale: { visible: !lastVisiblePane } });
  }, [lastVisiblePane]);

  /**
   * Đổi bảng màu khi người dùng bấm nút sáng/tối.
   *
   * `lightweight-charts` vẽ lên canvas, nên nó **không** đi theo biến CSS như phần giao diện
   * còn lại: màu được đọc một lần lúc dựng biểu đồ rồi nằm luôn trong cấu hình của thư viện.
   * Không có effect này thì đổi sang nền sáng sẽ để lại một ô biểu đồ đen giữa trang trắng,
   * và người dùng phải F5.
   *
   * `applyOptions` chứ không dựng lại: dựng lại làm mất vùng nhìn, mất chuỗi nến đã nạp thêm,
   * và giật một cái ngay giữa hiệu ứng chuyển nền. `theme` trong deps chính là thứ kéo effect
   * chạy lại — `baseChartOptions()` tự đọc giá trị mới từ `:root` khi được gọi.
   */
  useEffect(() => {
    chartRef.current?.applyOptions(baseChartOptions());
    priceRef.current?.applyOptions({
      upColor: up(),
      downColor: down(),
      wickUpColor: up(),
      wickDownColor: down(),
    });
  }, [theme, epoch]);

  // Khung trong ngày phải hiện giờ trên trục, không thì cả một phiên nến chỉ có một nhãn ngày
  // lặp lại và không đọc được nến nào ở phút nào. Riêng khung 1 phút bật thêm giây: thư viện
  // gộp nhãn theo bước phút và bỏ mất mốc mở phiên nếu không có nó.
  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: { timeVisible: intraday, secondsVisible: false },
    });
  }, [intraday, epoch]);

  // Khi nạp thêm lịch sử, giữ nguyên vùng người dùng đang nhìn thay vì nhảy về đầu.
  const previousCount = useRef(0);

  /** Dấu của chuỗi đã vẽ — xem nhánh `tailOnly` ngay dưới. */
  const appliedRef = useRef<{ epoch: number; key: string; first?: Time; last?: Time }>({
    epoch: -1,
    key: '',
  });

  useEffect(() => {
    if (!priceRef.current) return;

    /* Chuỗi trên tay chưa phải chuỗi của mã đang chọn thì **không vẽ gì cả**.

       Đây là lượt render ngay sau cú bấm đổi mã: prop `symbol` đã đổi, `candles` thì chưa. Vẽ ở
       lượt này là vẽ nến của mã cũ rồi đóng dấu `appliedRef` bằng khoá của mã **mới** — và cái
       dấu sai đó mới là chỗ chết người: lượt sau, khi nến thật của mã mới về, `tailOnly` thấy
       cùng khoá, cùng số nến, cùng mốc đầu và mốc cuối (hai mã cùng khung ngày thì ba thứ ấy
       giống hệt nhau) nên kết luận "chỉ có nhịp giá mới" và chỉ `update` mỗi cây cuối. Kết quả
       là toàn bộ thân biểu đồ vẫn là mã cũ, đúng một cây nến cuối mang giá mã mới.

       Bỏ qua lượt này thì `appliedRef` giữ nguyên khoá cũ, và lượt sau `sameSeries` bằng `false`
       như nó phải thế — vẽ lại trọn chuỗi, đặt lại trục giá, đặt lại vùng nhìn. */
    if (loaded.key !== seriesKey) return;

    /* Nhịp giá đang chạy chỉ sửa **cây nến cuối**: vẫn mã ấy, khung ấy, số nến ấy, mốc đầu và
       mốc cuối ấy. Đi tiếp xuống `setData` thì nhánh `!grew` gọi `applyRange` và vùng nhìn bị
       kéo về khoảng mặc định — hai giây một lần, đúng lúc người dùng đang phóng to một đoạn quá
       khứ để soi. `update` chỉ chạm cây cuối và không đụng tới vùng nhìn. */
    const applied = appliedRef.current;
    const tailOnly =
      bars.length > 0 &&
      bars.length === previousCount.current &&
      applied.epoch === epoch &&
      applied.key === seriesKey &&
      applied.first === bars[0].time &&
      applied.last === bars[bars.length - 1].time;

    if (tailOnly) {
      priceRef.current.update(bars[bars.length - 1]);
      const volume = volumes.at(-1);
      if (volume) volumeRef.current?.update(volume);
      return;
    }

    /* Đổi mã (hay đổi khung) là **một chuỗi khác**, không phải chuỗi cũ vừa dài thêm ra.

       Không phân biệt hai chuyện này thì mã mới thừa hưởng vùng nhìn của mã cũ, và đó là thứ
       người dùng thấy: đang giãn nến để soi một đoạn giữa năm ngoái của AAA, bấm sang MSN vẫn
       đứng nguyên chỗ ấy với đúng độ giãn ấy, thay vì mở ra khoảng đang chọn của mã mới. Giữ
       vùng nhìn chỉ đúng với **cùng một chuỗi dài thêm về quá khứ** — xem nhánh `savedRange`. */
    const sameSeries = applied.key === seriesKey;
    const grew = sameSeries && bars.length > previousCount.current && previousCount.current > 0;
    const savedRange = grew ? chartRef.current?.timeScale().getVisibleLogicalRange() : null;
    const added = bars.length - previousCount.current;

    priceRef.current.setData(bars);
    volumeRef.current?.setData(volumes);

    /* Trục giá cũng phải về mặc định cùng lúc.

       Kéo biểu đồ lên xuống hay giãn trục giá đều **tắt tự canh** của trục ấy, và mức giá đó là
       của mã cũ: AAA vài nghìn đồng, MSN vài chục nghìn — giữ lại thì mã mới vẽ ra ngoài khung
       nhìn, nhìn như không có dữ liệu. `rightOffset` trả về mặc định của chủ đề vì cuộn ngang
       cũng đẩy nó đi. */
    if (!sameSeries) {
      chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
      chartRef.current?.timeScale().applyOptions({ rightOffset: TIME_SCALE_RIGHT_OFFSET });
    }

    if (savedRange && added > 0) {
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from: savedRange.from + added,
        to: savedRange.to + added,
      });
    } else if (!grew) {
      // Lần vẽ đầu, mỗi lần đổi khoảng, và mỗi lần đổi sang chuỗi khác: nhánh này đặt lại vùng
      // nhìn về đúng khoảng đang chọn.
      applyRange(bars.length);
    }

    previousCount.current = bars.length;
    appliedRef.current = {
      epoch,
      key: seriesKey,
      first: bars[0]?.time,
      last: bars.at(-1)?.time,
    };
  }, [bars, volumes, applyRange, epoch, seriesKey, loaded.key]);

  /* ── Đường của chỉ báo vẽ đè ───────────────────────────────────────────── */

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const seriesMap = overlaySeriesRef.current;
    const activeKeys = new Set<string>();

    for (const { instance, def, result } of overlayData) {
      for (const plot of def.plots) {
        const style: PlotDef = { ...plot, ...instance.styleOverrides[plot.key] };
        if (style.hidden) continue;

        const key = `${instance.instanceId}__${plot.key}`;
        activeKeys.add(key);

        let line = seriesMap.get(key);
        if (!line) {
          line = chart.addLineSeries({
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          seriesMap.set(key, line);
        }

        line.applyOptions({
          color: style.color,
          lineWidth: style.lineWidth ?? 1,
          lineStyle: LINE_STYLE_MAP[style.lineStyle ?? 'solid'],
        });

        // Đường vẽ đè dùng chung trục giá với nến, nên bỏ hẳn nến chưa tính được là đúng —
        // khác với cửa sổ riêng, nơi phải đẩy vào khoảng trắng để trục thời gian khỏi lệch.
        const points: { time: UTCTimestamp; value: number }[] = [];
        const values = result[plot.key] ?? [];
        for (let i = 0; i < values.length; i++) {
          const value = values[i];
          if (value === null || !Number.isFinite(value)) continue;
          points.push({ time: series[i].time as UTCTimestamp, value });
        }
        line.setData(points);
      }
    }

    // Dọn đường của chỉ báo đã gỡ hoặc plot vừa bị ẩn.
    for (const [key, line] of seriesMap) {
      if (!activeKeys.has(key)) {
        chart.removeSeries(line);
        seriesMap.delete(key);
      }
    }
  }, [overlayData, series, epoch]);

  const markers = shapes.markers;
  useEffect(() => {
    priceRef.current?.setMarkers(
      (markers ?? []).map((marker) => ({
        time: marker.time as UTCTimestamp,
        position: marker.position,
        shape: marker.shape,
        color: marker.color,
        text: marker.text,
      })),
    );
  }, [markers, epoch]);

  // Cửa sổ chỉ báo đăng ký biểu đồ trước khi có dữ liệu, mà `setData` đầu tiên lại kéo khoảng
  // nhìn về mặc định của thư viện — phải áp lại sau khi chúng đã có nến.
  useEffect(() => {
    const id = requestAnimationFrame(() => sync.realign());
    return () => cancelAnimationFrame(id);
  }, [indicators.panes.length, series.length, sync]);

  const settingsInstance =
    indicators.indicators.find((item) => item.instanceId === settingsId) ?? null;

  return (
    <div
      className={cn(
        'space-y-3',
        expanded && 'fixed inset-0 z-50 flex flex-col bg-surface p-3 sm:p-4',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {/* Lớp phủ che mất phần đầu thẻ ghi mã đang xem — nhắc lại ở đây, và cho đổi mã luôn. */}
          {expanded && symbol && (
            onSymbolChange ? (
              <div className="mr-2 w-40 sm:w-52">
                <SymbolCombobox
                  value={symbol}
                  onChange={(next, info) => onSymbolChange(next, info?.asset_class)}
                  label=""
                  assetClass={assetClass}
                  assetTabs
                />
              </div>
            ) : (
              <span className="mr-2 text-base font-semibold text-ink-900">{symbol}</span>
            )
          )}

          <TimeframeBar
            value={timeframe}
            onChange={setTimeframe}
            items={timeframes}
            disabled={!symbol}
          />

          {/* Vạch ngăn: khung thời gian đổi *độ dài một cây nến*, khoảng nhìn đổi *xem bao nhiêu
              cây*. Hai hàng nút liền nhau không có gì ngăn cách trông như một hàng mười lăm nút
              cùng loại, và người dùng phải bấm thử mới biết cái nào làm gì. */}
          <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden />

          {visibleRanges.map((item) => (
            <button
              key={item.key}
              onClick={() => setRange(item.key)}
              className={cn(
                'min-h-touch shrink-0 rounded-lg px-3 text-sm transition-colors',
                range === item.key
                  ? 'bg-primary font-medium text-primary-fg'
                  : 'text-ink-600 hover:bg-ink-100',
              )}
            >
              {item.label}
            </button>
          ))}

          <Button
            variant="outline"
            size="sm"
            className="ml-1"
            onClick={() => setPickerOpen(true)}
            leftIcon={<Icon name="chart" size={15} />}
          >
            Chỉ báo
            {indicators.indicators.length > 0 && (
              <span className="ml-1.5 rounded-full bg-ink-100 px-1.5 text-xs tabular-nums text-ink-700">
                {indicators.indicators.length}
              </span>
            )}
          </Button>
        </div>

        <span className="flex items-center gap-2 text-xs text-ink-500">
          {switching ? (
            <>
              <Icon name="spinner" size={13} />
              Đang tải khung {activeTimeframe?.label ?? timeframe}…
            </>
          ) : loadingMore ? (
            <>
              <Icon name="spinner" size={13} />
              Đang tải thêm lịch sử…
            </>
          ) : (
            <>
              {/* "Phiên" chỉ đúng với nến ngày: 400 nến 1 phút là một phiên rưỡi, không phải
                  400 phiên. */}
              {candles.length} {intraday ? 'nến' : 'phiên'}
              {exhausted && (
                <span
                  // Ở khung trong ngày, "hết lịch sử" không có nghĩa là mã này chỉ có bấy nhiêu.
                  // Nhà cung cấp chỉ phục vụ một cửa sổ vài trăm nến gần đây; phần sâu hơn dày
                  // lên dần theo mỗi phiên hệ thống chạy đồng bộ. Không nói ra thì người dùng
                  // đọc thành lỗi mất dữ liệu.
                  title={
                    intraday
                      ? 'Nguồn dữ liệu chỉ phục vụ một khoảng gần đây ở khung này. Lịch sử sâu hơn dày lên dần sau mỗi phiên đồng bộ.'
                      : undefined
                  }
                  className={cn(intraday && 'cursor-help underline decoration-dotted')}
                >
                  {' · '}
                  {intraday ? 'hết lịch sử khung này' : 'đã tải hết lịch sử'}
                </span>
              )}
            </>
          )}

          <IconButton
            size="sm"
            variant="outline"
            label={expanded ? 'Thu nhỏ biểu đồ (Esc)' : 'Phóng to kín màn hình'}
            onClick={() => setExpanded((on) => !on)}
          >
            <Icon name={expanded ? 'minimize' : 'maximize'} size={16} />
          </IconButton>
        </span>
      </div>

      {/* Phóng to kín màn hình: biểu đồ và cột phân tích nằm cạnh nhau từ `lg` trở lên. Màn hẹp
          hơn thì xếp dọc — nhét cả hai vào bề ngang điện thoại chỉ làm cả hai đều chật. */}
      <div
        ref={splitRef}
        className={cn('flex min-h-0 flex-col gap-3', expanded && 'flex-1 lg:flex-row lg:gap-0')}
      >
        <div
          className={cn(
            'flex flex-col overflow-hidden rounded-lg border border-ink-200 md:flex-row',
            expanded && 'min-h-0 min-w-0 flex-1',
          )}
        >
          {/* Thanh công cụ vẽ: dọc bên trái từ `md`, dải ngang dưới biểu đồ ở màn hẹp.
              Không có mã thì không có chỗ để lưu hình — đưa ra một thanh công cụ vẽ xong mất
              trắng còn tệ hơn là không có. */}
          {symbol && <DrawingToolbar store={drawings} />}

          <div className={cn('flex min-w-0 flex-1 flex-col', expanded && 'min-h-0')}>
            {/* `flex-1` + `minHeight` chứ không phải chiều cao cứng: thanh công cụ vẽ bên trái có
                thể cao hơn `height`, và khi đó khung viền giãn ra theo nó. Chiều cao cứng để lại
                một khoảng trống dưới biểu đồ, trông như biểu đồ lơ lửng giữa khung. */}
            <div
              ref={hostRef}
              className={cn('relative w-full flex-1', expanded && 'min-h-0')}
              style={expanded ? undefined : { minHeight: height }}
            >
              <div ref={containerRef} className="absolute inset-0" />

              {/* Lớp chờ và lớp "chưa có dữ liệu" nằm **đè lên** biểu đồ chứ không thay chỗ nó.
                  Thay chỗ nghĩa là gỡ biểu đồ khỏi cây mỗi lần đổi mã, và cùng với nó là cờ
                  phóng to kín màn hình, khung thời gian, vùng nhìn đang cuộn tới. `switching`
                  là lượt nạp của chính biểu đồ khi đổi khung, `loading` là lượt nạp của màn cha
                  khi đổi mã — với người nhìn thì cả hai đều là "đang lấy chuỗi nến khác". */}
              {loading || switching ? (
                <div
                  data-chart-ui
                  className="absolute inset-0 z-20 flex items-center justify-center bg-surface/70"
                >
                  <Spinner label="Đang tải biểu đồ…" />
                </div>
              ) : !candles.length ? (
                <div
                  data-chart-ui
                  className="absolute inset-0 z-20 flex items-center justify-center bg-surface/70 px-6 text-center"
                >
                  <p className="text-sm text-ink-500">
                    {symbol
                      ? `Chưa có dữ liệu giá cho ${symbol} ở khung này.`
                      : 'Chưa có dữ liệu giá.'}
                  </p>
                </div>
              ) : null}

              {/* Nhãn các chỉ báo vẽ đè: tên, và nút chỉnh ngay tại chỗ đang nhìn thấy đường đó.
                  `z-[15]` — cùng tầng với lớp bảng của `ShapesLayer`, tức trên lớp vẽ tay: đây là
                  thông số để đọc và nút để bấm, một nét vẽ quét ngang không được che mất. */}
              {indicators.overlays.length > 0 && (
                <div
                  data-chart-ui
                  className="pointer-events-none absolute left-2 top-1 z-[15] flex flex-col gap-0.5"
                >
                  {indicators.overlays.map((instance) => (
                    <span
                      key={instance.instanceId}
                      className="group pointer-events-auto flex w-fit items-center gap-1 rounded bg-surface/85 px-1 text-xs"
                    >
                      <span className={cn('font-medium', instance.visible ? 'text-ink-700' : 'text-ink-400 line-through')}>
                        {instanceLabel(instance)}
                      </span>
                      <span className="flex items-center gap-0.5 opacity-50 transition-opacity group-hover:opacity-100">
                        <PaneButton
                          icon="settings"
                          label="Cài đặt chỉ báo"
                          onClick={() => setSettingsId(instance.instanceId)}
                        />
                        <PaneButton
                          icon={instance.visible ? 'eye' : 'eye-off'}
                          label={instance.visible ? 'Ẩn chỉ báo' : 'Hiện chỉ báo'}
                          onClick={() => indicators.toggleVisible(instance.instanceId)}
                        />
                        <PaneButton
                          icon="trash"
                          label="Bỏ chỉ báo"
                          danger
                          onClick={() => indicators.remove(instance.instanceId)}
                        />
                      </span>
                    </span>
                  ))}
                </div>
              )}

              <ShapesLayer
                chart={chartRef.current}
                series={priceRef.current}
                candles={series}
                width={size.width}
                height={size.height}
                shapes={shapes}
              />

              {symbol && (
                <>
                  <DrawingCanvas
                    hostRef={hostRef}
                    chart={chartRef.current}
                    series={priceRef.current}
                    candles={series}
                    width={size.width}
                    height={size.height}
                    digits={digits}
                    store={drawings}
                    restoreInteraction={interaction}
                  />

                  <DrawingStyleBar store={drawings} />
                </>
              )}
            </div>

            {indicators.panes.map((instance) =>
              instance.visible ? (
                <IndicatorPane
                  key={instance.instanceId}
                  instance={instance}
                  candles={series}
                  height={PANE_HEIGHT}
                  showTimeScale={instance.instanceId === lastVisiblePane}
                  onChartReady={sync.register}
                  onChartDestroy={sync.unregister}
                  onSeriesReady={sync.registerSeries}
                  onOpenSettings={setSettingsId}
                  onToggleVisible={indicators.toggleVisible}
                  onRemove={indicators.remove}
                />
              ) : (
                /* Ẩn thì gỡ hẳn biểu đồ cho đỡ tính toán, nhưng phải chừa một thanh mỏng — không
                   thì không còn chỗ nào để bật hiện lại. */
                <div
                  key={instance.instanceId}
                  className="flex h-8 items-center gap-1 border-t border-ink-200 bg-ink-50 px-2 text-xs"
                >
                  <span className="text-ink-400 line-through">{instanceLabel(instance)}</span>
                  <span className="text-ink-400">— đang ẩn</span>
                  <span className="ml-auto flex items-center gap-0.5">
                    <PaneButton
                      icon="eye-off"
                      label="Hiện lại chỉ báo"
                      onClick={() => indicators.toggleVisible(instance.instanceId)}
                    />
                    <PaneButton
                      icon="trash"
                      label="Bỏ chỉ báo"
                      danger
                      onClick={() => indicators.remove(instance.instanceId)}
                    />
                  </span>
                </div>
              ),
            )}
          </div>
        </div>

        {/* Thanh kéo chia bề ngang. Chỉ có ở bố cục hai cột — xem `split`. */}
        {split && (
          <SplitHandle
            hostRef={splitRef}
            width={sideWidthPx}
            onDrag={setDragWidth}
            onCommit={(next) => {
              setSideWidth(next);
              setDragWidth(null);
            }}
          />
        )}

        {/* Cột phân tích chỉ dựng khi đang phóng to: lúc thu nhỏ nó đã nằm sẵn trong trang.

            Bề rộng đặt bằng `style` chứ không bằng lớp Tailwind vì nó là một con số tuỳ ý người
            dùng kéo tới, không phải một trong dăm bảy bậc dựng sẵn. Chỉ đặt ở bố cục hai cột: khi
            hàng xếp dọc, một bề rộng cứng sẽ cắt cụt khối phân tích theo bề ngang màn hẹp. */}
        {expanded && sidePanel && (
          <aside
            className={cn(
              'min-h-0 shrink-0 overflow-y-auto',
              // Không có thanh kéo (màn hẹp) thì cột nằm dưới và rộng hết hàng.
              !split && 'w-full',
            )}
            style={split ? { width: sideWidthPx } : undefined}
          >
            {sidePanel}
          </aside>
        )}
      </div>

      {/* BR-836 — ghi rõ nguồn dữ liệu dưới biểu đồ.

          Kèm luôn ghi công thư viện vẽ: logo TradingView đã tắt ở `chartTheme` vì nó nổi đè lên
          góc dưới phải, đúng chỗ nến mới nhất. Giấy phép Apache-2.0 đòi giữ phần ghi công chứ
          không đòi giữ đúng cái logo — nên nó chuyển xuống đây thành một dòng chữ.

          Gỡ đi khi phóng to kín màn hình: mọi thứ trong lớp phủ chia nhau đúng một khung nhìn,
          và dòng này ăn mất một dải ngang của phần nến — chỗ duy nhất người dùng bung hết cỡ để
          nhìn. Nguồn dữ liệu vẫn còn nguyên dưới biểu đồ ngay khi thu nhỏ lại. */}
      {!expanded && (
        <p className="text-xs text-ink-500">
          {attribution ? `${attribution} · ` : ''}
        </p>
      )}

      <IndicatorsModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        indicators={indicators.indicators}
        paneCount={indicators.panes.length}
        onAdd={indicators.add}
        onRemoveByDef={indicators.removeByDef}
      />

      <IndicatorSettingsModal
        instance={settingsInstance}
        onClose={() => setSettingsId(null)}
        onApplyParams={indicators.setParams}
        onPatchStyle={indicators.setStyle}
      />
    </div>
  );
}

/**
 * Thanh kéo chia bề ngang giữa biểu đồ và cột phân tích lúc phóng to kín màn hình.
 *
 * Bắt bằng **pointer event + `setPointerCapture`** chứ không phải `mousedown` rồi nghe `mousemove`
 * trên `window`: kéo nhanh thì con trỏ rời khỏi thanh trước khi trình duyệt kịp gửi sự kiện, và
 * khi nó đi ngang qua canvas của biểu đồ thì chính biểu đồ nuốt mất sự kiện — kéo được một đoạn
 * rồi tự nhiên "rơi" tay. Pointer capture khoá cả chuỗi sự kiện về đúng thanh này cho tới lúc thả,
 * và bao luôn cả màn cảm ứng.
 *
 * Vùng bắt tay rộng hơn hẳn vạch kẻ nhìn thấy (`px-1.5` quanh một vạch 1px): một mục tiêu 1px là
 * thứ người dùng phải nhắm, còn ~14px thì chỉ cần đưa chuột tới.
 */
function SplitHandle({
  hostRef,
  width,
  onDrag,
  onCommit,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
  width: number;
  onDrag: (next: number) => void;
  onCommit: (next: number) => void;
}) {
  const [dragging, setDragging] = useState(false);

  /** Toạ độ chuột → bề rộng cột phải: đo ngược từ mép phải của hàng. */
  const widthAt = useCallback(
    (clientX: number) => {
      const host = hostRef.current;
      if (!host) return width;
      const rect = host.getBoundingClientRect();
      return clampSideWidth(rect.right - clientX, rect.width);
    },
    [hostRef, width],
  );

  /** Chỉnh bằng bàn phím — thanh kéo là một điều khiển thật, không chỉ là vạch để rê chuột. */
  function nudge(delta: number) {
    const host = hostRef.current;
    onCommit(clampSideWidth(width + delta, host?.clientWidth ?? width + delta));
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Kéo để chỉnh bề rộng hai cột"
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      className="group relative hidden shrink-0 cursor-col-resize touch-none select-none items-center justify-center px-1.5 outline-none lg:flex"
      onPointerDown={(event) => {
        // Chỉ nút trái: chuột phải để dành cho menu ngữ cảnh, và bắt luôn nút giữa sẽ nuốt mất
        // thao tác dán trên Linux.
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        onDrag(widthAt(event.clientX));
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        setDragging(false);
        onCommit(widthAt(event.clientX));
      }}
      // Pointer capture bị cắt giữa chừng (cửa sổ mất tiêu điểm, hệ điều hành thu lại) vẫn phải
      // chốt bề rộng đang có: không chốt thì `dragWidth` treo lại ở màn cha và lần kéo sau nhảy
      // về chỗ cũ.
      onPointerCancel={() => {
        if (!dragging) return;
        setDragging(false);
        onCommit(width);
      }}
      onKeyDown={(event) => {
        // Mũi tên trái nới cột phải ra (biểu đồ hẹp lại) — vạch ngăn đi sang trái, đúng chiều
        // người dùng bấm.
        if (event.key === 'ArrowLeft') nudge(SIDE_WIDTH_STEP);
        else if (event.key === 'ArrowRight') nudge(-SIDE_WIDTH_STEP);
        else return;
        event.preventDefault();
      }}
      // Bấm đúp về mặc định: kéo lỡ tay tới một bề rộng khó dùng thì đường về phải là một thao
      // tác, không phải kéo mò ngược lại.
      onDoubleClick={() => onCommit(SIDE_WIDTH_DEFAULT)}
    >
      <span
        aria-hidden
        className={cn(
          'h-full w-px rounded-full transition-colors',
          dragging ? 'bg-brand' : 'bg-line group-hover:bg-line-strong group-focus-visible:bg-brand',
        )}
      />
    </div>
  );
}
