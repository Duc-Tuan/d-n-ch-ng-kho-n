import type { Config } from 'tailwindcss';

/**
 * BR-820 — thiết kế mobile-first. Breakpoint bám đúng mục 11.1:
 * Mobile < 640px · Tablet 640–1024px · Desktop > 1024px.
 *
 * ----------------------------------------------------------------------------------------
 * HAI GIAO DIỆN, MỘT BỘ CLASS
 * ----------------------------------------------------------------------------------------
 * Site khách hàng chạy **nền tối**, site quản trị giữ **nền sáng**. Không nhân đôi component
 * và cũng không rắc `dark:` lên vài nghìn dòng JSX: mọi màu ở đây là **biến CSS**, và giá trị
 * của biến do `data-theme` trên thẻ `<html>` quyết định (xem `globals.css`).
 *
 * Hệ quả cần nhớ khi sửa về sau:
 *
 * * `text-ink-900` luôn nghĩa là "chữ tương phản mạnh nhất", không phải "màu đen". Ở nền tối
 *   nó gần trắng. Cả thang `ink` là thang **độ tương phản**, không phải thang độ sáng.
 * * Vì vậy **không** viết `text-white` lên nền `bg-ink-900` — ở nền tối cả hai cùng sáng và
 *   chữ biến mất. Nút đặc dùng cặp `bg-primary` / `text-primary-fg`.
 * * Màu cứng của Tailwind (`bg-green-50`, `text-red-600`…) chỉ còn dùng được ở màn **chỉ**
 *   thuộc site quản trị. Chỗ nào dùng chung phải đi qua `tone-*`.
 *
 * Hệ màu chủ đạo vẫn là **xám trung tính**. Màu chỉ được dùng để mang thông tin: trạng thái tài
 * khoản, tăng/giảm giá, cảnh báo. Nhờ vậy khi một ô đỏ xuất hiện trên màn hình, mắt người dùng
 * bắt ngay — thay vì lẫn vào một giao diện vốn đã nhiều màu. Ngoại lệ duy nhất là `brand`
 * (xanh dương), dành riêng cho site khách hàng: nó không mang thông tin mà mang **danh tính**,
 * và đó chính là thứ BR-000 cần — nhìn một giây phải biết mình đang ở site nào.
 */

/** Màu đọc từ biến CSS mà vẫn dùng được `bg-x/50`, `text-x/70`… của Tailwind. */
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

