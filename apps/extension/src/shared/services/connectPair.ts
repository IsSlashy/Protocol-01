/**
 * connectPair — the QR token for "connect a phone wallet TO this extension".
 *
 * Direction is the REVERSE of pairCrypto/LinkPhone: here the cameraless
 * extension SHOWS the QR and the phone SCANS it, then the phone uploads its
 * seed (sealed to a one-time code via pairCrypto) to the relay channel the
 * token names. The extension polls that channel and decrypts with the code the
 * user typed.
 *
 * Token: `p01conn1:<apiBase>|<channelId>`
 *   - apiBase    = https origin of the pairing relay (apps/web `/api/pair/:id`)
 *   - channelId  = random 80-bit base32 (pairCrypto code alphabet), the channel
 *
 * The token carries WHERE + WHICH channel but NOT the secret pairing code — the
 * code is shown on the extension and typed on the phone, so a filmed QR alone
 * can't decrypt the uploaded seed (same model as pairCrypto's `p01pair1:`).
 *
 * DUPLICATED BYTE-IDENTICALLY in apps/extension/src/shared/services/connectPair.ts
 * + apps/mobile/utils/crypto/connectPair.ts — keep identical.
 */
export const CONNECT_PREFIX = 'p01conn1:';

export function makeConnectToken(apiBase: string, channelId: string): string {
  return `${CONNECT_PREFIX}${apiBase.replace(/\/$/, '')}|${channelId}`;
}

export function isConnectQR(s: string): boolean {
  return typeof s === 'string' && s.startsWith(CONNECT_PREFIX);
}

export function parseConnectToken(s: string): { apiBase: string; channelId: string } | null {
  if (!isConnectQR(s)) return null;
  const rest = s.slice(CONNECT_PREFIX.length);
  const sep = rest.indexOf('|');
  if (sep < 0) return null;
  const apiBase = rest.slice(0, sep);
  const channelId = rest.slice(sep + 1);
  if (!/^https:\/\/[^|\s]+$/.test(apiBase)) return null; // only https relays
  if (!/^[A-Z2-7]{16,32}$/.test(channelId)) return null; // base32 channel id
  return { apiBase, channelId };
}
