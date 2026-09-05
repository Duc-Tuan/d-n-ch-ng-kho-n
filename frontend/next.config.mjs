/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:8000';

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

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
