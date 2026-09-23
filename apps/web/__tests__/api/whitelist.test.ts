import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock environment variables
vi.stubEnv('ADMIN_PASSWORD', 'test-admin-password');
vi.stubEnv('RESEND_API_KEY', '');
vi.stubEnv('DISCORD_WEBHOOK', '');

// Mock the kv module before importing route handlers
const mockKvGet = vi.fn();
const mockKvSet = vi.fn();
/**
 * close-v1 (audit v1 F13, F64): the route now also counts (`incr` / `expire`)
 * and serializes its writes with a lock (`set ... nx ex` / `del`). The counters
 * get a plain in-memory map here, emptied before every case, and the lock's
 * `set` is answered below, so `mockKvSet` still sees exactly the whitelist
 * writes these assertions always did.
 */
const counters = new Map<string, number>();

vi.mock('@vercel/kv', () => ({
  kv: {
    get: (...args: unknown[]) => mockKvGet(...args),
    // The route's write lock (`SET whitelist:lock <owner> NX EX`, close-v1 F13)
    // is not the whitelist write these cases assert on; it is always free here.
    set: (...args: unknown[]) => (args[0] === 'whitelist:lock' ? Promise.resolve('OK') : mockKvSet(...args)),
    incr: async (key: string) => {
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return n;
    },
    expire: async () => 1,
    del: async (key: string) => {
      counters.delete(key);
      return 1;
    },
  },
}));

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: vi.fn().mockResolvedValue({ id: 'mock' }) },
  })),
}));

// Import after mocks are set up
import { GET, POST, DELETE } from '@/app/api/whitelist/route';
import { NextRequest } from 'next/server';

// Helper to create NextRequest
function createRequest(url: string, options: RequestInit & { headers?: Record<string, string> } = {}) {
  const fullUrl = `http://localhost:3000${url}`;
  return new NextRequest(fullUrl, options as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

/**
 * 🚨 SWEEP4 round 1, confirmed item 15 — THE HALF THAT WAS LEFT OPEN.
 *
 * The server lane stopped this route LOGGING the whitelist. The other half is
 * the REQUEST LINE: a developer's Solana address travelled in `?wallet=<addr>`,
 * and a URL is what every layer in front of a deployment writes down — Vercel's
 * request log, an edge cache key, a proxy, a referrer. The whitelist itself is
 * a small set, so one address in a log line names a person's wallet and says
 * they build on this deployment.
 *
 * The rule these cases pin: the WALLET NEVER REACHES THE URL. It travels in a
 * header on the check, and in the body on the removal, neither of which a
 * request log records. `?admin=true` stays in the URL deliberately: it names no
 * one and it is what selects the admin view.
 */
function urlOf(request: NextRequest): string {
  return request.url;
}

describe('the wallet never travels in the request line', () => {
  const WALLET = 'DeveloperWalletAddress111111111111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    counters.clear();
    mockKvGet.mockResolvedValue({
      approved: [{ wallet: WALLET, approvedAt: '2026-01-01', approvedBy: 'admin' }],
      pending: [],
    });
    mockKvSet.mockResolvedValue('OK');
  });

  it('answers a check whose URL names nobody', async () => {
    const request = createRequest('/api/whitelist', { headers: { 'x-p01-wallet': WALLET } });
    const response = await GET(request);

    expect(urlOf(request), 'the developer wallet is in the request line').not.toContain(WALLET);
    // Positive control: the answer is real, so the absence above is not the
    // route failing to read the wallet at all.
    expect((await response.json()).approved, 'the check did not read the wallet').toBe(true);
  });

  it('refuses to read a wallet out of the query string', async () => {
    // The old shape, sent by a client that has not been updated: it must not
    // work, or the leak stays reachable for as long as one caller remembers it.
    const request = createRequest(`/api/whitelist?wallet=${WALLET}`);
    const response = await GET(request);
    expect(response.status, 'the query-string form still answers').toBe(400);
  });

  it('removes a wallet named in the body, not in the URL', async () => {
    const request = createRequest('/api/whitelist', {
      method: 'DELETE',
      headers: { 'x-admin-password': 'test-admin-password', 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: WALLET }),
    });
    const response = await DELETE(request);

    expect(urlOf(request), 'the developer wallet is in the request line').not.toContain(WALLET);
    expect((await response.json()).success, 'the removal did not happen').toBe(true);
    // Positive control: it really was removed, so the URL check is not passing
    // because nothing ran.
    const written = mockKvSet.mock.calls.at(-1)?.[1] as { approved: Array<{ wallet: string }> };
    expect(written.approved.map((e) => e.wallet)).not.toContain(WALLET);
  });

  it('refuses a removal that names the wallet in the query string', async () => {
    const request = createRequest(`/api/whitelist?wallet=${WALLET}`, {
      method: 'DELETE',
      headers: { 'x-admin-password': 'test-admin-password' },
    });
    const response = await DELETE(request);
    expect(response.status, 'the query-string form still removes').toBe(400);
    expect(mockKvSet, 'the query-string form still wrote the whitelist').not.toHaveBeenCalled();
  });
});

