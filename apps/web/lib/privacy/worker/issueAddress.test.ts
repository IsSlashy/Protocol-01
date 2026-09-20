/**
 * DEV-1 (c): ONE ISSUANCE, ONE ADDRESS.
 *
 * Runs under `vitest.pool.config.mts` (node): `npx vitest run --config
 * vitest.pool.config.mts lib/privacy/worker/issueAddress.test.ts`.
 *
 * THE LEAK. `requestIssuedNote` sent this identity's published `p01pq:`
 * address with every purchase, so the issuer (and anyone holding its logs or
 * a dump of its store) could group every note one buyer ever bought: one
 * stable public key, N purchases (ledger row D9, "note address static per
 * identity").
 *
 * THE FIX. The address sent is `poolIssueAddress(meta, code)`: note keys
 * derived from HKDF(seed, 'p01:issue-seal:v1' || sha256(code)). A fresh key
 * pair per claim code, re-derivable from the seed and the code alone, so:
 *   - two purchases share no key bytes (case 1);
 *   - a note opens only with the code it was sold for (case 1);
 *   - a retry with the SAME code re-derives the same key, so the reply the
 *     issuer kept for that code (ISSUE-1's replay) still opens (case 2);
 *   - a reply stored before this change, sealed to the published address,
 *     still opens: the import falls back to the identity keys (case 3).
 *
 * Nothing is stubbed on the worker side: `poolRequest` is routed into the
 * real `handlePoolRequest`, and the fake issuer seals real notes with the
 * real hybrid X25519 + ML-KEM-768, whose commitments the import recomputes.
 * The only network is the issuer, replaced by `fetch` below.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { derivePoolSeedLegacy } from '../pool/seedDerivation';
import {
  createCommitmentV3,
  findPoolV3,
  pubkeyToField,
  type ShareableNote,
} from '../pool/denominatedPool';
import { encryptNote, parseNoteEncryptionAddress } from '../pool/noteCrypto';

vi.mock('../workerClient', async () => {
  const { handlePoolRequest } = await import('./poolHandlers');
  return {
    poolRequest: (req: never, onProgress?: (step: string) => void) =>
      handlePoolRequest(req, onProgress),
  };
});

const shieldClient = await import('../shieldClient');
const { clearPoolState, handlePoolRequest, setPoolSeed } = await import('./poolHandlers');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNATURE = Uint8Array.from({ length: 64 }, (_, i) => (i * 5 + 9) & 0xff);
// Touch the derivation once so a broken seed module fails here, not mid-case.
derivePoolSeedLegacy(SIGNATURE);
const META = 'meta-issue-address';
const WALLET = '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU';
const CODE_A = 'claimAAAA-0123456789';
const CODE_B = 'claimBBBB-9876543210';

const POOL = findPoolV3('SOL', 0.1)!;
const POOL_58 = POOL.poolPDA.toBase58();
const TOKEN_MINT_FIELD = pubkeyToField(POOL.tokenMint);

/** A note whose commitment really recomputes from its secrets, one per `i`. */
function issuedNote(i: number): ShareableNote {
  const secret = 911_000_000_000_001n + BigInt(i) * 7_919n;
  const preimage = 822_000_000_000_003n + BigInt(i) * 104_729n;
  const blinding = 733_000_000_000_007n + BigInt(i) * 1_299_709n;
  return {
    version: 1,
    pool: POOL_58,
    secret: secret.toString(),
    nullifier_preimage: preimage.toString(),
    deposit_epoch: blinding.toString(),
    token_mint: TOKEN_MINT_FIELD.toString(),
    commitment: createCommitmentV3(preimage, secret, blinding, TOKEN_MINT_FIELD).toString(),
    leafIndex: 30 + i,
    token: 'SOL',
    denominationHuman: 0.1,
    shieldedAt: 1_700_000_000_000,
  };
}

// ---------------------------------------------------------------------------
// The issuer: seals a real note to whatever address it is sent, and keeps the
// reply per code the way `/api/issue-note` does since ISSUE-1.
// ---------------------------------------------------------------------------

const issuer = {
  asked: [] as string[],
  sealed: [] as string[],
  replies: new Map<string, string>(),
  replayed: 0,
  sold: 0,
  loseNextAnswer: false,
};

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

function installIssuer(): void {
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    if (String(url) === '/api/issue-note' && init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}') as { recipientAddress: string; claimCode: string };
      issuer.asked.push(body.recipientAddress);
      const kept = issuer.replies.get(body.claimCode);
      if (kept) {
        issuer.replayed += 1;
        return json(200, { ok: true, sealedNote: kept, disclosure: 'D', replayed: true });
      }
      const sealedNote = encryptNote(
        body.recipientAddress,
        utf8ToBytes(JSON.stringify(issuedNote(issuer.sold))),
      );
      issuer.sold += 1;
      issuer.sealed.push(sealedNote);
      issuer.replies.set(body.claimCode, sealedNote);
      if (issuer.loseNextAnswer) {
        issuer.loseNextAnswer = false;
        throw new TypeError('Failed to fetch');
      }
      return json(200, { ok: true, sealedNote, disclosure: 'D' });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
}

function installLocalStorage(): void {
  const m = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  });
}

