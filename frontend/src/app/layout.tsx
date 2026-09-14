import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';

import { ToastProvider } from '@/hooks';
import './globals.css';

/**
 * Chữ giao diện.
 *
 * Trước đây không khai gì cả, nghĩa là rơi về stack mặc định của trình duyệt — mỗi máy một
 * kiểu, và trên Windows là Arial. Đó là lý do lớn nhất khiến giao diện trông chưa được thiết
 * kế, lớn hơn cả màu sắc: cùng một bố cục, đổi mỗi mặt chữ là khác hẳn.
 *
 * Inter dựng riêng cho chữ nhỏ trên màn hình, và quan trọng hơn với sản phẩm này là nó có
 * **chữ số cùng bề rộng** (`tnum`) — bảng giá sáu mươi dòng mà chữ số so le thì cột số nhảy
 * lung tung theo từng ký tự.
 *
 * `display: swap` để chữ hiện ngay bằng font dự phòng rồi mới đổi, thay vì để trang trắng chờ
 * tải font. `preload` và tập con `vietnamese` là bắt buộc: thiếu nó thì dấu tiếng Việt rơi
 * xuống font dự phòng và cả câu có hai mặt chữ lẫn nhau.
 */
const inter = Inter({
  subsets: ['latin', 'vietnamese'],
  display: 'swap',
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title: {
    default: 'Hệ thống tư vấn chứng khoán',
    template: '%s · Hệ thống tư vấn chứng khoán',
  },
  description:
    'Nền tảng cung cấp thông tin, công cụ và tài liệu tham khảo phục vụ nghiên cứu thị trường chứng khoán.',
  // BR-823 — PWA: "Thêm vào màn hình chính" giải quyết ~80% nhu cầu "có app không".
  manifest: '/manifest.json',
  appleWebApp: { capable: true, title: 'Tư vấn CK', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Không đặt maximumScale=1: chặn zoom là lỗi tiếp cận, và BR-846 cần pinch-zoom trên biểu đồ.
  themeColor: '#1f63dc',
  viewportFit: 'cover',
};

/**
 * Chọn bảng màu **trước khi trang vẽ lần đầu**.
 *
 * Phải là script đồng bộ nhúng thẳng vào HTML chứ không phải `useEffect`: hiệu ứng chỉ chạy sau
 * lượt vẽ đầu tiên, và người dùng sẽ thấy một cú chớp trắng toàn màn hình mỗi lần tải trang —
 * đúng thứ ai cũng gặp khi tự dựng nút đổi nền lần đầu.
 *
 * Script đặt **hai** thuộc tính, vì từ nay có hai trục độc lập (xem `globals.css`):
 *
 *   * `data-area` suy từ đường dẫn. Là danh tính của vùng, người dùng không đổi được — BR-000
 *     muốn nhìn một giây là biết mình đang ở site nào.
 *   * `data-theme` là **tùy chọn của người dùng** trên site khách hàng, đọc từ `localStorage`
 *     với đúng khoá mà `hooks/useTheme` ghi. Site quản trị bỏ qua tùy chọn đó và luôn sáng:
 *     ở đó bảng dữ liệu dày đặc và nhân viên ngồi cả ngày, nền sáng vẫn là lựa chọn đúng và
 *     không có lý do nghiệp vụ nào để mở ra hai biến thể phải bảo trì.
 *
 * Toàn bộ nằm trong `try/catch`: trình duyệt chặn `localStorage` (chế độ riêng tư, cookie bị
 * khoá) sẽ ném ngay ở dòng đọc, và một ngoại lệ ở `<head>` chặn luôn phần HTML còn lại.
 */
const THEME_SCRIPT = `try{
var d=document.documentElement;
var area=location.pathname.split('/')[1]==='admin'?'admin':'customer';
d.dataset.area=area;
var t='dark';
if(area==='admin'){t='light'}
else{
  var s=localStorage.getItem('ck.theme');
  if(s!=='light'&&s!=='dark'&&s!=='system'){s='dark'}
  t=s==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):s;
}
d.dataset.theme=t;
}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * `suppressHydrationWarning` ở đây là **bắt buộc**, không phải để giấu lỗi.
     *
     * Máy chủ dựng ra `data-theme="dark"` vì đó là giá trị viết cứng trong JSX. Script ở `<head>`
     * chạy ngay lúc trình duyệt đọc tới, tức là **trước khi React hydrate**, và ghi đè nó theo
     * vùng lẫn theo tùy chọn đã lưu của người dùng. React 19 so khớp cả thuộc tính của `<html>`, thấy
     * lệch, rồi báo "Hydration failed... this tree will be regenerated on the client" — và dựng
     * lại toàn bộ cây từ đầu ở phía trình duyệt.
     *
     * Ba cách sửa, và vì sao chọn cách này:
     *   * Bỏ script đi, đổi bảng màu bằng `useEffect` — mất đúng thứ script sinh ra để tránh:
     *     một cú chớp nền tối trên site quản trị ở mỗi lần tải trang.
     *   * Bỏ `data-theme` khỏi JSX — lượt dựng trên máy chủ không còn bảng màu nào, và người
     *     tắt JavaScript nhận một trang không màu.
     *   * Nói với React rằng thuộc tính của riêng thẻ này được sửa có chủ đích — cách chuẩn cho
     *     đúng tình huống "script chạy trước hydrate", và cũng là cách `next-themes` dùng.
     *
     * Cờ này chỉ bỏ qua khác biệt **của chính thẻ `<html>`**, không lan xuống các thẻ con: mọi
     * lệch hydrate thật bên trong trang vẫn báo như thường.
     */
    <html
      lang="vi"
      data-theme="dark"
      data-area="customer"
      className={inter.variable}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