describe('Whitelist API -- Developer access management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    counters.clear();
    mockKvGet.mockResolvedValue({ approved: [], pending: [] });
    mockKvSet.mockResolvedValue('OK');
  });

  /**
   * ⚠️ THE TITLE NAMES THE ROUTE'S HISTORICAL SHAPE, NOT TODAY'S CALL.
   *
   * The wallet moved out of the query string in the r1 gate repair (SWEEP4
   * item 15): a URL is written down by Vercel's request log, an edge cache key,
   * a proxy and a referrer, and the whitelist is a small set, so one line names
   * a developer. It travels in the `x-p01-wallet` header now, and the cases
   * below were changed to send it that way — their SUBJECT is unchanged, and
   * their names are kept so nothing this suite once proved goes missing.
   */
  describe('GET /api/whitelist?wallet=... -- Check developer access', () => {
    it('returns { approved: false } for an unknown wallet', async () => {
      const request = createRequest('/api/whitelist', {
        headers: { 'x-p01-wallet': 'UnknownWallet123' },
      });
      const response = await GET(request);
      const data = await response.json();

      expect(data.approved).toBe(false);
    });

    it('returns { approved: true } for a whitelisted wallet', async () => {
      mockKvGet.mockResolvedValue({
        approved: [{ wallet: 'ApprovedWallet123', approvedAt: '2026-01-01', approvedBy: 'admin' }],
        pending: [],
      });

      const request = createRequest('/api/whitelist', {
        headers: { 'x-p01-wallet': 'ApprovedWallet123' },
      });
      const response = await GET(request);
      const data = await response.json();

      expect(data.approved).toBe(true);
    });

    it('performs case-insensitive wallet comparison for security', async () => {
      mockKvGet.mockResolvedValue({
        approved: [{ wallet: 'MyWallet123ABC', approvedAt: '2026-01-01', approvedBy: 'admin' }],
        pending: [],
      });

      const request = createRequest('/api/whitelist', {
        headers: { 'x-p01-wallet': 'mywallet123abc' },
      });
      const response = await GET(request);
      const data = await response.json();

      expect(data.approved).toBe(true);
    });
  });

  describe('GET /api/whitelist?admin=true -- Admin dashboard data', () => {
    it('returns 401 Unauthorized without admin password', async () => {
      const request = createRequest('/api/whitelist?admin=true');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('returns 401 Unauthorized with wrong password', async () => {
      const request = createRequest('/api/whitelist?admin=true', {
        headers: { 'x-admin-password': 'wrong-password' },
      });
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('returns full whitelist data with correct admin password', async () => {
      const mockData = {
        approved: [{ wallet: 'Wallet1', approvedAt: '2026-01-01', approvedBy: 'admin' }],
        pending: [{ wallet: 'Wallet2', approvedAt: '2026-01-01', approvedBy: '' }],
      };
      mockKvGet.mockResolvedValue(mockData);

      const request = createRequest('/api/whitelist?admin=true', {
        headers: { 'x-admin-password': 'test-admin-password' },
      });
      const response = await GET(request);
      const data = await response.json();

      expect(data.approved).toHaveLength(1);
      expect(data.pending).toHaveLength(1);
    });
  });

  describe('GET /api/whitelist -- there is no public list any more', () => {
    it('⛔ refuses to enumerate approved wallets to an unauthenticated caller', async () => {
      // 🚨 IT USED TO RETURN THEM ALL. One GET, no wallet, no chain
      // access, no credential: `whitelist.approved.map(e => e.wallet)`, every
      // approved developer's Solana address. The case that stood here asserted
      // it, and asserted only that no EMAIL came with them -- so the leak was
      // pinned as a feature while the test read like a privacy check.
      //
      // It had zero callers. The admin page reads `?admin=true` behind the
      // password; everything else asks about one wallet.
      mockKvGet.mockResolvedValue({
        approved: [
          { wallet: 'Wallet1', email: 'secret@example.com', approvedAt: '2026-01-01', approvedBy: 'admin' },
        ],
        pending: [],
      });

      const request = createRequest('/api/whitelist');
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.approved, 'the wallet list came back').toBeUndefined();
      expect(JSON.stringify(data)).not.toContain('Wallet1');
      expect(JSON.stringify(data)).not.toContain('secret@example.com');
    });

    it('still answers about ONE wallet, which the app needs', async () => {
      // Anti-vacuity: refusing everything would also pass the case above.
      mockKvGet.mockResolvedValue({
        approved: [{ wallet: 'Wallet1', email: 'x@y.z', approvedAt: '2026-01-01', approvedBy: 'a' }],
        pending: [],
      });
      const response = await GET(
        createRequest('/api/whitelist', { headers: { 'x-p01-wallet': 'Wallet1' } }),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).approved).toBe(true);
    });
  });

  describe('POST /api/whitelist -- Developer signup flow', () => {
    it('adds wallet to pending list for new applicants', async () => {
      const request = createRequest('/api/whitelist', {
        method: 'POST',
        body: JSON.stringify({
          wallet: 'NewDevWallet123',
          email: 'dev@example.com',
          projectName: 'My DeFi App',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(mockKvSet).toHaveBeenCalled();
    });

    it('returns 400 if wallet address is missing from request', async () => {
      const request = createRequest('/api/whitelist', {
        method: 'POST',
        body: JSON.stringify({ email: 'dev@example.com' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it('does not duplicate if wallet already in pending list', async () => {
      mockKvGet.mockResolvedValue({
        approved: [],
        pending: [{ wallet: 'ExistingDev', approvedAt: '2026-01-01', approvedBy: '' }],
      });

      const request = createRequest('/api/whitelist', {
        method: 'POST',
        body: JSON.stringify({ wallet: 'ExistingDev' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      // kv.set should NOT be called if already in list
      expect(mockKvSet).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/whitelist?action=approve -- Admin approval', () => {
    it('moves wallet from pending to approved', async () => {
      mockKvGet.mockResolvedValue({
        approved: [],
        pending: [{ wallet: 'PendingDev', email: 'dev@test.com', approvedAt: '2026-01-01', approvedBy: '' }],
      });

      const request = createRequest('/api/whitelist', {
        method: 'POST',
        body: JSON.stringify({ wallet: 'PendingDev', action: 'approve' }),
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': 'test-admin-password',
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.message).toBe('Wallet approved');

      const setCall = mockKvSet.mock.calls[0];
      expect(setCall[1].approved[0].wallet).toBe('PendingDev');
      expect(setCall[1].pending).toHaveLength(0);
    });

    it('returns 401 for approve action without admin password', async () => {
      const request = createRequest('/api/whitelist', {
        method: 'POST',
        body: JSON.stringify({ wallet: 'SomeWallet', action: 'approve' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/whitelist?action=revoke -- Admin revocation', () => {
    it('removes wallet from both approved and pending lists', async () => {
      mockKvGet.mockResolvedValue({
        approved: [{ wallet: 'BadActor', approvedAt: '2026-01-01', approvedBy: 'admin' }],
        pending: [],
      });

      const request = createRequest('/api/whitelist', {
        method: 'POST',
        body: JSON.stringify({ wallet: 'BadActor', action: 'revoke' }),
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': 'test-admin-password',
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.message).toBe('Wallet removed');
    });
  });

  /**
   * ⚠️ THE TITLE NAMES THE ROUTE'S HISTORICAL SHAPE, NOT TODAY'S CALL.
   *
   * The wallet moved out of the query string in the r1 gate repair (SWEEP4
   * item 15): a URL is written down by Vercel's request log, an edge cache key,
   * a proxy and a referrer, and the whitelist is a small set, so one line names
   * a developer. It travels in the `x-p01-wallet` header now, and the cases
   * below were changed to send it that way — their SUBJECT is unchanged, and
   * their names are kept so nothing this suite once proved goes missing.
   */
  describe('DELETE /api/whitelist?wallet=... -- Admin removal', () => {
    it('removes a wallet from all lists', async () => {
      mockKvGet.mockResolvedValue({
        approved: [{ wallet: 'ToRemove', approvedAt: '2026-01-01', approvedBy: 'admin' }],
        pending: [],
      });

      const request = createRequest('/api/whitelist', {
        method: 'DELETE',
        headers: { 'x-admin-password': 'test-admin-password', 'content-type': 'application/json' },
        body: JSON.stringify({ wallet: 'ToRemove' }),
      });

      const response = await DELETE(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.message).toBe('Wallet removed');
    });

    it('returns 401 without admin password', async () => {
      const request = createRequest('/api/whitelist', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet: 'SomeWallet' }),
      });

      const response = await DELETE(request);
      expect(response.status).toBe(401);
    });

    it('returns 400 without wallet parameter', async () => {
      const request = createRequest('/api/whitelist', {
        method: 'DELETE',
        headers: { 'x-admin-password': 'test-admin-password' },
      });

      const response = await DELETE(request);
      expect(response.status).toBe(400);
    });
  });
});
