/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./popup.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        p01: {
          void: '#0a0a0c',
          dark: '#0f0f12',
          surface: '#151518',
          elevated: '#1a1a1f',
          cyan: '#39c5bb',
          'cyan-bright': '#00ffe5',
          'cyan-dim': '#2a9d95',
          pink: '#ff2d7a',
          'pink-hot': '#ff2d7a',
          chrome: '#c0c0c8',
          yellow: '#ffcc00',
          red: '#ff3333',
          border: '#2a2a30',
        },
        wallet: '#39c5bb',
        streams: '#ff77a8',
        social: '#00ffe5',
        agent: '#ffcc00',
      },
      fontFamily: {
        display: ['Orbitron', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
        body: ['Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
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
