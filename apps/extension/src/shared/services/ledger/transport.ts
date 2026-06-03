/**
 * Ledger transport for the EXTENSION — WebHID primary, WebUSB fallback.
 *
 * HARD CONSTRAINTS (docs/pairing-ledger-spec.md §1B, Finding #17):
 *   - `navigator.hid.requestDevice()` (what `TransportWebHID.request()` triggers)
 *     CANNOT run in the service worker (no user gesture / DOM), CANNOT run in an
 *     offscreen document (no HID reason, non-interactive), MUST NOT run in an
 *     iframe (permissions-policy `hid` is blocked) and MUST NOT run in the toolbar
 *     popup (it dies on focus loss). It MUST run on a dedicated full extension TAB
 *     (popup.html#/connect-ledger opened via chrome.tabs.create). This module is
 *     therefore only ever imported from that tab page.
 *   - WebHID needs NO manifest permission and NO manifest key. We do not touch
 *     manifest.json. The CSP `script-src 'self' 'wasm-unsafe-eval'` is fine.
 *   - ONE long-lived transport per tab. We never create/destroy a transport per
 *     call (Brave #19480 flicker). The connect tab holds the session across the
 *     entire connect → sign lifecycle; the proof window (~2 min) runs elsewhere
 *     and the device is only prompted after the proof is ready (Finding #13).
 *
 * The concrete transport classes are imported lazily so that merely importing
 * the signer/seed helpers (e.g. from the service worker for type-only use) does
 * not pull WebHID into a non-tab context.
 */

import type Transport from '@ledgerhq/hw-transport';

/** Thrown when neither WebHID nor WebUSB is available in this context. */
export class LedgerTransportUnsupportedError extends Error {
  constructor() {
    super(
      'This browser does not support WebHID or WebUSB. Connect a Ledger from a ' +
        'Chromium-based browser (Chrome, Brave, Edge) on desktop.',
    );
    this.name = 'LedgerTransportUnsupportedError';
  }
}

/** Thrown when a transport request was made outside a tab (popup / SW / iframe). */
export class LedgerTransportContextError extends Error {
  constructor() {
    super(
      'Ledger can only be connected from a dedicated tab. Open the Connect Ledger ' +
        'page in a full tab and try again.',
    );
    this.name = 'LedgerTransportContextError';
  }
}

let activeTransport: Transport | null = null;

/**
 * True if WebHID is usable here. Gates the connect UI (spec §1B). Returns false
 * in any non-WebHID context without throwing.
 */
export async function isWebHidSupported(): Promise<boolean> {
  try {
    const { default: TransportWebHID } = await import('@ledgerhq/hw-transport-webhid');
    return await TransportWebHID.isSupported();
  } catch {
    return false;
  }
}

/** True if WebUSB is usable here (fallback for browsers without WebHID). */
export async function isWebUsbSupported(): Promise<boolean> {
  try {
    const { default: TransportWebUSB } = await import('@ledgerhq/hw-transport-webusb');
    return await TransportWebUSB.isSupported();
  } catch {
    return false;
  }
}

/** True if EITHER transport is supported — gates whether to show the connect CTA. */
export async function isLedgerSupported(): Promise<boolean> {
  if (await isWebHidSupported()) return true;
  return isWebUsbSupported();
}

/**
 * Heuristic guard: the request must be triggered from a tab page, not the popup
 * or the SW. We can't perfectly detect a tab, but we CAN reject the obviously
 * wrong contexts (no `document` / `navigator`). The connect page also passes a
 * deliberate `userGesture` to make the intent explicit.
 */
function assertInteractiveContext(): void {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') {
    throw new LedgerTransportContextError();
  }
}

/**
 * Open (or reuse) the long-lived transport for this tab.
 *
 * Tries WebHID first (with the device-permission prompt), falling back to WebUSB
 * if WebHID is unavailable. The returned transport is cached and reused for every
 * subsequent call on this page; call {@link closeLedgerTransport} on teardown.
 *
 * MUST be called from a user gesture handler on the connect tab.
 */
export async function openLedgerTransport(): Promise<Transport> {
  assertInteractiveContext();

  if (activeTransport) return activeTransport;

  // WebHID primary.
  if (await isWebHidSupported()) {
    const { default: TransportWebHID } = await import('@ledgerhq/hw-transport-webhid');
    // Reuse an already-permitted device without re-prompting if possible.
    const existing = await TransportWebHID.openConnected().catch(() => null);
    activeTransport = existing ?? (await TransportWebHID.request());
    wireDisconnect(activeTransport);
    return activeTransport;
  }

  // WebUSB fallback.
  if (await isWebUsbSupported()) {
    const { default: TransportWebUSB } = await import('@ledgerhq/hw-transport-webusb');
    const existing = await TransportWebUSB.openConnected?.().catch(() => null);
    activeTransport = existing ?? (await TransportWebUSB.request());
    wireDisconnect(activeTransport);
    return activeTransport;
  }

  throw new LedgerTransportUnsupportedError();
}

/** Returns the currently-open transport or null (no implicit open). */
export function getActiveLedgerTransport(): Transport | null {
  return activeTransport;
}

/**
 * Close + drop the cached transport. Safe to call when none is open. Call on tab
 * teardown / explicit disconnect so the next connect starts clean.
 */
export async function closeLedgerTransport(): Promise<void> {
  const t = activeTransport;
  activeTransport = null;
  if (!t) return;
  try {
    await t.close();
  } catch {
    // Best-effort — device may already be physically unplugged.
  }
}

/** Drop our cached reference if the device announces a disconnect. */
function wireDisconnect(transport: Transport): void {
  try {
    transport.on('disconnect', () => {
      if (activeTransport === transport) activeTransport = null;
    });
  } catch {
    // Some transport builds may not expose `on`; ignore.
  }
}
