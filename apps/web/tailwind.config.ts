import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Protocol 01 Color System
        p01: {
          void: "#0a0a0c",
          dark: "#0f0f12",
          surface: "#151518",
          "surface-2": "#1a1a1e",
          border: "#2a2a30",
          "border-hover": "#3a3a42",
          // Primary
          cyan: "#39c5bb",
          "cyan-dim": "#2a9d95",
          // Accents
          pink: "#ff77a8",
          "bright-cyan": "#00ffe5",
          yellow: "#ffcc00",
          red: "#ff3366",
          // Text
          text: "#ffffff",
          "text-muted": "#888892",
          "text-dim": "#555560",
        },
        // Legacy support - redirect specter colors to p01
        specter: {
          bg: "#0a0a0c",
          surface: "#151518",
          "surface-2": "#1a1a1e",
          border: "#2a2a30",
          "border-hover": "#3a3a42",
          green: "#39c5bb",
          "green-dark": "#2a9d95",
          purple: "#ff77a8",
          blue: "#00ffe5",
          orange: "#ffcc00",
          red: "#ff3366",
          text: "#ffffff",
          "text-muted": "#888892",
          "text-dim": "#555560",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        heading: ["'Orbitron'", "var(--font-space-grotesk)", "system-ui", "sans-serif"],
        display: ["'Orbitron'", "var(--font-space-grotesk)", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "'Courier New'", "monospace"],
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":
          "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
        "gradient-p01":
          "linear-gradient(135deg, #39c5bb 0%, #ff77a8 50%, #00ffe5 100%)",
        "gradient-specter":
          "linear-gradient(135deg, #39c5bb 0%, #ff77a8 50%, #00ffe5 100%)",
        "grid-pattern":
          "linear-gradient(to right, rgba(57, 197, 187, 0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(57, 197, 187, 0.05) 1px, transparent 1px)",
      },
      backgroundSize: {
        grid: "40px 40px",
      },
      animation: {
        "pulse-slow": "pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "float": "float 3s ease-in-out infinite",
        "glow": "glow 2s ease-in-out infinite alternate",
        "typing": "typing 3s steps(40) forwards",
        "blink": "blink 1s step-end infinite",
        "scan": "scan-line 8s linear infinite",
        "fade-in": "fade-in 0.5s ease-out forwards",
        "fade-in-up": "fade-in-up 0.6s ease-out forwards",
        "slide-up": "slide-up 0.5s ease-out forwards",
        "slide-down": "slide-down 0.5s ease-out forwards",
        "scale-in": "scale-in 0.3s ease-out forwards",
        "shimmer": "shimmer 2s infinite",
        "gradient": "gradient 8s linear infinite",
        "glitch": "glitch-skew 1s infinite linear alternate-reverse",
        "flicker": "flicker 4s linear infinite",
        "chrome": "chrome-shine 3s ease-in-out infinite",
      },
      keyframes: {
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-10px)" },
        },
        glow: {
          "0%": { boxShadow: "0 0 20px rgba(57, 197, 187, 0.3)" },
          "100%": { boxShadow: "0 0 40px rgba(57, 197, 187, 0.6)" },
        },
        typing: {
          from: { width: "0" },
          to: { width: "100%" },
        },
        blink: {
          "0%, 50%": { opacity: "1" },
          "51%, 100%": { opacity: "0" },
        },
        "scan-line": {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100vh)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(20px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-up": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
        "slide-down": {
          from: { transform: "translateY(-100%)" },
          to: { transform: "translateY(0)" },
        },
        "scale-in": {
          from: { transform: "scale(0.9)", opacity: "0" },
          to: { transform: "scale(1)", opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        gradient: {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        "glitch-skew": {
          "0%": { transform: "skew(0deg)" },
          "10%": { transform: "skew(0.5deg)" },
          "20%": { transform: "skew(-0.5deg)" },
          "30%": { transform: "skew(0.3deg)" },
          "40%": { transform: "skew(-0.3deg)" },
          "50%": { transform: "skew(0deg)" },
          "60%": { transform: "skew(-0.2deg)" },
          "70%": { transform: "skew(0.2deg)" },
          "80%": { transform: "skew(-0.4deg)" },
          "90%": { transform: "skew(0.4deg)" },
          "100%": { transform: "skew(0deg)" },
        },
        flicker: {
          "0%, 100%": { opacity: "1" },
          "3%": { opacity: "0.4" },
          "6%": { opacity: "1" },
          "7%": { opacity: "0.4" },
          "8%": { opacity: "1" },
          "9%": { opacity: "0.4" },
          "10%": { opacity: "1" },
          "89%": { opacity: "1" },
          "90%": { opacity: "0.4" },
        },
        "chrome-shine": {
          "0%, 100%": { backgroundPosition: "0% 0%" },
          "50%": { backgroundPosition: "0% 100%" },
        },
      },
      boxShadow: {
        "glow-cyan": "0 0 20px rgba(57, 197, 187, 0.3), 0 0 40px rgba(57, 197, 187, 0.2)",
        "glow-cyan-lg": "0 0 30px rgba(57, 197, 187, 0.4), 0 0 60px rgba(57, 197, 187, 0.3)",
        "glow-pink": "0 0 20px rgba(255, 119, 168, 0.3), 0 0 40px rgba(255, 119, 168, 0.2)",
        "glow-yellow": "0 0 20px rgba(255, 204, 0, 0.3), 0 0 40px rgba(255, 204, 0, 0.2)",
        // Legacy support
        "glow-green": "0 0 20px rgba(57, 197, 187, 0.3), 0 0 40px rgba(57, 197, 187, 0.2)",
        "glow-green-lg": "0 0 30px rgba(57, 197, 187, 0.4), 0 0 60px rgba(57, 197, 187, 0.3)",
        "glow-purple": "0 0 20px rgba(255, 119, 168, 0.3), 0 0 40px rgba(255, 119, 168, 0.2)",
        "glow-blue": "0 0 20px rgba(0, 255, 229, 0.3), 0 0 40px rgba(0, 255, 229, 0.2)",
      },
      borderRadius: {
        "4xl": "2rem",
      },
      transitionDuration: {
        "400": "400ms",
      },
    },
  },
  plugins: [],
};

export default config;
