/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,jsx,ts,tsx}',
    './components/**/*.{js,jsx,ts,tsx}',
  ],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // P-01 Design System
        p01: {
          // Backgrounds
          void: '#0a0a0c',
          dark: '#0f0f12',
          surface: '#151518',
          elevated: '#1a1a1f',
          // Primary: Cyan (NOT green, NOT purple)
          cyan: '#39c5bb',
          'cyan-bright': '#00ffe5',
          'cyan-dim': '#2a9d95',
          // Accent: Pink (NOT purple)
          pink: '#ff77a8',
          'pink-hot': '#ff2d7a',
          // Utility colors
          chrome: '#c0c0c8',
          yellow: '#ffcc00',
          red: '#ff3366',
          // Border
          border: '#2a2a30',
          // Text: NO black text
          text: '#ffffff',
          gray: '#888892',
          'text-muted': '#888892',
          'text-dim': '#555560',
        },
        // Module colors
        wallet: '#39c5bb',     // cyan
        streams: '#ff77a8',    // pink
        social: '#00ffe5',     // bright cyan
        agent: '#ffcc00',      // yellow
        // Status colors
        success: '#39c5bb',    // cyan (NOT green)
        warning: '#ffcc00',    // yellow
        error: '#ff3366',      // red
      },
      fontFamily: {
        display: ['Orbitron', 'system-ui', 'sans-serif'],
        mono: ['JetBrainsMono-Regular', 'monospace'],
        body: ['Inter-Regular', 'system-ui', 'sans-serif'],
        sans: ['Inter-Regular', 'system-ui', 'sans-serif'],
        medium: ['Inter-Medium', 'system-ui', 'sans-serif'],
        semibold: ['Inter-SemiBold', 'system-ui', 'sans-serif'],
        bold: ['Inter-Bold', 'system-ui', 'sans-serif'],
      },
      spacing: {
        'tab-bar': '85px',
        'safe-bottom': '34px',
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '24px',
      },
    },
  },
  plugins: [],
};
