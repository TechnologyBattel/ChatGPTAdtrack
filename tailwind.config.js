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
        rise: { '0%': { opacity: '0', transform: 'translateY(8px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: { rise: 'rise .28s ease-out both' },
    },
  },
  plugins: [],
};
