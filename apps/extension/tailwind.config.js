/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./popup.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /**
         * P-01 / Styx design system.
         *
         * 🎯 REALIGNED ON THE WEB SYSTEM 2026-08-23. The token NAMES are
         * unchanged on purpose: ~15,000 lines of TSX reference `p01-void`,
         * `p01-text`, `p01-cyan` and friends. Retuning the VALUES moves the
         * whole extension onto the site's palette in one file, where a rename
         * would have meant touching every screen and getting some of them
         * wrong. The names are now the layer of indirection they always
         * pretended to be.
         *
         * Source of truth: apps/web/app/_styx/styx.css.
         *
         * 🚨 THE CHANGE THAT MATTERS MOST IS THE TEXT COLOUR. This palette used
         * pure #ffffff on a cool grey ground; the site uses a warm paper
         * #eae7df on a near-black ink. Side by side, pure white is what made
         * the extension read as a different product: it is colder, it glares
         * at popup size, and it belongs to a greyscale the site does not use.
         *
         * NO purple, NO black text, NO green. Added to that list: no
         * gold-and-violet "crypto" palette and no Orbitron, which is the
         * templated look every wallet reaches for.
         */
        p01: {
          // ── Grounds. Straight from --styx-ink / --styx-panel / --styx-panel-2.
          void: '#070709',      // was #0a0a0c — the site's ink
          dark: '#0d0d10',      // was #0f0f12 — the site's panel
          surface: '#101014',   // was #151518 — the site's second panel
          elevated: '#16161b',  // was #1a1a1f — one step above panel-2, extension only

          // ── Accent. Already shared with the site, unchanged.
          cyan: '#39c5bb',
          'cyan-bright': '#5fd8cf',  // was #00ffe5 — that neon never appears on the site
          'cyan-dim': '#2a9d95',

          // ⛔ PINK IS RETIRED. Founder ruling 2026-08-23: the site has no pink
          // and neither does this. It was the Streams module's colour and it
          // appeared in 18 files, so the tokens are ALIASED to cyan rather than
          // deleted: every one of those call sites lands on the palette
          // immediately, and none of them can be missed. Removing the keys
          // would have meant 18 edits and one of them would have been wrong.
          // ⚠️ Do not reintroduce these names in new code. They exist to retire
          // the old ones, not to be a second accent.
          pink: '#39c5bb',
          'pink-hot': '#2a9d95',

          // ── Utility.
          chrome: '#c0c0c8',
          amber: '#d9a24a',     // --styx-warn. The site's caution colour.
          yellow: '#d9a24a',    // alias, so existing `p01-yellow` usages land on amber
          red: '#e0574f',       // was #ff3366 — desaturated to sit on ink without vibrating
          blue: '#3b82f6',
          border: 'rgba(234, 231, 223, 0.14)',        // --styx-rule
          'border-light': 'rgba(234, 231, 223, 0.24)',
          'border-soft': 'rgba(234, 231, 223, 0.07)',  // --styx-rule-soft

          // ── Text. The heart of the realignment.
          text: '#eae7df',                            // --styx-paper, NOT #ffffff
          gray: 'rgba(234, 231, 223, 0.62)',          // --styx-muted
          'text-muted': 'rgba(234, 231, 223, 0.62)',
          'text-dim': 'rgba(234, 231, 223, 0.40)',    // --styx-faint
        },
        // Module colours. Streams keeps pink for continuity; the rest resolve
        // to the two colours the site actually uses.
        wallet: '#39c5bb',
        // Was pink. One accent, like the site.
        streams: '#39c5bb',
        social: '#39c5bb',
        agent: '#d9a24a',
        // Status. Cyan for success, never green.
        success: '#39c5bb',
        warning: '#d9a24a',
        error: '#e0574f',
      },
      fontFamily: {
        /**
         * ⛔ ORBITRON IS GONE. It was the display face here and it is the
         * single most templated choice in crypto UI, which is why the design
         * pass flagged it as an anti-pattern. The site sets display type in
         * Newsreader at weight 300, and a wallet that shares a brand should
         * share its voice.
         *
         * Loaded locally, not from a CDN: a Chrome extension runs under a
         * content security policy that blocks remote font hosts, and a silent
         * fallback to Georgia is exactly the kind of drift nobody notices.
         */
        display: ['Newsreader', 'Iowan Old Style', 'Palatino Linotype', 'Georgia', 'serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'Consolas', 'monospace'],
        body: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      fontSize: {
        // A real scale, so screens stop inventing sizes. Matches the site's
        // rhythm at popup dimensions.
        'micro': ['0.6875rem', { lineHeight: '1.4', letterSpacing: '0.16em' }], // eyebrows
        'tiny': ['0.75rem', { lineHeight: '1.5' }],
        'sm': ['0.8125rem', { lineHeight: '1.55' }],
        'base': ['0.9375rem', { lineHeight: '1.6' }],
        'lg': ['1.0625rem', { lineHeight: '1.45' }],
        'xl': ['1.375rem', { lineHeight: '1.25' }],
        '2xl': ['1.75rem', { lineHeight: '1.15' }],
        '3xl': ['2.25rem', { lineHeight: '1.05' }],
      },
      borderRadius: {
        // Tightened. The site has no large radii anywhere, and 24px corners at
        // 360px wide read as a toy.
        'lg': '10px',
        'xl': '12px',
        '2xl': '14px',
        '3xl': '16px',
      },
      backgroundImage: {
        // ⚠️ The neon gradients are retired. The site uses flat panels and a
        // single hairline rule; a gradient card in the popup was the other
        // half of "this is a different product". Kept as flat token pairs so
        // any surviving usage degrades to something on-palette.
        'p01-gradient-primary': 'linear-gradient(135deg, #39c5bb 0%, #2a9d95 100%)',
        'p01-gradient-pink': 'linear-gradient(135deg, #39c5bb 0%, #2a9d95 100%)',
        'p01-gradient-cyan': 'linear-gradient(135deg, #39c5bb 0%, #2a9d95 100%)',
        'p01-gradient-dark': 'linear-gradient(180deg, #0d0d10 0%, #070709 100%)',
        'p01-gradient-card': 'linear-gradient(180deg, #101014 0%, #0d0d10 100%)',
      },
      boxShadow: {
        'none': 'none',
        // One elevation step, used by sheets and menus only. The site has no
        // shadows; this exists so a floating layer is separable from the page
        // under it at popup size, which is the one place it is needed.
        'sheet': '0 -8px 32px rgba(0, 0, 0, 0.55)',
        'menu': '0 8px 24px rgba(0, 0, 0, 0.5)',
      },
      transitionDuration: {
        // Micro-interactions land in the 150 to 300ms band. Exits are shorter
        // than entrances so dismissing feels immediate.
        'enter': '220ms',
        'exit': '140ms',
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
