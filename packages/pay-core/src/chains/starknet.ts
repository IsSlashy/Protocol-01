/**
 * Starknet adapter — Specter PQ recipient-discovery, LIVE on the direct
 * ERC-20 path.
 *
 * The PQ discovery half (meta derivation, ML-KEM encapsulation, stealth
 * derivation, and event scan/reassembly) reuses `@protocol-01/specter-sdk`
 * unchanged. The value half runs as plan B while STRK20 Privacy Pool access
 * is gated: send() executes a plain ERC-20 transfer to the counterfactual
 * stealth account plus a STRK cushion, and announces the ML-KEM handshake
 * via the pq_announcer contract, all in one multicall. AMOUNTS ARE PUBLIC on
 * this path — what our layer hides is who receives. claim() deploys the
 * counterfactual account with the derived stark key and sweeps to the
 * destination. The Strk20Client interface below stays as the future pool
 * integration that makes the amount confidential too (registerSelf is still
 * gated behind it).
 *
 * ⚠ Bearer caveat (surfaced in the UI): the stark stealth key derives from
 * the hybrid SHARED secret, which the sender also knows — so the sender
 * retains spend authority until the recipient claims. Claim promptly. Full
 * derivation rationale in starknetStealth.ts.
 *
 * Split (see contracts/starknet/ARCHITECTURE.md):
 *   STRK20 = confidentiality of amount/balance (native Privacy Pool).
 *   Specter = confidentiality + PQ durability of *who receives* (this file).
 *
 * connectWallet:  get-starknet-core (ArgentX / Braavos).
 * deriveMeta:     SNIP-12 signMessage → hkdf('p01:web:walletseed:v2') → same
 *                 specter-sdk ML-KEM + stealth derivation as Solana. One
 *                 chain-agnostic meta-address works on Solana AND Starknet.
 * scan:           StarknetTransport (pq_announcer events) + specter-sdk
 *                 stealth ownership test + ML-KEM decapsulate.
 * send/claim:     live — direct ERC-20 + PQ announcement / deploy_account +
 *                 sweep with the derived stark key.
 * registerSelf:   gated behind the Strk20Client (throws until SDK access).
 */

import nacl from 'tweetnacl';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  encodeStealthMetaAddress,
  parseStealthMetaAddress,
  kemGenerateKeypair,
  toHex,
} from '@protocol-01/specter-sdk/core';
import {
  Account,
  RpcProvider,
  CallData,
  num,
  type AccountInterface,
  type Call,
  type Signature,
  type TypedData,
} from 'starknet';
import {
  generateStarknetStealth,
  deriveStarknetStealthKey,
  DEFAULT_OZ_ACCOUNT_CLASS_HASH,
  type StarknetStealthKey,
} from './starknetStealth';
// get-starknet-core is loaded lazily inside connectStarknetWallet (below).
// Its pre-minified ESM dist declares top-level `var x` etc. that collide when
// a bundler scope-hoists it into a shared client chunk ("Identifier 'x' has
// already been declared"). A dynamic import keeps it in its own chunk, loaded
// only when the user actually connects a Starknet wallet.
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
import { STRK_STARKNET, ETH_STARKNET, USDC_STARKNET } from '../assets';
import { StarknetTransport } from '../transport/starknetTransport';

// ─────────────────────────────────────────────────────────────────────────────
// Injected config (the app provides this — pay-core stays framework-agnostic,
// so it never reads process.env / Next directly).
// ─────────────────────────────────────────────────────────────────────────────

export interface StarknetChainConfig {
  /** JSON-RPC node url (e.g. a Sepolia endpoint). */
  nodeUrl?: string;
  /** `NEXT_PUBLIC_PQ_ANNOUNCER_ADDRESS` — pq_announcer address (Phase 0: unset). */
  announcerAddress?: string;
  /** Explorer base for deep links (e.g. https://sepolia.starkscan.co). */
  explorerBase?: string;
  /** Block to start event scans from. */
  fromBlock?: number;
  /** Account class hash for counterfactual stealth accounts (default: OZ). */
  accountClassHash?: string;
  /** ERC-20 token addresses by symbol (defaults: canonical ETH/STRK). */
  tokens?: Partial<Record<string, string>>;
  /** STRK (wei) the sender adds so the recipient's claim can pay the
   *  deploy_account + sweep fees (v3 txs pay fees in STRK). Default 1 STRK. */
  claimCushionWei?: bigint;
}

