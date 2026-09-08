/**
 * Đánh dấu biểu đồ đã bị gỡ, để không ai vẽ vào một biểu đồ không còn tồn tại.
 *
 * Vì sao cần cả một module cho việc này: các lớp phủ (`ShapesLayer`, `DrawingCanvas`) nhận biểu
 * đồ qua **prop đọc từ ref** của biểu đồ cha. Ref đổi không làm React vẽ lại, nên trong một lượt
 * commit mà cả hai bên cùng có effect phải chạy lại, React dọn effect của cha trước rồi mới chạy
 * effect của con — cha đã gọi `chart.remove()` xong, con vẫn cầm đúng cái handle vừa chết đó và
 * gọi tiếp `chart.paneSize()`.
 *
 * Lúc ấy `lightweight-charts` **ném lỗi** chứ không trả về rỗng (`ensureDefined` trên danh sách
 * pane đã bị xoá), và vì lỗi ném ra từ trong một passive effect nên nó hạ luôn cả cây React chứ
 * không chỉ hỏng một lớp vẽ. Trên điện thoại chuyện này gần như chắc chắn xảy ra: `useIsMobile`
 * chỉ biết mình đang ở màn hẹp **sau khi mount**, cờ đó lật làm biểu đồ bị dựng lại, đúng vào
 * lượt commit mà các lớp phủ cũng vừa nhận kích thước thật.
 *
 * Cách chữa là ghi nhận trạng thái "đã gỡ" ở một chỗ dùng chung, thay vì bọc `try/catch` quanh
 * mỗi lời gọi — `try/catch` sẽ nuốt luôn những lỗi vẽ thật sự cần biết.
 *
 * Dùng `WeakSet` để biểu đồ đã gỡ vẫn được thu hồi bộ nhớ bình thường: giữ chúng trong một `Set`
 * thường là mỗi lần đổi mã hay đổi khung lại rò thêm một biểu đồ, sống hết đời trang.
 */
import type { IChartApi } from 'lightweight-charts';

const removed = new WeakSet<IChartApi>();

/**
 * Gỡ một biểu đồ. **Luôn dùng hàm này thay cho `chart.remove()`**, nếu không thì các lớp phủ
 * không có cách nào biết cái handle chúng đang cầm đã chết.
 */
export function removeChart(chart: IChartApi): void {
  removed.add(chart);
  chart.remove();
}

/** Biểu đồ còn dùng được không. `null` cũng trả `false` để nơi gọi chỉ cần một phép kiểm tra. */
export function isChartLive(chart: IChartApi | null | undefined): chart is IChartApi {
  return !!chart && !removed.has(chart);
}