/** How many `width`-byte windows of `a` also occur in `b`. */
function sharedWindows(a: Uint8Array, b: Uint8Array, width = 8): number {
  const seen = new Set<string>();
  for (let i = 0; i + width <= b.length; i++) seen.add(Buffer.from(b.subarray(i, i + width)).toString('hex'));
  let hits = 0;
  for (let i = 0; i + width <= a.length; i++) {
    if (seen.has(Buffer.from(a.subarray(i, i + width)).toString('hex'))) hits += 1;
  }
  return hits;
}

function buy(claimCode: string) {
  return shieldClient.requestIssuedNote({
    meta: META,
    walletPubkey: WALLET,
    token: 'SOL',
    denomination: 0.1,
    claimCode,
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubEnv('NEXT_PUBLIC_P01_FUNDER_TICKET', 'test-ticket');
  installLocalStorage();
  installIssuer();
  clearPoolState();
  setPoolSeed(META, SIGNATURE);
  issuer.asked = [];
  issuer.sealed = [];
  issuer.replies = new Map();
  issuer.replayed = 0;
  issuer.sold = 0;
  issuer.loseNextAnswer = false;
});

// ---------------------------------------------------------------------------

describe('DEV-1: the issuer sees a fresh address per purchase', () => {
  it('two issuances, unlinkable addresses', async () => {
    const a = await buy(CODE_A);
    const b = await buy(CODE_B);

    // Anti-vacuity: two sales, two real notes opened on this side.
    expect(issuer.asked).toHaveLength(2);
    expect(a.note.leafIndex).toBe(30);
    expect(b.note.leafIndex).toBe(31);

    const [addrA, addrB] = issuer.asked.map(parseNoteEncryptionAddress);
    const published = parseNoteEncryptionAddress(
      (await handlePoolRequest({ kind: 'poolNoteAddress', meta: META })).address,
    );
    // Positive control for the detector: a key shares every window with itself.
    expect(sharedWindows(addrA!.x25519Pub, addrA!.x25519Pub)).toBe(25);

    expect(sharedWindows(addrA!.x25519Pub, addrB!.x25519Pub), 'one X25519 key for two purchases').toBe(0);
    expect(sharedWindows(addrA!.kemPub, addrB!.kemPub), 'ML-KEM bytes shared by two purchases').toBe(0);
    for (const addr of [addrA!, addrB!]) {
      expect(sharedWindows(addr.x25519Pub, published.x25519Pub), 'the published X25519 key').toBe(0);
      expect(sharedWindows(addr.kemPub, published.kemPub), 'the published ML-KEM key').toBe(0);
    }

    // Each note opens only with the code it was sold for.
    await expect(
      handlePoolRequest({
        kind: 'poolImportNote',
        meta: META,
        sealedNote: issuer.sealed[0]!,
        claimCode: CODE_B,
        encryptedNotes: [],
      } as never),
    ).rejects.toThrow(/not sealed to your address/);
    await expect(
      handlePoolRequest({
        kind: 'poolImportNote',
        meta: META,
        sealedNote: issuer.sealed[0]!,
        claimCode: CODE_A,
        encryptedNotes: [],
      } as never),
    ).resolves.toMatchObject({ kind: 'poolImportNote', note: { leafIndex: 30 } });
  });

  it('the same code, retried after a lost answer, opens the reply the issuer kept', async () => {
    issuer.loseNextAnswer = true;
    await expect(buy(CODE_A)).rejects.toThrow(/Failed to fetch/);
    // The retry is a new page's worth of work: nothing in memory but the seed.
    const again = await buy(CODE_A);

    expect(issuer.sold, 'the retry bought a second note').toBe(1);
    expect(issuer.replayed).toBe(1);
    expect(again.note.leafIndex).toBe(30);
    // Both attempts presented the same one-time address, so the kept reply
    // was sealed to a key this identity can re-derive from the code.
    expect(issuer.asked[1]).toBe(issuer.asked[0]);
  });

  it('a retry after a passphrase was armed still opens the reply the issuer kept', async () => {
    // The kept reply is sealed to the one-time key of the seed that was
    // active on the FIRST attempt. Arming a passphrase changes the active
    // seed, so the retry presents another address; the import must still try
    // the one-time key under every seed derivation it holds.
    issuer.loseNextAnswer = true;
    await expect(buy(CODE_A)).rejects.toThrow(/Failed to fetch/);
    clearPoolState();
    setPoolSeed(META, SIGNATURE, 'nine tigers argue quietly');
    const again = await buy(CODE_A);

    expect(issuer.asked[1], 'the armed seed kept the same address').not.toBe(issuer.asked[0]);
    expect(issuer.replayed).toBe(1);
    expect(again.note.leafIndex).toBe(30);
  });

  it('a reply sealed before DEV-1 to the published address still opens with its code', async () => {
    const published = (await handlePoolRequest({ kind: 'poolNoteAddress', meta: META })).address;
    const legacyReply = encryptNote(published, utf8ToBytes(JSON.stringify(issuedNote(9))));
    await expect(
      handlePoolRequest({
        kind: 'poolImportNote',
        meta: META,
        sealedNote: legacyReply,
        claimCode: CODE_A,
        encryptedNotes: [],
      } as never),
    ).resolves.toMatchObject({ kind: 'poolImportNote', note: { leafIndex: 39 } });
  });
});
