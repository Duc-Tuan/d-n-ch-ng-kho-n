/**
 * Dựng ngữ cảnh vẽ cho các lớp canvas phủ trên biểu đồ.
 *
 * Biểu đồ giá có **bốn** lớp phủ chồng lên nhau, mỗi lớp một tầng xếp lớp riêng: hình của chỉ
 * báo, hình vẽ tay, bảng số liệu, rồi ghi chú dán. Cả bốn đều cần đúng một việc mở đầu giống
 * nhau, và làm sai nó thì chữ nhoè trên màn Retina — nên nó nằm ở đây, một chỗ.
 */

/**
 * Ngữ cảnh 2D của một canvas, đã đặt đúng mật độ điểm ảnh và xoá sạch.
 *
 * Kích thước điểm ảnh thật phải gấp `devicePixelRatio` lần kích thước CSS. Gán lại `canvas.width`
 * cũng là xoá canvas, nên chỉ gán khi số đo thật sự đổi — gán mỗi lượt vẽ là mỗi lượt cấp phát
 * lại bộ đệm ảnh, thứ thấy rõ ngay khi kéo biểu đồ.
 */
export function clearedContext(
  canvas: HTMLCanvasElement | null,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return null;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}
