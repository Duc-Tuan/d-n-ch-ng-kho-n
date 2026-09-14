/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:8000';

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  /**
   * Thư mục build. Mặc định vẫn là `.next` — đặt `NEXT_DIST_DIR` để chạy **một tiến trình Next
   * thứ hai** trên cùng mã nguồn mà không giẫm lên nhau.
   *
   * Hai `next dev` cùng dùng `.next` thì tiến trình sau ghi đè bản biên dịch của tiến trình
   * trước, và tiến trình trước bắt đầu trả 404 cho chính các chunk JS của nó — trang tải ra
   * HTML trắng, không kèm một dòng lỗi nào giải thích. Cần tới cái này khi vừa chạy bản của
   * mình vừa để bản đang xem dở sống, ví dụ lúc đối chiếu trước/sau một thay đổi giao diện.
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',

  // BR-824 — ngân sách hiệu năng: ảnh WebP/AVIF, lazy load mặc định của next/image.
  images: {
    formats: ['image/avif', 'image/webp'],
  },

  /**
   * Proxy API qua cùng origin để cookie HttpOnly (cst_at / adm_at) hoạt động
   * mà không cần SameSite=None. Ở production nên đặt reverse proxy (nginx) làm việc này.
   */
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_ORIGIN}/api/v1/:path*` }];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
