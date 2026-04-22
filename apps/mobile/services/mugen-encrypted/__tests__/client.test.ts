import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MugenApiError,
  MugenEncryptedClient,
} from '../client';
import type {
  BlindTakeMatched,
  BlindTakeNoMatch,
  ClaimMatchResponse,
  EncryptedOfferSuccess,
} from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MugenEncryptedClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('submitEncryptedOffer returns the success shape', async () => {
    const fake: EncryptedOfferSuccess = {
      ok: true,
      computationOffset: '42',
      txSignature: 'sig-abc',
      threshold: {
        reached: true,
        signaturesCount: 2,
        threshold: 2,
        totalSigners: 3,
        txHashHex: 'deadbeef',
        signers: [
          {
            region: 'eu-west-1',
            port: 5001,
            signerPubkey: 'pk1',
            signedAt: 1,
          },
          {
            region: 'us-east-1',
            port: 5002,
            signerPubkey: 'pk2',
            signedAt: 2,
          },
        ],
      },
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(fake));

    const client = new MugenEncryptedClient('http://localhost:3001');
    const res = await client.submitEncryptedOffer({
      orderType: 'sell',
      cryptoAmountLamports: 1_000_000,
      fiatAmountCents: 100,
      fiatCurrency: 'EUR',
      paymentMethods: 1,
      expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
      makerNoncePubkey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });

    expect(res.ok).toBe(true);
    expect(res.txSignature).toBe('sig-abc');
    expect(res.threshold?.reached).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/orders/encrypted');
    expect(init.method).toBe('POST');
  });

  it('blindTake with no match returns matched=false', async () => {
    const fake: BlindTakeNoMatch = {
      matched: false,
      computationOffset: '',
      txSignature: 'sig-no-match',
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(fake));

    const client = new MugenEncryptedClient('http://localhost:3001');
    const res = await client.blindTake({
      desiredCryptoAmountLamports: 500_000,
      maxFiatAmountCents: 5000,
      fiatCurrency: 'EUR',
      paymentMethodsMask: 1,
      takerNoncePubkey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    });

    expect(res.matched).toBe(false);
    expect(res.txSignature).toBe('sig-no-match');
  });

  it('blindTake matched returns matchedOrder details', async () => {
    const fake: BlindTakeMatched = {
      matched: true,
      computationOffset: '',
      txSignature: 'sig-match',
      matchedOrderNonce: 'NNN',
      matchedCryptoAmount: 1_000_000,
      matchedFiatAmount: 100,
      matchedOrder: {
        makerNoncePubkey: 'NNN',
        cryptoAmountLamports: 1_000_000,
        fiatAmountCents: 100,
        fiatCurrency: 'EUR',
        paymentMethods: 1,
        expiresAtUnix: 1_800_000_000,
        mpcTxSignature: 'mpc-sig',
        registeredAt: 1_700_000_000,
      },
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(fake));

    const client = new MugenEncryptedClient('http://localhost:3001');
    const res = await client.blindTake({
      desiredCryptoAmountLamports: 500_000,
      maxFiatAmountCents: 5000,
      fiatCurrency: 'EUR',
      paymentMethodsMask: 1,
      takerNoncePubkey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    });

    expect(res.matched).toBe(true);
    if (res.matched) {
      expect(res.matchedOrder?.makerNoncePubkey).toBe('NNN');
    }
  });

  it('claimMatch returns tokenEscrow=true shape', async () => {
    const fake: ClaimMatchResponse = {
      ok: true,
      tokenEscrow: true,
      escrowPDA: 'escrow-pda',
      vaultPDA: 'vault-pda',
      orderPDA: 'order-pda',
      txSignature: 'sig-escrow',
      simulated: false,
      matchedTerms: {
        cryptoAmountLamports: 1_000_000,
        fiatAmountCents: 100,
        fiatCurrency: 'EUR',
        paymentMethods: 1,
        makerNoncePubkey: 'MMM',
        takerNoncePubkey: 'TTT',
        takerWallet: 'WALLET',
      },
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(fake));

    const client = new MugenEncryptedClient('http://localhost:3001');
    const res = await client.claimMatch({
      takerNoncePubkey: 'TTT',
      matchedMakerNonce: 'MMM',
      takerWallet: 'WALLET',
    });

    expect(res.tokenEscrow).toBe(true);
    expect(res.escrowPDA).toBe('escrow-pda');
    expect(res.vaultPDA).toBe('vault-pda');
  });

  it('409 throws MugenApiError with code=THRESHOLD_REJECTED and signers attached', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'Threshold approval not reached',
          detail: 'Got 1 of 3 signers, need 2',
          signers: [{ region: 'eu-west-1', port: 5001 }],
          threshold: {
            reached: false,
            signaturesCount: 1,
            threshold: 2,
            totalSigners: 3,
          },
        },
        409,
      ),
    );

    const client = new MugenEncryptedClient('http://localhost:3001');
    await expect(
      client.blindTake({
        desiredCryptoAmountLamports: 500_000,
        maxFiatAmountCents: 5000,
        fiatCurrency: 'EUR',
        paymentMethodsMask: 1,
        takerNoncePubkey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      }),
    ).rejects.toMatchObject({
      name: 'MugenApiError',
      status: 409,
      code: 'THRESHOLD_REJECTED',
    });

    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'Threshold approval not reached',
          signers: [{ region: 'eu-west-1', port: 5001 }],
          threshold: {
            reached: false,
            signaturesCount: 1,
            threshold: 2,
            totalSigners: 3,
          },
        },
        409,
      ),
    );

    try {
      await client.blindTake({
        desiredCryptoAmountLamports: 500_000,
        maxFiatAmountCents: 5000,
        fiatCurrency: 'EUR',
        paymentMethodsMask: 1,
        takerNoncePubkey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MugenApiError);
      const e = err as MugenApiError;
      expect(e.code).toBe('THRESHOLD_REJECTED');
      expect(e.signers).toEqual([{ region: 'eu-west-1', port: 5001 }]);
      expect(e.threshold?.reached).toBe(false);
    }
  });

  it('503 throws COORDINATOR_UNREACHABLE', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ error: 'FROST coordinator unreachable' }, 503),
    );

    const client = new MugenEncryptedClient('http://localhost:3001');
    await expect(
      client.submitEncryptedOffer({
        orderType: 'sell',
        cryptoAmountLamports: 1_000_000,
        fiatAmountCents: 100,
        fiatCurrency: 'EUR',
        paymentMethods: 1,
        expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
        makerNoncePubkey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    ).rejects.toMatchObject({
      code: 'COORDINATOR_UNREACHABLE',
      status: 503,
    });
  });

  it('fetch rejection surfaces as NETWORK_ERROR', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const client = new MugenEncryptedClient('http://localhost:3001');
    await expect(
      client.lookupMyOrder('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: 0,
    });
  });

  it('getEscrowStatus encodes escrowPDA as a query param', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        exists: true,
        status: 'awaiting_payment',
        statusCode: 0,
        maker: 'M',
        taker: 'T',
        cryptoAmount: '1000',
        fiatAmount: '100',
        expiresAt: 0,
        paymentConfirmedAt: 0,
        vault: 'V',
        tokenMint: 'Mint',
        disputeReason: 0,
        disputeInitiator: '11111111111111111111111111111111',
      }),
    );

    const client = new MugenEncryptedClient('http://localhost:3001');
    const res = await client.getEscrowStatus('ESCROW123');
    expect(res.status).toBe('awaiting_payment');
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://localhost:3001/api/trade/escrow-status?escrowPDA=ESCROW123',
    );
  });
});