/** Canonical token addresses — identical on mainnet, Sepolia and devnet forks. */
export const STARKNET_TOKENS: Record<string, string> = {
  ETH: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
  STRK: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
};

const DEFAULT_CLAIM_CUSHION_WEI = 10n ** 18n; // 1 STRK

/** STRK a sweep keeps back to pay its own fee; balances at/below this are
 *  treated as claim residue, not incoming payments. */
const STRK_SWEEP_FEE_MARGIN = 5n * 10n ** 17n; // 0.5 STRK

/** Decimal → base units without float loss (1e18 exceeds double precision). */
export function toBaseUnits(amount: number | string, decimals: number): bigint {
  const s = typeof amount === 'number' ? amount.toFixed(decimals) : amount;
  const [int, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(int || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

let injectedConfig: StarknetChainConfig = {};

/** Inject the Starknet runtime config (RPC + pq_announcer address). */
export function configureStarknet(config: StarknetChainConfig): void {
  injectedConfig = { ...injectedConfig, ...config };
}

/** Read the current injected Starknet config. */
export function getStarknetChainConfig(): StarknetChainConfig {
  return injectedConfig;
}

/** True when the injected config can reach the chain (RPC node + deployed
 *  pq_announcer). The UI gates the chain's "Live" status on this. */
export function isStarknetConfigured(): boolean {
  return Boolean(injectedConfig.nodeUrl && injectedConfig.announcerAddress);
}

// ─────────────────────────────────────────────────────────────────────────────
// STRK20 Privacy Wallet API — GATED.
//
// The private transfer/claim/register runs through StarkWare's native Privacy
// Pool SDK (v0.10.3), which is access-gated. We define the interface we need so
// the flow is fully wired, and ship a stub that throws until access lands.
// ─────────────────────────────────────────────────────────────────────────────

export interface Strk20ShieldParams {
  /** One-time stealth address the PQ handshake derived (hex). */
  stealthAddress: string;
  /** Asset being sent privately. */
  asset: Asset;
  /** Amount in whole units. */
  amount: number;
}

export interface Strk20ClaimParams {
  /** Stealth address holding the note. */
  stealthAddress: string;
  /** Spending key material recovered from the stealth derivation (hex). */
  stealthPrivateKey: string;
  /** Where to release the claimed funds. */
  destination: string;
  /** Asset symbol. */
  assetSymbol: string;
}

export interface Strk20RegisterParams {
  /** The v2 hybrid meta-address to publish for pay-by-wallet lookup. */
  meta: string;
  /** The registering wallet address. */
  owner: string;
}

/**
 * The slice of the STRK20 Privacy Wallet API the Specter flow needs. STRK20
 * moves the value (amount/balance privacy); Specter picks the recipient
 * (PQ-durable who-receives privacy). Kept as an interface so a real client can
 * be dropped in the day access is granted.
 */
export interface Strk20Client {
  /** Execute a private STRK20 transfer INTO the PQ-derived stealth address. */
  shieldToStealth(params: Strk20ShieldParams): Promise<TxRef>;
  /** Claim the private note held at a stealth address to a destination. */
  claimFromStealth(params: Strk20ClaimParams): Promise<TxRef>;
  /** Publish the meta-address on-chain (register_v2) for pay-by-wallet. */
  register(params: Strk20RegisterParams): Promise<TxRef>;
}

const STRK20_GATE_MESSAGE =
  'STRK20 Privacy SDK access pending — see contracts/starknet/ARCHITECTURE.md';

/**
 * The honest gate. Every value-moving path throws this until STRK20 Privacy
 * SDK / Wallet API access is granted. The PQ discovery half above is real and
 * runs right up to this branch point.
 */
export function createGatedStrk20Client(): Strk20Client {
  const gate = (): never => {
    throw new Error(STRK20_GATE_MESSAGE);
  };
  return {
    shieldToStealth: gate,
    claimFromStealth: gate,
    register: gate,
  };
}

let strk20Client: Strk20Client = createGatedStrk20Client();

/** Swap in a real STRK20 client once SDK access is granted. */
export function setStrk20Client(client: Strk20Client): void {
  strk20Client = client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet connection (get-starknet-core) — ArgentX / Braavos.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConnectedStarknet {
  /** The connected wallet's signing account. */
  account: AccountInterface;
  /** Selected account address (hex). */
  address: string;
  /** Wallet id, e.g. 'argentX' | 'braavos'. */
  walletId: string;
  /** Connected chain id. */
  chainId?: string;
}

const PREFERRED_WALLET_IDS = ['argentX', 'braavos'];

/**
 * Connect an injected Starknet wallet (prefers ArgentX / Braavos). Browser-only
 * (get-starknet-core reads `window`). The returned `account` signs the SNIP-12
 * message that seeds meta derivation.
 */
export async function connectStarknetWallet(): Promise<ConnectedStarknet> {
  const getStarknet = (await import('get-starknet-core')).default;
  const available = await getStarknet.getAvailableWallets();
  if (!available.length) {
    throw new Error('No Starknet wallet found. Install ArgentX or Braavos.');
  }
  const preferred =
    available.find((w) => PREFERRED_WALLET_IDS.includes(w.id)) ?? available[0]!;
  const connected = await getStarknet.enable(preferred);
  if (!connected.isConnected) {
    throw new Error('Starknet wallet connection was rejected.');
  }
  return {
    account: connected.account as AccountInterface,
    address: connected.selectedAddress,
    walletId: connected.id,
    chainId: connected.chainId,
  };
}

/** SNIP-12 typed data the wallet signs to seed the stealth meta derivation. */
export function buildStealthSeedTypedData(address: string, chainId: string): TypedData {
  return {
    domain: {
      name: 'Protocol01',
      version: '2',
      chainId,
      revision: '1',
    },
    types: {
      StarknetDomain: [
        { name: 'name', type: 'shortstring' },
        { name: 'version', type: 'shortstring' },
        { name: 'chainId', type: 'shortstring' },
        { name: 'revision', type: 'shortstring' },
      ],
      StealthSeed: [
        { name: 'purpose', type: 'shortstring' },
        { name: 'account', type: 'ContractAddress' },
      ],
    },
    primaryType: 'StealthSeed',
    message: {
      purpose: 'p01-stealth-meta-v2',
      account: address,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Injected signer runtime — the connected wallet account (ArgentX / Braavos /
// P01). send() executes its multicall through this; the UI sets it after
// connecting. Mirrors the Solana adapter's setSolanaSignerRuntime pattern.
// ─────────────────────────────────────────────────────────────────────────────

export interface StarknetSignerRuntime {
  /** The connected wallet's signing account. */
  account: AccountInterface;
  /** The wallet's address (claim destination default). */
  address: string;
}

let starknetSigner: StarknetSignerRuntime | null = null;

/** Configure the connected Starknet wallet used to execute sends. */
export function setStarknetSignerRuntime(next: StarknetSignerRuntime | null): void {
  starknetSigner = next;
}

function requireStarknetSigner(): StarknetSignerRuntime {
  if (!starknetSigner) {
    throw new Error('Connect a Starknet wallet (ArgentX / Braavos) before sending.');
  }
  return starknetSigner;
}

function requireChainConfig(): Required<Pick<StarknetChainConfig, 'nodeUrl' | 'announcerAddress'>> &
  StarknetChainConfig {
  const cfg = injectedConfig;
  if (!cfg.nodeUrl || !cfg.announcerAddress) {
    throw new Error(
      'Starknet is not configured: set the RPC node url and the deployed pq_announcer ' +
        'address (configureStarknet). See contracts/starknet/ARCHITECTURE.md.',
    );
  }
  return cfg as Required<Pick<StarknetChainConfig, 'nodeUrl' | 'announcerAddress'>> &
    StarknetChainConfig;
}

/** Flatten a SNIP-12 signature to deterministic seed bytes (each felt → 32B BE). */
export function signatureToSeedBytes(sig: Signature): Uint8Array {
  const felts: bigint[] = Array.isArray(sig)
    ? sig.map((s) => num.toBigInt(s))
    : [num.toBigInt(sig.r), num.toBigInt(sig.s)];
  const out = new Uint8Array(felts.length * 32);
  felts.forEach((f, idx) => {
    let v = f;
    for (let b = 31; b >= 0; b--) {
      out[idx * 32 + b] = Number(v & 0xffn);
      v >>= 8n;
    }
  });
  return out;
}

/**
 * Convenience: connect → SNIP-12 sign → derive the PQ meta identity in one call.
 * Equivalent to `starknetAdapter.deriveMeta(signatureBytes)` with the wallet
 * plumbing done for you.
 */
export async function deriveStarknetIdentity(): Promise<{
  connection: ConnectedStarknet;
  identity: DerivedIdentity;
}> {
  const connection = await connectStarknetWallet();
  const typedData = buildStealthSeedTypedData(
    connection.address,
    connection.chainId ?? 'SN_SEPOLIA',
  );
  const sig = await connection.account.signMessage(typedData);
  const identity = await starknetAdapter.deriveMeta(signatureToSeedBytes(sig));
  return { connection, identity };
}

// ─────────────────────────────────────────────────────────────────────────────
// PQ meta derivation — reused specter-sdk crypto (chain-agnostic).
// ─────────────────────────────────────────────────────────────────────────────

const WALLET_SEED_INFO = utf8ToBytes('p01:web:walletseed:v2');
const SPEND_INFO = utf8ToBytes('p01:stealth:spend:v2');
const VIEW_INFO = utf8ToBytes('p01:stealth:view:v2');
const KEM_INFO = utf8ToBytes('p01:stealth:kem:v2');

/** Secret material held in-session so scan/claim can run after deriveMeta. */
interface StarknetSecretBundle {
  spendingPubKey: Uint8Array; // Ed25519 (32)
  viewingPrivateKey: Uint8Array; // X25519 (32)
  kemSecretKey: Uint8Array; // ML-KEM-768 secret (2400)
}

/** meta-address → secrets. Never serialized; lives only for the session. */
const sessionSecrets = new Map<string, StarknetSecretBundle>();

async function deriveMeta(signature: Uint8Array): Promise<DerivedIdentity> {
  // 1) wallet seed from the SNIP-12 signature (same label as apps/web).
  const walletSeed = hkdf(sha256, signature, undefined, WALLET_SEED_INFO, 32);

  // 2) deterministic sub-seeds for spending / viewing / KEM keys.
  const spendingSeed = hkdf(sha256, walletSeed, undefined, SPEND_INFO, 32);
  const viewingSeed = hkdf(sha256, walletSeed, undefined, VIEW_INFO, 32);
  const kemSeed = hkdf(sha256, walletSeed, undefined, KEM_INFO, 64);

  // 3) spending = Ed25519; viewing = native X25519; KEM = ML-KEM-768 (all
  //    deterministic so the recipient can recover secrets from the signature).
  const spendingKeypair = nacl.sign.keyPair.fromSeed(spendingSeed);
  const spendingPubKey = spendingKeypair.publicKey;

  const viewingKeypair = nacl.box.keyPair.fromSecretKey(viewingSeed);
  const viewingPubKey = viewingKeypair.publicKey;

  const kem = kemGenerateKeypair(kemSeed);

  // 4) v2 hybrid meta-address — identical encoding to the Solana path.
  const meta = encodeStealthMetaAddress(spendingPubKey, viewingPubKey, kem.publicKey);

  sessionSecrets.set(meta, {
    spendingPubKey,
    viewingPrivateKey: viewingSeed,
    kemSecretKey: kem.secretKey,
  });

  return {
    chainId: 'starknet',
    meta,
    spendingPubKey: toHex(spendingPubKey),
    viewingPubKey: toHex(viewingPubKey),
    kemPubKey: toHex(kem.publicKey),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipient resolution.
// ─────────────────────────────────────────────────────────────────────────────

async function resolveRecipient(input: string): Promise<ResolvedRecipient> {
  const trimmed = input.trim();
  // Encoded metas are 'st' + base58 (~1700 chars, no colon) — same format on
  // every chain (that's the point of the chain-agnostic meta).
  if (trimmed.startsWith('st') && trimmed.length > 100) {
    // Validate (throws on malformed / legacy v1 metas).
    parseStealthMetaAddress(trimmed);
    return { meta: trimmed, version: 2, label: 'pasted meta' };
  }
  if (/^0x[0-9a-fA-F]{1,64}$/.test(trimmed)) {
    // Pay-by-wallet needs the on-chain meta registry (register_v2), which is
    // not deployed in Phase 0. Honest failure rather than a fake lookup.
    throw new Error(
      'Pay-by-Starknet-address needs the on-chain meta registry, which is not ' +
        'deployed yet. Paste the recipient’s st… meta-address instead. ' +
        'See contracts/starknet/ARCHITECTURE.md.',
    );
  }
  throw new Error('Enter a Starknet address (0x…) or an st… meta-address.');
}

function quoteFees(asset: Asset, _amount: number): FeeQuote {
  // One multicall: ERC-20 transfer(s) + PQ announcement chunks. The sender also
  // funds the recipient's claim (deploy_account + sweep fees) with a ~1 STRK
  // cushion — surfaced as networkFee. No protocol fee is charged.
  return {
    networkFee: 0.0005,
    protocolFee: 0,
    senderRent: 1, // the STRK claim cushion, in STRK
    minSend: asset.minSend,
    estTime: 'a few seconds',
    approvals: 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Send / scan / claim / register.
// ─────────────────────────────────────────────────────────────────────────────

/** Build an ERC-20 `transfer` call (u256 amount = low, high). */
function erc20TransferCall(token: string, to: string, amountWei: bigint): Call {
  return {
    contractAddress: token,
    entrypoint: 'transfer',
    calldata: CallData.compile([
      to,
      { low: amountWei & ((1n << 128n) - 1n), high: amountWei >> 128n },
    ]),
  };
}

/** Read a u256 ERC-20 balance. */
async function erc20Balance(
  provider: RpcProvider,
  token: string,
  owner: string,
): Promise<bigint> {
  const res = await provider.callContract({
    contractAddress: token,
    entrypoint: 'balanceOf',
    calldata: CallData.compile([owner]),
  });
  const low = BigInt(res[0] ?? '0x0');
  const high = BigInt(res[1] ?? '0x0');
  return low + (high << 128n);
}

async function send(params: SendParams): Promise<TxRef> {
  const { recipient, asset, amount } = params;
  const cfg = requireChainConfig();
  const signer = requireStarknetSigner();

  const token = cfg.tokens?.[asset.symbol] ?? STARKNET_TOKENS[asset.symbol];
  if (!token) throw new Error(`No Starknet token address for ${asset.symbol}.`);

  // REAL PQ discovery half: one-time counterfactual stealth account + ML-KEM
  // announcement payload. This is the part that survives quantum.
  const target = generateStarknetStealth(recipient.meta, cfg.accountClassHash);

  const transport = new StarknetTransport({
    nodeUrl: cfg.nodeUrl,
    announcerAddress: cfg.announcerAddress,
    explorerBase: cfg.explorerBase,
    fromBlock: cfg.fromBlock,
  });
  const announceCalls = transport.buildAnnounceCalls({
    announcementId: target.address,
    viewTag: target.viewTag,
    viewingKeyTag: 0, // reserved for PQ viewing-key disclosure
    ephemeralPubkey: target.ephemeralPubKey,
    ciphertext: target.kemCiphertext,
  });

  // Value half (plan B while STRK20 SDK access is gated): a standard ERC-20
  // transfer to the stealth account, plus a STRK cushion so the recipient's
  // claim can pay its own deploy + sweep fees. Amounts are PUBLIC on this
  // path — recipient privacy (who receives) is what our layer hides. The
  // STRK20 pool swap-in later makes the amount confidential too.
  const amountWei = toBaseUnits(amount, asset.decimals);
  const cushion = cfg.claimCushionWei ?? DEFAULT_CLAIM_CUSHION_WEI;
  const strkToken = cfg.tokens?.STRK ?? STARKNET_TOKENS.STRK!;

  const calls: Call[] = [];
  if (asset.symbol === 'STRK') {
    calls.push(erc20TransferCall(strkToken, target.address, amountWei + cushion));
  } else {
    calls.push(erc20TransferCall(token, target.address, amountWei));
    calls.push(erc20TransferCall(strkToken, target.address, cushion));
  }
  calls.push(...announceCalls);

  // One wallet approval: transfer(s) + full PQ announcement, atomically.
  const { transaction_hash } = await signer.account.execute(calls);
  return {
    signature: transaction_hash,
    explorerUrl: cfg.explorerBase
      ? `${cfg.explorerBase.replace(/\/$/, '')}/tx/${transaction_hash}`
      : undefined,
  };
}

/** Scan results carry spend authority — keep them out of the UI payload. */
const claimCache = new Map<string, { key: StarknetStealthKey; token: string; amountWei: bigint }>();

async function scan(identity: DerivedIdentity): Promise<StealthPayment[]> {
  const cfg = getStarknetChainConfig();
  if (!cfg.nodeUrl || !cfg.announcerAddress) {
    // pq_announcer not deployed / not configured → nothing to scan yet.
    return [];
  }
  const secrets = sessionSecrets.get(identity.meta);
  if (!secrets) {
    throw new Error(
      'Starknet stealth secrets are not in this session. Call deriveMeta ' +
        '(connect + sign) before scanning.',
    );
  }

  const transport = new StarknetTransport({
    nodeUrl: cfg.nodeUrl,
    announcerAddress: cfg.announcerAddress,
    explorerBase: cfg.explorerBase,
    fromBlock: cfg.fromBlock,
  });
  const provider = new RpcProvider({ nodeUrl: cfg.nodeUrl });

  const raws = await transport.scan();
  claimCache.clear();
  const found: { blockNumber: number; payment: StealthPayment }[] = [];

  for (const raw of raws) {
    try {
      const key = deriveStarknetStealthKey({
        spendingPubKey: secrets.spendingPubKey,
        viewingPrivateKey: secrets.viewingPrivateKey,
        kemSecretKey: secrets.kemSecretKey,
        ephemeralPubKey: raw.ephemeralPubkey,
        kemCiphertext: raw.ciphertext,
        viewTag: Number(BigInt(raw.viewTag) & 0xffn),
        accountClassHash: cfg.accountClassHash,
      });
      if (!key) continue; // view tag mismatch — not ours

      // Spoof guard: the announcement must point at the address we derive.
      if (BigInt(key.address) !== BigInt(raw.announcementId)) continue;

      // Balance probe per supported token — a claimed/empty account drops out.
      // STRK balances at or below the sweep fee margin are claim residue
      // (the 0.5 STRK a past sweep left behind for its own fee), not payments.
      const decimalsFor: Record<string, number> = { ETH: 18, STRK: 18, USDC: 6 };
      for (const [symbol, token] of Object.entries(cfg.tokens ?? STARKNET_TOKENS)) {
        if (!token) continue;
        const bal = await erc20Balance(provider, token, key.address);
        if (bal === 0n) continue;
        if (symbol === 'STRK' && bal <= STRK_SWEEP_FEE_MARGIN) continue;
        const id = `${key.address}:${symbol}`;
        claimCache.set(id, { key, token, amountWei: bal });
        found.push({
          blockNumber: raw.blockNumber ?? -1,
          payment: {
            id,
            stealthAddress: key.address,
            amount: Number(bal) / 10 ** (decimalsFor[symbol] ?? 18),
            assetSymbol: symbol,
            ephemeralPubKey: toHex(raw.ephemeralPubkey),
            // The announcement event carries no timestamp — 0 = unknown,
            // rather than stamping every old payment with "now".
            receivedAt: 0,
            claimed: false,
          },
        });
      }
    } catch {
      // Not ours (or a malformed chunk) — skip.
      continue;
    }
  }

  // Newest first when the transport supplied block numbers; announcements
  // without one (blockNumber -1) sink to the end.
  found.sort((a, b) => b.blockNumber - a.blockNumber);
  return found.map((f) => f.payment);
}

async function claim(
  payment: StealthPayment,
  identity: DerivedIdentity,
  destination: string,
): Promise<TxRef> {
  const cfg = requireChainConfig();
  const secrets = sessionSecrets.get(identity.meta);
  if (!secrets) {
    throw new Error('Starknet stealth secrets are not in this session. Call deriveMeta first.');
  }
  const cached = claimCache.get(payment.id);
  if (!cached) {
    throw new Error('Unknown payment. Re-scan before claiming.');
  }

  const provider = new RpcProvider({ nodeUrl: cfg.nodeUrl });
  const { key, token } = cached;
  const account = new Account({
    provider,
    address: key.address,
    signer: key.starkPrivKey,
  });
  const classHash = cfg.accountClassHash ?? DEFAULT_OZ_ACCOUNT_CLASS_HASH;

  // 1) Deploy the counterfactual account if this is its first claim. Fees come
  //    from the STRK cushion the sender included.
  let deployed = true;
  try {
    await provider.getClassHashAt(key.address);
  } catch {
    deployed = false;
  }
  if (!deployed) {
    const res = await account.deployAccount({
      classHash,
      constructorCalldata: CallData.compile([key.starkPubKey]),
      addressSalt: key.starkPubKey,
      contractAddress: key.address,
    });
    await provider.waitForTransaction(res.transaction_hash);
  }

  // 2) Sweep to the destination. Non-STRK tokens move whole; STRK keeps a
  //    fee margin so the sweep tx can pay for itself.
  const strkToken = cfg.tokens?.STRK ?? STARKNET_TOKENS.STRK!;
  const calls: Call[] = [];

  const tokenBal = await erc20Balance(provider, token, key.address);
  if (token === strkToken) {
    const sweep = tokenBal > STRK_SWEEP_FEE_MARGIN ? tokenBal - STRK_SWEEP_FEE_MARGIN : 0n;
    if (sweep === 0n) throw new Error('Balance too low to claim (below the fee margin).');
    calls.push(erc20TransferCall(strkToken, destination, sweep));
  } else {
    if (tokenBal === 0n) throw new Error('Nothing left to claim at this address.');
    calls.push(erc20TransferCall(token, destination, tokenBal));
  }

  const { transaction_hash } = await account.execute(calls);
  return {
    signature: transaction_hash,
    explorerUrl: cfg.explorerBase
      ? `${cfg.explorerBase.replace(/\/$/, '')}/tx/${transaction_hash}`
      : undefined,
  };
}

async function registerSelf(identity: DerivedIdentity): Promise<TxRef> {
  // register_v2 needs the on-chain meta registry (STRK20 side) → gated.
  return strk20Client.register({ meta: identity.meta, owner: identity.meta });
}

// ─────────────────────────────────────────────────────────────────────────────

export const starknetAdapter: ChainStealthAdapter = {
  id: 'starknet',
  label: 'Starknet',
  status: 'live',
  assets: [STRK_STARKNET, ETH_STARKNET, USDC_STARKNET],
  deriveMeta,
  resolveRecipient,
  quoteFees,
  send,
  scan,
  claim,
  registerSelf,
};

/** Forget every secret held in-session (call on wallet disconnect/switch).
 *  Zeroes the byte buffers in sessionSecrets (ML-KEM secret, X25519 viewing
 *  private), then drops both maps. claimCache's starkPrivKey is a hex string
 *  (immutable) — clearing the map dereferences it for GC. */
export function clearStarknetSessions(): void {
  for (const secrets of sessionSecrets.values()) {
    secrets.spendingPubKey.fill(0);
    secrets.viewingPrivateKey.fill(0);
    secrets.kemSecretKey.fill(0);
  }
  sessionSecrets.clear();
  claimCache.clear();
}
