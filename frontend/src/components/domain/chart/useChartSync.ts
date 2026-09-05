'use client';

/**
 * Ghép biểu đồ giá và các cửa sổ chỉ báo thành **một** biểu đồ trước mắt người dùng.
 *
 * lightweight-charts v4 không có nhiều pane trong một `chart`, nên mỗi cửa sổ là một biểu đồ
 * độc lập xếp chồng. Ba thứ phải tự đồng bộ, thiếu cái nào là lộ ngay ra là chúng rời nhau:
 *
 * * **Khoảng nhìn** — kéo/phóng ở một cái thì mọi cái còn lại đi theo.
 * * **Đường ngắm** — rê chuột trên biểu đồ giá phải thấy vạch dọc ở đúng phiên đó trên RSI.
 * * **Bề rộng cột giá** — cột giá tự co theo nhãn dài nhất, nên phải ép tất cả về số lớn nhất,
 *   nếu không vùng vẽ rộng hẹp khác nhau và các nến không thẳng cột.
 */
import {
  MismatchDirection,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type SeriesType,
  type Time,
} from 'lightweight-charts';
import { useCallback, useMemo, useRef } from 'react';

import { PRICE_SCALE_MIN_WIDTH } from './chartTheme';

export interface ChartSync {
  /** Biểu đồ vừa được tạo — bắt đầu đồng bộ. */
  register: (chart: IChartApi) => void;
  /** Biểu đồ sắp bị huỷ. */
  unregister: (chart: IChartApi) => void;
  /** Series đại diện của biểu đồ đó, cần để đặt được đường ngắm ngang đúng thang giá. */
  registerSeries: (chart: IChartApi, series: ISeriesApi<SeriesType>) => void;
  /** Áp lại khoảng nhìn của biểu đồ giá cho các cửa sổ — gọi sau khi cửa sổ mới có dữ liệu. */
  realign: () => void;
}

export function useChartSync(): ChartSync {
  /** Biểu đồ → series đại diện. Thứ tự chèn quyết định ai là gốc: biểu đồ giá đăng ký đầu tiên. */
  const chartsRef = useRef<Map<IChartApi, ISeriesApi<SeriesType> | null>>(new Map());
  /** Chặn vòng lặp: A đặt khoảng nhìn cho B, B lại bắn ngược về A. */
  const syncingRef = useRef(false);

  const withGuard = useCallback((fn: () => void) => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      fn();
    } finally {
      syncingRef.current = false;
    }
  }, []);

  const syncCrosshair = useCallback(
    (source: IChartApi, param: MouseEventParams<Time>) => {
      withGuard(() => {
        for (const [chart, series] of chartsRef.current) {
          if (chart === source) continue;

          if (param.time === undefined || param.logical === undefined || !series) {
            chart.clearCrosshairPosition();
            continue;
          }

          // Giá phải lấy từ series **của chính biểu đồ đó**: mỗi cửa sổ một thang giá riêng,
          // mượn giá của biểu đồ nguồn thì vạch ngang rơi sai chỗ (RSI 70 vẽ ở mức giá 70đ).
          const bar = series.dataByIndex(param.logical, MismatchDirection.NearestLeft);
          const price =
            bar && 'value' in bar
              ? (bar.value as number)
              : bar && 'close' in bar
                ? (bar.close as number)
                : null;

          if (price === null) chart.clearCrosshairPosition();
          else chart.setCrosshairPosition(price, param.time, series);
        }
      });
    },
    [withGuard],
  );

  /**
   * Cân bề rộng cột giá của mọi biểu đồ.
   *
   * Hạ tất cả về mức sàn trước rồi mới đo: không có bước đó thì cột chỉ nới ra chứ không bao giờ
   * co lại, và một lần hiện chỉ báo có nhãn dài sẽ để lại khoảng trắng vĩnh viễn.
   */
  const alignPriceScales = useCallback(() => {
    if (chartsRef.current.size < 2) return;

    for (const chart of chartsRef.current.keys()) {
      chart.priceScale('right').applyOptions({ minimumWidth: PRICE_SCALE_MIN_WIDTH });
    }

    requestAnimationFrame(() => {
      const charts = [...chartsRef.current.keys()];
      if (charts.length < 2) return;
      const widest = Math.max(
        PRICE_SCALE_MIN_WIDTH,
        ...charts.map((chart) => chart.priceScale('right').width()),
      );
      for (const chart of charts) {
        chart.priceScale('right').applyOptions({ minimumWidth: widest });
      }
    });
  }, []);

  const register = useCallback(
    (chart: IChartApi) => {
      if (!chartsRef.current.has(chart)) chartsRef.current.set(chart, null);

      chart.timeScale().subscribeVisibleLogicalRangeChange((range: LogicalRange | null) => {
        if (!range) return;
        withGuard(() => {
          chartsRef.current.forEach((_series, other) => {
            if (other !== chart) other.timeScale().setVisibleLogicalRange(range);
          });
        });
      });

      chart.subscribeCrosshairMove((param) => syncCrosshair(chart, param));

      // Cửa sổ vừa thêm phải khớp ngay khoảng đang xem, không bắt người dùng kéo lại.
      const reference = chartsRef.current.keys().next().value;
      const range = reference?.timeScale().getVisibleLogicalRange();
      if (range && reference !== chart) chart.timeScale().setVisibleLogicalRange(range);
    },
    [withGuard, syncCrosshair],
  );

  const registerSeries = useCallback(
    (chart: IChartApi, series: ISeriesApi<SeriesType>) => {
      chartsRef.current.set(chart, series);
      alignPriceScales();
    },
    [alignPriceScales],
  );

  const unregister = useCallback((chart: IChartApi) => {
    chartsRef.current.delete(chart);
  }, []);

  /**
   * Cửa sổ đăng ký biểu đồ **trước** khi có dữ liệu, mà `setData` lần đầu lại kéo khoảng nhìn
   * về mặc định của thư viện. Nên phải áp lại một lần nữa sau khi nó đã có nến.
   */
  const realign = useCallback(() => {
    const [reference, ...others] = [...chartsRef.current.keys()];
    if (!reference || !others.length) return;

    const range = reference.timeScale().getVisibleLogicalRange();
    if (range) {
      withGuard(() => others.forEach((chart) => chart.timeScale().setVisibleLogicalRange(range)));
    }
    alignPriceScales();
  }, [withGuard, alignPriceScales]);

  // Trả về một object **ổn định**: biểu đồ giá đưa `sync` vào deps của effect dựng biểu đồ, nên
  // một object mới mỗi lần render đồng nghĩa với dựng lại biểu đồ sau mỗi lần render.
  return useMemo(
    () => ({ register, unregister, registerSeries, realign }),
    [register, unregister, registerSeries, realign],
  );
}
