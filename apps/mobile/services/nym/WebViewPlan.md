# Nym on Mobile — WebView Implementation Plan (Phase 2)

## Problem

The Nym TypeScript SDK (`@nymproject/mix-fetch-full-fat`, `@nymproject/sdk-full-fat`)
is officially **browser-only**. It depends on:

- Native browser `WebSocket` (for gateway connections)
- A WASM module loaded via `fetch()` + `WebAssembly.instantiate`
- A Web Worker for the mixnet client runtime
- `BroadcastChannel` / `MessageChannel` for worker IPC

React Native provides none of these natively. Metro will not even bundle the
package (it ships `.wasm` imports and worker bootstrap code that break the
RN bundler). Trying `npm install @nymproject/mix-fetch-full-fat` here would
immediately break `expo start`.

A proper "real" fix is either:

1. A **WebView-based wrapper** — mount a hidden WebView with a bundled
   HTML+WASM payload and proxy `fetch` calls through it via `postMessage`.
   This is the approach we already use for the STARK prover (see
   `apps/mobile/services/stark/StarkProver.tsx` + `providers/StarkProverProvider.tsx`).
2. A **native Rust/Go port** of the Nym client exposed via a turbomodule.
   Upstream Nym does not ship such bindings yet, so this is a multi-week
   R&D project.

This document covers option (1), which is the realistic Phase 2.

## Architecture

```
┌─────────────────────────────┐        ┌────────────────────────────┐
│ React Native app (JS)       │        │ Hidden WebView             │
│                             │◄──────►│                            │
│  NymProvider (context)      │  post  │  <script src="nym.js">     │
│    └─ NymClient.tsx         │ Message│   - loads nym-wasm.wasm    │
│        ┌── WebView ref      │        │   - opens WS to gateway    │
│        └── pendingRequests  │        │   - exposes fetch handler  │
└─────────────────────────────┘        └────────────────────────────┘
         ▲                                        │
         │                                        ▼
    call sites (nymFetch)           Nym mixnet (5-hop Sphinx packets)
```

Mirror the STARK pattern exactly:

- `services/nym/NymClient.tsx` — `forwardRef` component rendering a hidden
  `<WebView>` (1x1, `pointerEvents="none"`, absolutely positioned offscreen).
- `providers/NymProvider.tsx` — React context that owns a `ref` to
  `NymClient` and a `Map<requestId, { resolve, reject, timer }>` of pending
  requests. Expose `{ isReady, nymFetch, state, error }`.
- Messages RN → WebView: `{ type: 'nym-init' }`, `{ type: 'nym-fetch', id, url, options }`.
- Messages WebView → RN: `{ type: 'ready' }`, `{ type: 'nym-state', state, entryGatewayId }`,
  `{ type: 'nym-result', id, status, headers, body }`, `{ type: 'nym-error', id, error }`.

## Bundling the WASM

Nym's WASM is ~2–5 MB. Same options as STARK's 82 KB module:

- **Base64 in a TypeScript file** (`services/nym/nymWasmData.ts`) —
  simplest, works out of the box. 5 MB → ~6.7 MB base64 string; adds ~6.7 MB
  to the JS bundle. Acceptable for a privacy feature users opt into.
- **Expo Asset** — store as `assets/nym-wasm.wasm`, resolve via
  `require(...)` + `Asset.fromModule().downloadAsync()`, then read as base64
  with `FileSystem.readAsStringAsync`. Avoids bloating the JS bundle.

Recommended: start with base64 for the first working version, switch to
Asset before shipping to production.

## Bootstrap dependency

The mixnet client bootstraps by fetching a topology from the Nym validator
API at `https://validator.nymtech.net/api`. The WebView already has network
access, so no extra native permissions are needed on Android. On iOS the
app's ATS settings already permit arbitrary HTTPS.

For resilience, pin the validator URL behind a config flag and allow users
to override (same pattern as our RPC endpoint config).

## API surface to preserve

The client in `services/nym/client.ts` already exposes:

- `initNym(): Promise<NymMetadata>`
- `nymFetch<T>(url, options): Promise<NymFetchResult<T>>`
- `getNymState(): NymMetadata`
- `onNymStateChange(listener): () => void`
- `resetNym(): void`

Phase 2 must keep these signatures byte-compatible. The only differences
will be:

- `initNym` resolves instead of rejecting, and transitions the state
  through `initializing` → `ready`.
- `nymFetch` routes through the WebView when `state === 'ready'`, sets
  `viaMixnet: true` and `strategy: 'webview-wasm'`.
- On failure (gateway drop, timeout), fall back to plain `fetch` and set
  `viaMixnet: false` — NEVER silently pretend mixnet worked.

## Security considerations

- **Origin whitelist**: `originWhitelist={['file://']}` and CSP meta tag
  restricting `connect-src` to the Nym validator + gateway hosts, just like
  StarkProver does.
- **No `eval`**: WASM only, no dynamic script evaluation.
- **Request sanitization**: forward only `method`, `url`, `headers`, `body`.
  Do NOT forward `credentials` / cookies — the whole point is to unlink
  identity.
- **Timeout**: each `nymFetch` gets a 30s hard timeout (mixnet adds latency;
  STARK uses 60s for proofs, 30s is fine for HTTP).
- **Teardown**: close the WebView on app background (AppState listener).
  Nym gateways keep connections open and each open gateway is a potential
  linkability anchor.

## Estimated effort

Realistic estimate, assuming no Nym upstream surprises:

- WebView HTML harness + WASM loader glue ............ 4 h
- postMessage protocol + pending-request map ......... 4 h
- Expo Asset wiring for WASM ......................... 3 h
- Context + hook + error plumbing .................... 3 h
- AppState teardown + reconnect logic ................ 3 h
- Testing on real Android + iOS devices .............. 6 h
- Debugging upstream Nym quirks (there will be some).. 5 h

**Total: ~28 h** (~3.5 focused days) for a robust first version.

## TODO checklist

- [ ] Evaluate `@nymproject/mix-fetch-full-fat` bundle size after
      minification — decide base64 vs Asset.
- [ ] Write `services/nym/NymClient.tsx` mirroring
      `services/stark/StarkProver.tsx`.
- [ ] Write `providers/NymProvider.tsx` mirroring `StarkProverProvider.tsx`.
- [ ] Replace the `initNym` body in `services/nym/client.ts` with a call
      into the provider's imperative handle.
- [ ] Replace the `nymFetch` body with postMessage round-trip; keep the
      plain-fetch fallback as a catch-all.
- [ ] Wire `<NymProvider>` into `app/_layout.tsx` next to `StarkProverProvider`.
- [ ] Add an Expo Asset entry for the WASM once size is known.
- [ ] Expose a settings toggle in the Privacy screen: "Route sensitive
      traffic through Nym mixnet".
- [ ] Update `NymStatusBadge` to reflect `state === 'ready'` vs `'unsupported'`.
- [ ] Document battery / latency trade-offs in the user-facing info modal.
- [ ] Remove the honest "Phase 2" notice from `apps/mobile/README.md`.
