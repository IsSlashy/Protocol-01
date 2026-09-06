/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_ENDPOINT?: string;
  readonly VITE_HELIUS_API_KEY?: string;
  // Deployed apps/web origin hosting /api/pair/:id (phone→extension pairing relay).
  readonly VITE_PAIR_API_BASE?: string;
  // Deployed apps/web origin hosting /api/pool-leaves/:pool (the leaf indexer).
  // Falls back to VITE_PAIR_API_BASE, then https://protocol-01.dev.
  readonly VITE_P01_WEB_URL?: string;
  readonly VITEST?: string;
  // Add more env variables as needed
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
