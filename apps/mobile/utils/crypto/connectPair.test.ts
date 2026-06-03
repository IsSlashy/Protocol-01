// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { makeConnectToken, parseConnectToken, isConnectQR, CONNECT_PREFIX } from './connectPair';

const CH = 'ABCDEFGHIJKLMNOP'; // 16-char base32 channel id (A-Z2-7 alphabet)

describe('connectPair token', () => {
  it('round-trips apiBase + channelId', () => {
    const tok = makeConnectToken('https://app.example.com', CH);
    expect(tok.startsWith(CONNECT_PREFIX)).toBe(true);
    expect(isConnectQR(tok)).toBe(true);
    const parsed = parseConnectToken(tok);
    expect(parsed).toEqual({ apiBase: 'https://app.example.com', channelId: CH });
  });

  it('strips a trailing slash from apiBase', () => {
    expect(parseConnectToken(makeConnectToken('https://app.example.com/', CH))?.apiBase)
      .toBe('https://app.example.com');
  });

  it('rejects non-https relays (no plaintext / data: exfil)', () => {
    expect(parseConnectToken(`${CONNECT_PREFIX}http://evil.com|${CH}`)).toBeNull();
    expect(parseConnectToken(`${CONNECT_PREFIX}ftp://x|${CH}`)).toBeNull();
  });

  it('rejects a malformed channel id', () => {
    expect(parseConnectToken(`${CONNECT_PREFIX}https://a.com|short`)).toBeNull();      // too short
    expect(parseConnectToken(`${CONNECT_PREFIX}https://a.com|abcdefgh23456789`)).toBeNull(); // lowercase
    expect(parseConnectToken(`${CONNECT_PREFIX}https://a.com|ABCDEFGH23456701`)).toBeNull(); // 0/1 not in base32
  });

  it('rejects non-connect strings', () => {
    expect(isConnectQR('p01pair1:abc')).toBe(false);
    expect(parseConnectToken('p01pair1:abc')).toBeNull();
    expect(parseConnectToken(`${CONNECT_PREFIX}no-separator`)).toBeNull();
  });
});
