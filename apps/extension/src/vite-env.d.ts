/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_ENDPOINT?: string;
  readonly VITE_HELIUS_API_KEY?: string;
  // Deployed apps/web origin hosting /api/pair/:id (phone→extension pairing relay).
  readonly VITE_PAIR_API_BASE?: string;
  // Add more env variables as needed
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
