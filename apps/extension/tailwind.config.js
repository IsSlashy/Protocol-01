/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./popup.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // P-01 Design System — kept in lockstep with apps/mobile
        // (tailwind.config.js + constants/theme.ts).
        // NO purple, NO black text, NO green (#00ff88 / emerald).
        p01: {
          // Backgrounds
          void: '#0a0a0c',
          dark: '#0f0f12',
          surface: '#151518',
          elevated: '#1a1a1f',
          // Primary accent: Cyan
          cyan: '#39c5bb',
          'cyan-bright': '#00ffe5',
          'cyan-dim': '#2a9d95',
          // Accent: Pink
          pink: '#ff77a8',
          'pink-hot': '#ff2d7a',
          // Utility
          chrome: '#c0c0c8',
          yellow: '#ffcc00',
          red: '#ff3366',
          blue: '#3b82f6',
          border: '#2a2a30',
          'border-light': '#3a3a40',
          // Text: NO black text
          text: '#ffffff',
          gray: '#888892',
          'text-muted': '#888892',
          'text-dim': '#555560',
        },
        // Module colors
        wallet: '#39c5bb',
        streams: '#ff77a8',
        social: '#00ffe5',
        agent: '#ffcc00',
        // Status colors (cyan for success — NOT green)
        success: '#39c5bb',
        warning: '#ffcc00',
        error: '#ff3366',
      },
      fontFamily: {
        display: ['Orbitron', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
        body: ['Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '24px',
      },
      backgroundImage: {
        // P-01 gradients — web equivalents of mobile's LinearGradient arrays.
        'p01-gradient-primary': 'linear-gradient(135deg, #39c5bb 0%, #00ffe5 100%)',
        'p01-gradient-pink': 'linear-gradient(135deg, #ff77a8 0%, #ff2d7a 100%)',
        'p01-gradient-cyan': 'linear-gradient(135deg, #00ffe5 0%, #39c5bb 100%)',
        'p01-gradient-dark': 'linear-gradient(180deg, #0f0f12 0%, #0a0a0c 100%)',
        'p01-gradient-card': 'linear-gradient(180deg, #151518 0%, #0f0f12 100%)',
      },
      boxShadow: {
        'none': 'none',
      },
      animation: {
        'scanlines': 'scanlines 8s linear infinite',
      },
      keyframes: {
        scanlines: {
          '0%': { backgroundPosition: '0 0' },
          '100%': { backgroundPosition: '0 100%' },
        },
      },
    },
  },
  plugins: [],
};
