/**
 * Solana stealth adapter — the real specter-sdk-backed implementation.
 *
 * This object is SECRET-FREE. It runs wherever the UI runs (main thread) and
 * never touches a spending/viewing/ML-KEM secret. All key derivation, ML-KEM
 * encapsulate/decapsulate, view-tag scanning, one-time-address derivation and
 * claim-signing happen inside `worker/workerCore.ts`, reached through a
 * `SolanaWorkerClient` transport:
 *
 *   - In production the per-app Worker entry injects a postMessage-backed client
 *     (`setSolanaWorkerClient`) so secrets live only inside the Worker.
 *   - When none is injected, a default in-process client calls `handleWorkerRequest`
 *     directly (same context) — fine for tests/SSR, but without cross-thread
 *     isolation. The app is expected to inject the real client.
 *
 * `send` and `registerSelf` produce UNSIGNED transactions inside the worker
 * core; the connected wallet (owned by the UI, never seen by pay-core) signs
 * them in one approval and submits, via an injected `SolanaSignerRuntime`.
 * `deriveMeta` also requires the signer runtime: every derived session is bound
 * to the connected wallet at birth, and the worker core rejects claims from
 * sessions that carry no bound wallet.
 */

import type {
  Asset,
  ChainStealthAdapter,
  DerivedIdentity,
  FeeQuote,
  ResolvedRecipient,
  SendParams,
  StealthPayment,
  TxRef,
} from '../types';
import { SOL, USDC_SOLANA } from '../assets';
import type {
  SolanaSignerRuntime,
  SolanaWorkerClient,
  SolanaWorkerConfig,
  WorkerRequest,
  ResponseFor,
} from '../worker/messages';
import { configureWorkerCore, handleWorkerRequest } from '../worker/workerCore';

// ---------------------------------------------------------------------------
// Injectable transport + signer wiring (set by the per-app worker entry / UI)
// ---------------------------------------------------------------------------

/** Default in-process client — routes straight to the worker core. Replaced by
 *  a postMessage bridge when the app calls `setSolanaWorkerClient`. */
const inProcessClient: SolanaWorkerClient = {
  request<R extends WorkerRequest>(req: R): Promise<ResponseFor<R>> {
    return handleWorkerRequest(req);
  },
};

let client: SolanaWorkerClient = inProcessClient;
let signer: SolanaSignerRuntime | null = null;

/** Inject the real (postMessage) worker client so secrets stay off the main thread. */
export function setSolanaWorkerClient(next: SolanaWorkerClient): void {
  client = next;
}

/** Configure the connected wallet runtime used to sign+submit sends/registration. */
export function setSolanaSignerRuntime(next: SolanaSignerRuntime | null): void {
  signer = next;
}

/** Convenience re-export: configure the in-process worker core's RPC/programs. */
export function configureSolanaWorkerCore(cfg: SolanaWorkerConfig): void {
  configureWorkerCore(cfg);
}

function requireSigner(): SolanaSignerRuntime {
  if (!signer) {
    throw new Error(
      'No wallet runtime configured. The UI must call setSolanaSignerRuntime({ senderPubkey, ' +
        'signAndSubmit }) with the connected wallet before sending or registering.',
    );
  }
  return signer;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const solanaAdapter: ChainStealthAdapter = {
  id: 'solana',
  label: 'Solana',
  status: 'live',
  assets: [SOL, USDC_SOLANA],

  async deriveMeta(signature: Uint8Array): Promise<DerivedIdentity> {
    // Bind the identity to the connected wallet so claims from it can only pay
    // out to that wallet. A signer runtime is REQUIRED here: an unbound session
    // would let any same-origin script claim to an arbitrary destination, so
    // every session must be born bound (the worker core rejects unbound claims).
    if (!signer) {
      throw new Error('Connect a wallet before deriving keys.');
    }
    const res = await client.request({
      kind: 'deriveMeta',
      signature,
      ownerWallet: signer.senderPubkey,
    });
    return res.identity;
  },

  async resolveRecipient(input: string): Promise<ResolvedRecipient> {
    const res = await client.request({ kind: 'resolveRecipient', input });
    return res.recipient;
  },

  quoteFees(asset: Asset, _amount: number): FeeQuote {
    // Honest quote — only what the built transactions actually do:
    //   networkFee: init + 2 KEM-chunk + funds txs ≈ 4 × 5000 lamports; a USDC
    //               send also carries ~0.0025 SOL claim funding to the stealth
    //               address (fee + destination-ATA rent for the recipient).
    //   senderRent: rent-exempt StealthAccountV2 announcement (1220 bytes),
    //               paid by the sender ON TOP of the amount, not deducted.
    //   minSend:    SOL — claim fee + rent-exemption + margin, in SOL.
    //               USDC — dust floor in USDC (claim costs ride the topup).
    //   protocol fee: none is charged on-chain today.
    const usdc = asset.symbol === 'USDC';
    return {
      networkFee: usdc ? 0.00252 : 0.00002,
      protocolFee: 0,
      senderRent: 0.0095,
      minSend: usdc ? 0.01 : 0.002,
      estTime: 'a few seconds',
      approvals: 1,
    };
  },

  async send(params: SendParams): Promise<TxRef> {
    if (params.asset.chainId !== 'solana' || params.asset.status !== 'live') {
      throw new Error(`${params.asset.symbol} is not sendable on Solana yet.`);
    }
    const wallet = requireSigner();
    const base = 10 ** params.asset.decimals;
    const amountLamports = BigInt(Math.round(params.amount * base)).toString();

    const built = await client.request({
      kind: 'buildSend',
      senderPubkey: wallet.senderPubkey,
      recipientMeta: params.recipient.meta,
      assetSymbol: params.asset.symbol,
      amountLamports,
    });

    const signature = await wallet.signAndSubmit(built.transactionsB64, {
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
    });
    return { signature, explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet` };
  },

  async scan(identity: DerivedIdentity): Promise<StealthPayment[]> {
    const res = await client.request({ kind: 'scan', meta: identity.meta });
    return res.payments;
  },

  async claim(payment: StealthPayment, identity: DerivedIdentity, destination: string): Promise<TxRef> {
    const res = await client.request({
      kind: 'claim',
      meta: identity.meta,
      paymentId: payment.id,
      destination,
    });
    return res.tx;
  },

  async registerSelf(_identity: DerivedIdentity): Promise<TxRef> {
    // register_v2's 1184-byte ML-KEM key exceeds the 1232-byte Solana packet
    // limit — the instruction cannot fit in any single transaction. Blocked
    // until the registry program gains a chunked write (registry v3).
    throw new Error(
      'On-chain publishing is not available yet: the post-quantum key does not fit in a ' +
        'single Solana transaction. Share your meta-address or QR code directly.',
    );
  },
};

/** Forget every secret session held by the worker (call on wallet disconnect/switch). */
export async function clearStealthSessions(): Promise<void> {
  await client.request({ kind: 'clearSessions' });
}