/** Bộ ba của một sắc thái: nền chip, chữ trên nền đó, và viền. */
const tone = (name: string) => ({
  bg: v(`tone-${name}-bg`),
  fg: v(`tone-${name}-fg`),
  line: v(`tone-${name}-line`),
});

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    screens: {
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px',
    },
    extend: {
      colors: {
        /**
         * Thang tương phản. 50 = chìm nhất so với nền, 950 = nổi nhất.
         * Nền sáng: 50 gần trắng → 950 gần đen. Nền tối: ngược lại.
         */
        ink: {
          50: v('ink-50'),
          100: v('ink-100'),
          200: v('ink-200'),
          300: v('ink-300'),
          400: v('ink-400'),
          500: v('ink-500'),
          600: v('ink-600'),
          700: v('ink-700'),
          800: v('ink-800'),
          900: v('ink-900'),
          950: v('ink-950'),
        },

        /** Nền trang. Thứ nằm dưới cùng, không có gì chìm hơn nó. */
        canvas: v('canvas'),

        /**
         * Mặt phẳng nổi trên nền trang: thẻ, thanh điều hướng, hộp thoại.
         * `raised` cho lớp nổi thêm một bậc — menu xổ, mục đang trỏ tới, ô được chọn.
         */
        surface: {
          DEFAULT: v('surface'),
          raised: v('surface-raised'),
          sunken: v('surface-sunken'),
        },

        /** Viền. Tách khỏi thang `ink` vì ở nền tối viền phải sáng hơn nền chứ không tối hơn. */
        line: {
          DEFAULT: v('line'),
          strong: v('line-strong'),
        },

        /** Nút hành động chính. Nền sáng: mực đen. Nền tối: xanh thương hiệu. */
        primary: {
          DEFAULT: v('primary'),
          fg: v('primary-fg'),
          hover: v('primary-hover'),
          active: v('primary-active'),
        },

        /** Nút phá huỷ — xoá, khoá, gỡ. */
        danger: {
          DEFAULT: v('danger'),
          fg: v('danger-fg'),
          hover: v('danger-hover'),
          active: v('danger-active'),
        },

        /**
         * Lớp đảo tương phản — chỉ dẫn, chú thích nổi trên biểu đồ.
         * Ở nền sáng là hộp đen chữ trắng; ở nền tối **không** đảo thành hộp trắng chói mắt mà
         * nâng lên một bậc mặt phẳng, giữ nguyên chữ sáng.
         */
        inverted: {
          DEFAULT: v('inverted'),
          fg: v('inverted-fg'),
        },

        /** Danh tính site khách hàng: logo, mục đang mở, đường dẫn trong bài. */
        brand: {
          DEFAULT: v('brand'),
          fg: v('brand-fg'),
          soft: v('brand-soft'),
          hover: v('brand-hover'),
        },

        /** Sắc thái mang thông tin — nhãn trạng thái, hộp cảnh báo, chữ lỗi. */
        tone: {
          gray: tone('gray'),
          blue: tone('blue'),
          green: tone('green'),
          amber: tone('amber'),
          red: tone('red'),
          cyan: tone('cyan'),
          purple: tone('purple'),
        },

        /** Màu trạng thái nghiệp vụ (Phần 1) — chỉ dùng khi cần truyền đạt trạng thái. */
        status: {
          trial: '#0e7490',
          active: '#15803d',
          grace: '#c2410c',
          expired: '#b91c1c',
          warning: '#b45309',
          suspended: '#b91c1c',
          closed: '#52525b',
        },

        /** Quy ước thị trường Việt Nam: tăng xanh lá, giảm đỏ, tham chiếu vàng. */
        up: v('up'),
        down: v('down'),
        ref: v('ref'),
        ceil: v('ceil'),
        floor: v('floor'),
      },

      /** Vòng sáng focus phải hở ra khỏi **nền của trang**, không phải khỏi màu trắng. */
      ringOffsetColor: {
        DEFAULT: v('canvas'),
      },

      fontFamily: {
        // `--font-sans` do `next/font` đặt ở `app/layout.tsx`. Vẫn giữ stack dự phòng đầy đủ
        // cho quãng trước khi font tải xong, và cho trường hợp máy chủ dựng không ra mạng.
        sans: [
          'var(--font-sans)',
          'ui-sans-serif',
          'system-ui',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
      },
      fontSize: {
        // Mục 11.2 — cỡ chữ đọc nội dung tối thiểu 16px, chiều cao dòng 1.6.
        article: ['1rem', { lineHeight: '1.6' }],
        // Thang tiêu đề: càng lớn thì chữ càng phải bó lại, nếu không nó rời ra thành từng chữ.
        'display-lg': ['2rem', { lineHeight: '1.15', letterSpacing: '-0.022em' }],
        'display': ['1.5rem', { lineHeight: '1.2', letterSpacing: '-0.018em' }],
        'display-sm': ['1.125rem', { lineHeight: '1.3', letterSpacing: '-0.011em' }],
        // Nhãn nhỏ in hoa — chữ hoa cỡ nhỏ cần giãn ra chứ không bó lại.
        'label': ['0.6875rem', { lineHeight: '1', letterSpacing: '0.06em' }],
      },
      spacing: {
        // BR-822 — vùng chạm tối thiểu 44×44px.
        touch: '2.75rem',
        'bottom-nav': '4.5rem',
        sidebar: '15rem',
      },
      maxWidth: {
        // Bề rộng nội dung site khách hàng — rộng hơn mặc định để không trống hai mép.
        content: '100rem',
      },
      boxShadow: {
        // Đổ bóng ở nền tối gần như vô hình, nên bản tối thay bằng bóng đậm hơn nhiều — xem
        // `--shadow-*` trong `globals.css`.
        card: 'var(--shadow-card)',
        raised: 'var(--shadow-raised)',
        pop: 'var(--shadow-pop)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { transform: 'translateY(8px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        'sheet-up': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.15s ease-out',
        'slide-up': 'slide-up 0.18s ease-out',
        'sheet-up': 'sheet-up 0.24s cubic-bezier(0.32, 0.72, 0, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
