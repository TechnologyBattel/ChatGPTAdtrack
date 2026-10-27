/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#202124',
        muted: '#5f6368',
        line: '#dadce0',
        cloud: '#f8f9fa',
        brand: '#1a73e8',
        brandSoft: '#e8f0fe',
        good: '#137333',
        warn: '#b06000',
        // Secondary text. Deliberately NOT a lighter grey than --muted: the previous
        // hardcoded #80868b measured 3.68:1 on white, which fails WCAG AA (4.5:1) for
        // normal text — and it was used at 10.5–11px. This value measures 4.65:1.
        subtle: '#70757a',
        danger: '#b3261e',
        dangerSoft: '#fce8e6',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        pill: '0 1px 6px rgba(32,33,36,.28)',
        card: '0 1px 2px rgba(60,64,67,.08), 0 1px 3px 1px rgba(60,64,67,.06)',
      },
      keyframes: {
        rise: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: { rise: 'rise .28s ease-out both' },
    },
  },
  plugins: [],
};
