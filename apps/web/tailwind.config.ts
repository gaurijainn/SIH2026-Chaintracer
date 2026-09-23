import type { Config } from 'tailwindcss';

const token = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

/** Every colour comes from a CSS variable in src/index.css, so themes (dark / light / print) swap in one place. */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: token('background'),
        foreground: token('foreground'),
        card: { DEFAULT: token('card'), foreground: token('card-foreground') },
        popover: { DEFAULT: token('popover'), foreground: token('popover-foreground') },
        muted: { DEFAULT: token('muted'), foreground: token('muted-foreground') },
        border: token('border'),
        input: token('input'),
        ring: token('ring'),
        primary: { DEFAULT: token('primary'), foreground: token('primary-foreground') },
        secondary: { DEFAULT: token('secondary'), foreground: token('secondary-foreground') },
        accent: { DEFAULT: token('accent'), foreground: token('accent-foreground') },
        sidebar: { DEFAULT: token('sidebar'), foreground: token('sidebar-foreground'), border: token('sidebar-border') },
        risk: {
          low: token('risk-low'),
          'low-soft': token('risk-low-soft'),
          medium: token('risk-medium'),
          'medium-soft': token('risk-medium-soft'),
          high: token('risk-high'),
          'high-soft': token('risk-high-soft'),
          critical: token('risk-critical'),
          'critical-soft': token('risk-critical-soft'),
        },
        chain: {
          tron: token('chain-tron'),
          eth: token('chain-eth'),
          bsc: token('chain-bsc'),
          polygon: token('chain-polygon'),
          btc: token('chain-btc'),
        },
        info: { DEFAULT: token('info'), soft: token('info-soft') },
      },
      borderRadius: { lg: '0.5rem', md: '0.375rem', sm: '0.25rem' },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Cascadia Mono', 'Consolas', 'monospace'],
      },
      keyframes: {
        'page-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
        'toast-in': { from: { opacity: '0', transform: 'translateX(8px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: { 'page-in': 'page-in 160ms ease-out', 'toast-in': 'toast-in 160ms ease-out' },
    },
  },
  plugins: [],
} satisfies Config;
