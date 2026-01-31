import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock environment variables
vi.stubEnv('ADMIN_PASSWORD', 'test-admin-password');
vi.stubEnv('RESEND_API_KEY', '');
vi.stubEnv('DISCORD_WEBHOOK', '');

// Mock the kv module before importing route handlers
const mockKvGet = vi.fn();
const mockKvSet = vi.fn();

vi.mock('@vercel/kv', () => ({
  kv: {
    get: (...args: unknown[]) => mockKvGet(...args),
    set: (...args: unknown[]) => mockKvSet(...args),
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
  return new NextRequest(fullUrl, options);
}

describe('Whitelist API -- Developer access management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKvGet.mockResolvedValue({ approved: [], pending: [] });
    mockKvSet.mockResolvedValue('OK');
  });

  describe('GET /api/whitelist?wallet=... -- Check developer access', () => {
    it('returns { approved: false } for an unknown wallet', async () => {
      const request = createRequest('/api/whitelist?wallet=UnknownWallet123');
      const response = await GET(request);
      const data = await response.json();

      expect(data.approved).toBe(false);
    });

    it('returns { approved: true } for a whitelisted wallet', async () => {
      mockKvGet.mockResolvedValue({
        approved: [{ wallet: 'ApprovedWallet123', approvedAt: '2026-01-01', approvedBy: 'admin' }],
        pending: [],
      });

      const request = createRequest('/api/whitelist?wallet=ApprovedWallet123');
      const response = await GET(request);
      const data = await response.json();

      expect(data.approved).toBe(true);
    });

    it('performs case-insensitive wallet comparison for security', async () => {
      mockKvGet.mockResolvedValue({
        approved: [{ wallet: 'MyWallet123ABC', approvedAt: '2026-01-01', approvedBy: 'admin' }],
        pending: [],
      });

      const request = createRequest('/api/whitelist?wallet=mywallet123abc');
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

  describe('GET /api/whitelist -- Public approved wallet list', () => {
    it('returns only wallet addresses (no emails or private data)', async () => {
      mockKvGet.mockResolvedValue({
        approved: [
          { wallet: 'Wallet1', email: 'secret@example.com', approvedAt: '2026-01-01', approvedBy: 'admin' },
        ],
        pending: [],
      });

      const request = createRequest('/api/whitelist');
      const response = await GET(request);
      const data = await response.json();

      expect(data.approved).toEqual(['Wallet1']);
      expect(JSON.stringify(data)).not.toContain('secret@example.com');
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

  describe('DELETE /api/whitelist?wallet=... -- Admin removal', () => {
    it('removes a wallet from all lists', async () => {
      mockKvGet.mockResolvedValue({
        approved: [{ wallet: 'ToRemove', approvedAt: '2026-01-01', approvedBy: 'admin' }],
        pending: [],
      });

      const request = createRequest('/api/whitelist?wallet=ToRemove', {
        method: 'DELETE',
        headers: { 'x-admin-password': 'test-admin-password' },
      });

      const response = await DELETE(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.message).toBe('Wallet removed');
    });

    it('returns 401 without admin password', async () => {
      const request = createRequest('/api/whitelist?wallet=SomeWallet', {
        method: 'DELETE',
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
