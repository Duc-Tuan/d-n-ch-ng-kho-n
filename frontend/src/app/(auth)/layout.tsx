import Link from 'next/link';

import { SessionProvider } from '@/hooks';

/**
 * Vùng auth — đăng nhập, đăng ký, quên mật khẩu, xác thực email.
 *
 * Không bọc `CustomerShell` vì các màn này chạy khi chưa đăng nhập (hoặc đang bị chặn),
 * nếu bọc sẽ tạo vòng lặp điều hướng.
 *
 * **Bố cục hai cột từ `lg` trở lên.** Bản trước là một cột `max-w-md` căn giữa: trên điện thoại
 * thì đúng, nhưng trên màn hình làm việc nó để trống hơn hai phần ba chiều ngang, và biểu mẫu
 * đăng nhập trôi lơ lửng giữa một vùng xám không có gì. Cột trái lấp chỗ đó bằng thứ khách hàng
 * mới thực sự cần biết trước khi đăng ký — đây là màn đầu tiên của sản phẩm, cũng thường là màn
 * duy nhất người chưa có tài khoản nhìn thấy.
 *
 * **Phân biệt với màn đăng nhập quản trị (BR-000).** Từ khi site khách hàng chuyển sang nền
 * tối, "bên nào tối hơn" không còn là dấu hiệu phân biệt — cả hai đều tối. Việc đó chuyển sang
 * cho **màu thương hiệu**: cột trái ở đây phủ một lớp xanh `brand`, logo là khối xanh, nút chính
 * xanh. Màn quản trị trung tính hoàn toàn, không có một điểm xanh nào. Nhân viên gõ nhầm mật
 * khẩu quản trị vào ô đăng nhập khách hàng là một sự cố lộ thông tin, không phải một phiền toái
 * nhỏ, nên dấu hiệu phải nằm ở chỗ mắt bắt trước cả khi đọc chữ.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      {/*
        `lg:h-dvh` + `lg:overflow-hidden`: từ desktop trở lên, **trang không bao giờ cuộn**.
        Nội dung dài hơn màn hình thì phần cuộn nằm bên trong biểu mẫu, do từng màn tự lo. Cuộn
        cả trang ở đây sẽ kéo luôn cột thương hiệu bên trái trôi lên — một cột chỉ có chữ tĩnh,
        cuộn nó không mang lại gì mà còn làm mất logo khỏi tầm nhìn.

        Dưới `lg` vẫn để trang cuộn bình thường: màn hình điện thoại quá thấp để nhốt biểu mẫu
        vào một khung cuộn riêng — làm thế sẽ có hai thanh cuộn lồng nhau.
      */}
      <div className="min-h-dvh bg-canvas lg:grid lg:h-dvh lg:min-h-0 lg:grid-cols-[minmax(24rem,38%)_minmax(0,1fr)] lg:overflow-hidden">
        {/* ---------- Cột thương hiệu (chỉ desktop) ----------
            Chiếm 38% chiều ngang, sàn 24rem. Hẹp hơn thì tiêu đề vỡ thành bốn dòng và cột trông
            như một dải trang trí; rộng hơn thì lấn vào chỗ của biểu mẫu Đăng ký, vốn cần đủ chỗ
            cho hai ô một hàng. */}
        {/* Lớp xanh loang từ góc trên trái: nền phẳng tuyệt đối ở cỡ này trông như một mảng
            chết, còn một dải chuyển màu rất nhạt cho cột chiều sâu mà không tranh chấp với chữ.
            `radial-gradient` chứ không phải ảnh — không thêm một lượt tải nào. */}
        <aside className="relative hidden flex-col justify-between overflow-y-auto border-r border-line bg-surface p-10 text-ink-900 lg:flex xl:p-12">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_80%_at_0%_0%,rgb(var(--brand)/0.16),transparent_60%)]"
          />

          <Link href="/login" className="relative flex items-center gap-3 font-semibold">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-sm text-primary-fg">
              CK
            </span>
            <span className="text-lg">Tư vấn chứng khoán</span>
          </Link>

          <div className="relative space-y-7 py-8">
            <h2 className="text-2xl font-semibold leading-snug xl:text-3xl">
              Chiến lược có số liệu kiểm chứng, không phải lời khuyên cảm tính.
            </h2>
            <ul className="space-y-5 text-ink-600">
              {[
                {
                  title: 'Thống kê tách bạch',
                  body:
                    'Tín hiệu thực và tín hiệu mô phỏng luôn hiển thị riêng, không bao giờ gộp chung một con số.',
                },
                {
                  title: 'Điểm mua bán trên biểu đồ',
                  body:
                    'Áp chiến lược lên bất kỳ mã nào bạn quan tâm và tự đánh giá trước khi tin.',
                },
                {
                  title: 'Nhận tín hiệu qua Telegram',
                  body:
                    'Đúng các cặp chiến lược × mã bạn đăng ký, gửi riêng cho tài khoản của bạn.',
                },
              ].map((item) => (
                <li key={item.title} className="flex gap-3">
                  <span
                    aria-hidden
                    className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
                  />
                  <span>
                    <span className="block font-medium text-ink-900">{item.title}</span>
                    <span className="mt-0.5 block text-sm leading-relaxed">{item.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* BR-601 — miễn trừ trách nhiệm phải xuất hiện trước cả khi khách hàng đăng ký. */}
          <p className="relative text-xs leading-relaxed text-ink-500">
            Thông tin trên hệ thống mang tính tham khảo, không phải khuyến nghị mua bán chứng
            khoán. Nhà đầu tư chịu trách nhiệm với quyết định của mình.
          </p>
        </aside>

        {/* ---------- Cột biểu mẫu ----------
            `min-h-0` là bắt buộc, không phải thừa: mặc định một flex item có `min-height:auto`,
            nghĩa là nó nở ra theo nội dung và `overflow` ở phần tử con không bao giờ kích hoạt.
            Thiếu dòng này thì khung cuộn của biểu mẫu Đăng ký sẽ không có tác dụng gì. */}
        <div className="flex min-h-dvh flex-col lg:h-full lg:min-h-0">
          {/* Trên desktop cột trái đã mang logo, nên thanh này chỉ hiện ở mobile/tablet. */}
          <header className="shrink-0 border-b border-line bg-surface lg:hidden">
            <div className="mx-auto flex h-14 max-w-md items-center px-4">
              <Link href="/login" className="flex items-center gap-2 font-semibold text-ink-900">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm text-primary-fg">
                  CK
                </span>
                Tư vấn chứng khoán
              </Link>
            </div>
          </header>

          {/* Không kẹp chiều rộng ở đây. Mỗi màn tự quyết: Đăng nhập hẹp (hai trường, hẹp thì
              đọc nhanh hơn), Đăng ký rộng gấp đôi để xếp hai ô một hàng. */}
          <main className="flex flex-1 flex-col justify-center px-4 py-8 sm:py-10 lg:min-h-0 lg:overflow-hidden">
            {children}
          </main>

          <footer className="shrink-0 px-4 py-6">
            <div className="mx-auto max-w-md space-y-2 text-center text-xs text-ink-500">
              {/* Mục 9.1 — ToS, Privacy, Disclaimer bắt buộc hiển thị ở footer. */}
              <nav className="flex flex-wrap justify-center gap-x-4 gap-y-1">
                <Link href="/legal/tos" className="transition-colors hover:text-ink-900">
                  Điều khoản sử dụng
                </Link>
                <Link href="/legal/privacy" className="transition-colors hover:text-ink-900">
                  Chính sách bảo mật
                </Link>
                <Link href="/legal/disclaimer" className="transition-colors hover:text-ink-900">
                  Miễn trừ trách nhiệm
                </Link>
              </nav>
              {/* Bản đầy đủ nằm ở cột trái trên desktop; ở đây nhắc gọn cho màn hình nhỏ. */}
              <p className="lg:hidden">
                Thông tin trên hệ thống mang tính tham khảo, không phải khuyến nghị mua bán chứng
                khoán.
              </p>
            </div>
          </footer>
        </div>
      </div>
    </SessionProvider>
  );
}
