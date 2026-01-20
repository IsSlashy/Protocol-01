// vite.config.ts
import { defineConfig } from "file:///P:/Specter%20Protocol/node_modules/.pnpm/vite@5.4.21_@types+node@20.19.30/node_modules/vite/dist/node/index.js";
import react from "file:///P:/Specter%20Protocol/node_modules/.pnpm/@vitejs+plugin-react@4.7.0_vite@5.4.21/node_modules/@vitejs/plugin-react/dist/index.js";
import { crx } from "file:///P:/Specter%20Protocol/node_modules/.pnpm/@crxjs+vite-plugin@2.3.0/node_modules/@crxjs/vite-plugin/dist/index.mjs";
import { resolve } from "path";
import { build } from "file:///P:/Specter%20Protocol/node_modules/.pnpm/esbuild@0.27.2/node_modules/esbuild/lib/main.js";

// manifest.json
var manifest_default = {
  manifest_version: 3,
  name: "Protocol 01",
  version: "0.1.0",
  description: "Privacy-first Solana wallet with stealth addresses and secure recurring payments",
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  action: {
    default_popup: "popup.html",
    default_title: "Protocol 01",
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png"
    }
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module"
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_start"
    }
  ],
  web_accessible_resources: [
    {
      resources: ["inject.js"],
      matches: ["<all_urls>"]
    }
  ],
  permissions: [
    "storage",
    "activeTab",
    "notifications",
    "tabs",
    "alarms"
  ],
  host_permissions: [
    "https://*.solana.com/*",
    "https://*.helius.dev/*",
    "https://*.triton.one/*"
  ],
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  }
};

// vite.config.ts
var __vite_injected_original_dirname = "P:\\Specter Protocol\\apps\\extension";
var buildInjectScript = () => ({
  name: "build-inject-script",
  async config() {
    await build({
      entryPoints: [resolve(__vite_injected_original_dirname, "src/inject/index.ts")],
      outfile: resolve(__vite_injected_original_dirname, "public/inject.js"),
      bundle: true,
      format: "iife",
      target: "es2020",
      minify: false
    });
  }
});
var vite_config_default = defineConfig({
  plugins: [
    buildInjectScript(),
    // Must run first
    react(),
    crx({ manifest: manifest_default })
  ],
  resolve: {
    alias: {
      "@": resolve(__vite_injected_original_dirname, "src"),
      // Polyfill Node.js modules for browser
      buffer: "buffer/",
      stream: "stream-browserify",
      crypto: "crypto-browserify"
    }
  },
  define: {
    // Define process for Node.js compatibility
    "process.env": {},
    "process.browser": true,
    "process.version": '""',
    "process.platform": '"browser"',
    global: "globalThis"
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: "globalThis"
      }
    },
    include: ["buffer", "process"]
  },
  build: {
    outDir: "dist",
    minify: false,
    commonjsOptions: {
      transformMixedEsModules: true
    },
    rollupOptions: {
      plugins: [
        // Inject polyfills
        {
          name: "node-polyfills",
          resolveId(id) {
            if (id === "process") {
              return "process";
            }
            return null;
          }
        }
      ]
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiLCAibWFuaWZlc3QuanNvbiJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIlA6XFxcXFNwZWN0ZXIgUHJvdG9jb2xcXFxcYXBwc1xcXFxleHRlbnNpb25cIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIlA6XFxcXFNwZWN0ZXIgUHJvdG9jb2xcXFxcYXBwc1xcXFxleHRlbnNpb25cXFxcdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL1A6L1NwZWN0ZXIlMjBQcm90b2NvbC9hcHBzL2V4dGVuc2lvbi92aXRlLmNvbmZpZy50c1wiO2ltcG9ydCB7IGRlZmluZUNvbmZpZyB9IGZyb20gJ3ZpdGUnO1xuaW1wb3J0IHJlYWN0IGZyb20gJ0B2aXRlanMvcGx1Z2luLXJlYWN0JztcbmltcG9ydCB7IGNyeCB9IGZyb20gJ0Bjcnhqcy92aXRlLXBsdWdpbic7XG5pbXBvcnQgeyByZXNvbHZlIH0gZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBidWlsZCB9IGZyb20gJ2VzYnVpbGQnO1xuaW1wb3J0IG1hbmlmZXN0IGZyb20gJy4vbWFuaWZlc3QuanNvbic7XG5cbi8vIEJ1aWxkIGluamVjdCBzY3JpcHQgdG8gcHVibGljIGZvbGRlciBiZWZvcmUgdml0ZSBydW5zXG5jb25zdCBidWlsZEluamVjdFNjcmlwdCA9ICgpID0+ICh7XG4gIG5hbWU6ICdidWlsZC1pbmplY3Qtc2NyaXB0JyxcbiAgYXN5bmMgY29uZmlnKCkge1xuICAgIC8vIEJ1aWxkIGluamVjdCBzY3JpcHQgdG8gcHVibGljIGZvbGRlciBzbyBjcnhqcyBjYW4gZmluZCBpdFxuICAgIGF3YWl0IGJ1aWxkKHtcbiAgICAgIGVudHJ5UG9pbnRzOiBbcmVzb2x2ZShfX2Rpcm5hbWUsICdzcmMvaW5qZWN0L2luZGV4LnRzJyldLFxuICAgICAgb3V0ZmlsZTogcmVzb2x2ZShfX2Rpcm5hbWUsICdwdWJsaWMvaW5qZWN0LmpzJyksXG4gICAgICBidW5kbGU6IHRydWUsXG4gICAgICBmb3JtYXQ6ICdpaWZlJyxcbiAgICAgIHRhcmdldDogJ2VzMjAyMCcsXG4gICAgICBtaW5pZnk6IGZhbHNlLFxuICAgIH0pO1xuICB9LFxufSk7XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIHBsdWdpbnM6IFtcbiAgICBidWlsZEluamVjdFNjcmlwdCgpLCAvLyBNdXN0IHJ1biBmaXJzdFxuICAgIHJlYWN0KCksXG4gICAgY3J4KHsgbWFuaWZlc3QgfSksXG4gIF0sXG4gIHJlc29sdmU6IHtcbiAgICBhbGlhczoge1xuICAgICAgJ0AnOiByZXNvbHZlKF9fZGlybmFtZSwgJ3NyYycpLFxuICAgICAgLy8gUG9seWZpbGwgTm9kZS5qcyBtb2R1bGVzIGZvciBicm93c2VyXG4gICAgICBidWZmZXI6ICdidWZmZXIvJyxcbiAgICAgIHN0cmVhbTogJ3N0cmVhbS1icm93c2VyaWZ5JyxcbiAgICAgIGNyeXB0bzogJ2NyeXB0by1icm93c2VyaWZ5JyxcbiAgICB9LFxuICB9LFxuICBkZWZpbmU6IHtcbiAgICAvLyBEZWZpbmUgcHJvY2VzcyBmb3IgTm9kZS5qcyBjb21wYXRpYmlsaXR5XG4gICAgJ3Byb2Nlc3MuZW52Jzoge30sXG4gICAgJ3Byb2Nlc3MuYnJvd3Nlcic6IHRydWUsXG4gICAgJ3Byb2Nlc3MudmVyc2lvbic6ICdcIlwiJyxcbiAgICAncHJvY2Vzcy5wbGF0Zm9ybSc6ICdcImJyb3dzZXJcIicsXG4gICAgZ2xvYmFsOiAnZ2xvYmFsVGhpcycsXG4gIH0sXG4gIG9wdGltaXplRGVwczoge1xuICAgIGVzYnVpbGRPcHRpb25zOiB7XG4gICAgICBkZWZpbmU6IHtcbiAgICAgICAgZ2xvYmFsOiAnZ2xvYmFsVGhpcycsXG4gICAgICB9LFxuICAgIH0sXG4gICAgaW5jbHVkZTogWydidWZmZXInLCAncHJvY2VzcyddLFxuICB9LFxuICBidWlsZDoge1xuICAgIG91dERpcjogJ2Rpc3QnLFxuICAgIG1pbmlmeTogZmFsc2UsXG4gICAgY29tbW9uanNPcHRpb25zOiB7XG4gICAgICB0cmFuc2Zvcm1NaXhlZEVzTW9kdWxlczogdHJ1ZSxcbiAgICB9LFxuICAgIHJvbGx1cE9wdGlvbnM6IHtcbiAgICAgIHBsdWdpbnM6IFtcbiAgICAgICAgLy8gSW5qZWN0IHBvbHlmaWxsc1xuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ25vZGUtcG9seWZpbGxzJyxcbiAgICAgICAgICByZXNvbHZlSWQoaWQpIHtcbiAgICAgICAgICAgIGlmIChpZCA9PT0gJ3Byb2Nlc3MnKSB7XG4gICAgICAgICAgICAgIHJldHVybiAncHJvY2Vzcyc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9LFxuICB9LFxufSk7XG4iLCAie1xuICBcIm1hbmlmZXN0X3ZlcnNpb25cIjogMyxcbiAgXCJuYW1lXCI6IFwiUHJvdG9jb2wgMDFcIixcbiAgXCJ2ZXJzaW9uXCI6IFwiMC4xLjBcIixcbiAgXCJkZXNjcmlwdGlvblwiOiBcIlByaXZhY3ktZmlyc3QgU29sYW5hIHdhbGxldCB3aXRoIHN0ZWFsdGggYWRkcmVzc2VzIGFuZCBzZWN1cmUgcmVjdXJyaW5nIHBheW1lbnRzXCIsXG4gIFwiaWNvbnNcIjoge1xuICAgIFwiMTZcIjogXCJpY29ucy9pY29uLTE2LnBuZ1wiLFxuICAgIFwiMzJcIjogXCJpY29ucy9pY29uLTMyLnBuZ1wiLFxuICAgIFwiNDhcIjogXCJpY29ucy9pY29uLTQ4LnBuZ1wiLFxuICAgIFwiMTI4XCI6IFwiaWNvbnMvaWNvbi0xMjgucG5nXCJcbiAgfSxcbiAgXCJhY3Rpb25cIjoge1xuICAgIFwiZGVmYXVsdF9wb3B1cFwiOiBcInBvcHVwLmh0bWxcIixcbiAgICBcImRlZmF1bHRfdGl0bGVcIjogXCJQcm90b2NvbCAwMVwiLFxuICAgIFwiZGVmYXVsdF9pY29uXCI6IHtcbiAgICAgIFwiMTZcIjogXCJpY29ucy9pY29uLTE2LnBuZ1wiLFxuICAgICAgXCIzMlwiOiBcImljb25zL2ljb24tMzIucG5nXCIsXG4gICAgICBcIjQ4XCI6IFwiaWNvbnMvaWNvbi00OC5wbmdcIlxuICAgIH1cbiAgfSxcbiAgXCJiYWNrZ3JvdW5kXCI6IHtcbiAgICBcInNlcnZpY2Vfd29ya2VyXCI6IFwic3JjL2JhY2tncm91bmQvaW5kZXgudHNcIixcbiAgICBcInR5cGVcIjogXCJtb2R1bGVcIlxuICB9LFxuICBcImNvbnRlbnRfc2NyaXB0c1wiOiBbXG4gICAge1xuICAgICAgXCJtYXRjaGVzXCI6IFtcIjxhbGxfdXJscz5cIl0sXG4gICAgICBcImpzXCI6IFtcInNyYy9jb250ZW50L2luZGV4LnRzXCJdLFxuICAgICAgXCJydW5fYXRcIjogXCJkb2N1bWVudF9zdGFydFwiXG4gICAgfVxuICBdLFxuICBcIndlYl9hY2Nlc3NpYmxlX3Jlc291cmNlc1wiOiBbXG4gICAge1xuICAgICAgXCJyZXNvdXJjZXNcIjogW1wiaW5qZWN0LmpzXCJdLFxuICAgICAgXCJtYXRjaGVzXCI6IFtcIjxhbGxfdXJscz5cIl1cbiAgICB9XG4gIF0sXG4gIFwicGVybWlzc2lvbnNcIjogW1xuICAgIFwic3RvcmFnZVwiLFxuICAgIFwiYWN0aXZlVGFiXCIsXG4gICAgXCJub3RpZmljYXRpb25zXCIsXG4gICAgXCJ0YWJzXCIsXG4gICAgXCJhbGFybXNcIlxuICBdLFxuICBcImhvc3RfcGVybWlzc2lvbnNcIjogW1xuICAgIFwiaHR0cHM6Ly8qLnNvbGFuYS5jb20vKlwiLFxuICAgIFwiaHR0cHM6Ly8qLmhlbGl1cy5kZXYvKlwiLFxuICAgIFwiaHR0cHM6Ly8qLnRyaXRvbi5vbmUvKlwiXG4gIF0sXG4gIFwiY29udGVudF9zZWN1cml0eV9wb2xpY3lcIjoge1xuICAgIFwiZXh0ZW5zaW9uX3BhZ2VzXCI6IFwic2NyaXB0LXNyYyAnc2VsZicgJ3dhc20tdW5zYWZlLWV2YWwnOyBvYmplY3Qtc3JjICdzZWxmJ1wiXG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBa1MsU0FBUyxvQkFBb0I7QUFDL1QsT0FBTyxXQUFXO0FBQ2xCLFNBQVMsV0FBVztBQUNwQixTQUFTLGVBQWU7QUFDeEIsU0FBUyxhQUFhOzs7QUNKdEI7QUFBQSxFQUNFLGtCQUFvQjtBQUFBLEVBQ3BCLE1BQVE7QUFBQSxFQUNSLFNBQVc7QUFBQSxFQUNYLGFBQWU7QUFBQSxFQUNmLE9BQVM7QUFBQSxJQUNQLE1BQU07QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxFQUNUO0FBQUEsRUFDQSxRQUFVO0FBQUEsSUFDUixlQUFpQjtBQUFBLElBQ2pCLGVBQWlCO0FBQUEsSUFDakIsY0FBZ0I7QUFBQSxNQUNkLE1BQU07QUFBQSxNQUNOLE1BQU07QUFBQSxNQUNOLE1BQU07QUFBQSxJQUNSO0FBQUEsRUFDRjtBQUFBLEVBQ0EsWUFBYztBQUFBLElBQ1osZ0JBQWtCO0FBQUEsSUFDbEIsTUFBUTtBQUFBLEVBQ1Y7QUFBQSxFQUNBLGlCQUFtQjtBQUFBLElBQ2pCO0FBQUEsTUFDRSxTQUFXLENBQUMsWUFBWTtBQUFBLE1BQ3hCLElBQU0sQ0FBQyxzQkFBc0I7QUFBQSxNQUM3QixRQUFVO0FBQUEsSUFDWjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLDBCQUE0QjtBQUFBLElBQzFCO0FBQUEsTUFDRSxXQUFhLENBQUMsV0FBVztBQUFBLE1BQ3pCLFNBQVcsQ0FBQyxZQUFZO0FBQUEsSUFDMUI7QUFBQSxFQUNGO0FBQUEsRUFDQSxhQUFlO0FBQUEsSUFDYjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBQUEsRUFDQSxrQkFBb0I7QUFBQSxJQUNsQjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQUFBLEVBQ0EseUJBQTJCO0FBQUEsSUFDekIsaUJBQW1CO0FBQUEsRUFDckI7QUFDRjs7O0FEcERBLElBQU0sbUNBQW1DO0FBUXpDLElBQU0sb0JBQW9CLE9BQU87QUFBQSxFQUMvQixNQUFNO0FBQUEsRUFDTixNQUFNLFNBQVM7QUFFYixVQUFNLE1BQU07QUFBQSxNQUNWLGFBQWEsQ0FBQyxRQUFRLGtDQUFXLHFCQUFxQixDQUFDO0FBQUEsTUFDdkQsU0FBUyxRQUFRLGtDQUFXLGtCQUFrQjtBQUFBLE1BQzlDLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxJQUNWLENBQUM7QUFBQSxFQUNIO0FBQ0Y7QUFFQSxJQUFPLHNCQUFRLGFBQWE7QUFBQSxFQUMxQixTQUFTO0FBQUEsSUFDUCxrQkFBa0I7QUFBQTtBQUFBLElBQ2xCLE1BQU07QUFBQSxJQUNOLElBQUksRUFBRSwyQkFBUyxDQUFDO0FBQUEsRUFDbEI7QUFBQSxFQUNBLFNBQVM7QUFBQSxJQUNQLE9BQU87QUFBQSxNQUNMLEtBQUssUUFBUSxrQ0FBVyxLQUFLO0FBQUE7QUFBQSxNQUU3QixRQUFRO0FBQUEsTUFDUixRQUFRO0FBQUEsTUFDUixRQUFRO0FBQUEsSUFDVjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLFFBQVE7QUFBQTtBQUFBLElBRU4sZUFBZSxDQUFDO0FBQUEsSUFDaEIsbUJBQW1CO0FBQUEsSUFDbkIsbUJBQW1CO0FBQUEsSUFDbkIsb0JBQW9CO0FBQUEsSUFDcEIsUUFBUTtBQUFBLEVBQ1Y7QUFBQSxFQUNBLGNBQWM7QUFBQSxJQUNaLGdCQUFnQjtBQUFBLE1BQ2QsUUFBUTtBQUFBLFFBQ04sUUFBUTtBQUFBLE1BQ1Y7QUFBQSxJQUNGO0FBQUEsSUFDQSxTQUFTLENBQUMsVUFBVSxTQUFTO0FBQUEsRUFDL0I7QUFBQSxFQUNBLE9BQU87QUFBQSxJQUNMLFFBQVE7QUFBQSxJQUNSLFFBQVE7QUFBQSxJQUNSLGlCQUFpQjtBQUFBLE1BQ2YseUJBQXlCO0FBQUEsSUFDM0I7QUFBQSxJQUNBLGVBQWU7QUFBQSxNQUNiLFNBQVM7QUFBQTtBQUFBLFFBRVA7QUFBQSxVQUNFLE1BQU07QUFBQSxVQUNOLFVBQVUsSUFBSTtBQUNaLGdCQUFJLE9BQU8sV0FBVztBQUNwQixxQkFBTztBQUFBLFlBQ1Q7QUFDQSxtQkFBTztBQUFBLFVBQ1Q7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
