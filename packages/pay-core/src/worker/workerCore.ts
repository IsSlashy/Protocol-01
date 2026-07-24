/**
 * workerCore — framework-agnostic stealth crypto core (secret holder).
 *
 * This is the ONLY place spending/viewing/ML-KEM secrets and derived one-time
 * stealth keypairs exist. It runs inside a Web Worker in BOTH apps/web (Next 16)
 * and apps/extension (Vite); the per-app Worker entry is a thin wrapper that
 * pipes `self.onmessage` -> `handleWorkerRequest` -> `postMessage`. Nothing here
 * imports a Next- or Vite-specific API — only @noble/*, @solana/web3.js and
 * @protocol-01/specter-sdk.
 *
 * Secret-isolation contract:
 *   - `deriveMeta` turns a wallet signature into a full key set and stashes the
 *     SECRETS in a module-level session keyed by the PUBLIC meta string. Only the
 *     public identity leaves.
 *   - `scan` / `claim` look the session up by meta and use the secrets locally;
 *     only public payment views / signatures leave.
 *   - `buildSend` / `registerSelf` need NO secret — they assemble unsigned
 *     transactions from public data (recipient meta, sender pubkey). The wallet
 *     (never seen here) signs them.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  // key derivation
  deriveKeypair,
  STEALTH_DERIVATION,
  ed25519PublicKeyToX25519,
  ed25519SecretKeyToX25519,
  kemGenerateKeypair,
  deriveKemSeed,
  encodeStealthMetaAddress,
  decodeStealthMetaAddress,
  // stealth address generation + scanning + claiming
  generateStealthAddress,
  buildInitStealthV2Ix,
  buildKemChunkIxs,
  StealthScanner,
  claimStealth,
  // registry lookup
  lookupMetaAddress,
  getRegistryPDA,
  entryToMetaAddress,
  // program ids
  DEFAULT_PROGRAM_ID,
  REGISTRY_PROGRAM_ID,
  type Cluster,
  type StealthMetaAddress,
  type StealthPayment as SdkStealthPayment,
} from '@protocol-01/specter-sdk/core';
import type {
  DerivedIdentity,
  ResolvedRecipient,
  StealthPayment,
  TxRef,
} from '../types';
import type {
  BuildSendRequest,
  BuildSendResponse,
  ClaimRequest,
  ClaimResponse,
  DeriveMetaRequest,
  DeriveMetaResponse,
  RegisterSelfRequest,
  RegisterSelfResponse,
  ResolveRecipientRequest,
  ResolveRecipientResponse,
  ResponseFor,
  ScanRequest,
  ScanResponse,
  SolanaWorkerConfig,
  WorkerRequest,
  WorkerResponse,
} from './messages';

function anchorDiscriminator(prefix: string, name: string): Buffer {
  return Buffer.from(sha256(utf8ToBytes(`${prefix}:${name}`)).slice(0, 8));
}

// ===========================================================================
// Module configuration + secret session store
// ===========================================================================

interface CoreContext {
  connection: Connection;
  cluster: Cluster;
  programId: PublicKey;
  registryProgramId: PublicKey;
  usdcMint: PublicKey;
}

/** Circle's devnet USDC mint (faucet.circle.com). */
const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/** SOL the sender adds to a USDC stealth send so the recipient's claim can pay
 *  its own fee and (if needed) create the destination token account:
 *  claim fee 5000 + ATA rent ~2_039_280 + margin. */
const SPL_CLAIM_FUND_LAMPORTS = 2_500_000n;

let ctx: CoreContext | null = null;

/**
 * Configure the worker core's RPC connection + program ids. The per-app Worker
 * entry calls this once (with the app's RPC endpoint) before dispatching any
 * request that touches the chain (resolveRecipient/buildSend/scan/claim/register).
 */
export function configureWorkerCore(cfg: SolanaWorkerConfig): void {
  const cluster: Cluster = cfg.cluster ?? 'devnet';
  ctx = {
    connection: new Connection(cfg.rpcUrl, 'confirmed'),
    cluster,
    programId: cfg.programId ? new PublicKey(cfg.programId) : DEFAULT_PROGRAM_ID,
    registryProgramId: cfg.registryProgramId
      ? new PublicKey(cfg.registryProgramId)
      : REGISTRY_PROGRAM_ID,
    usdcMint: new PublicKey(cfg.usdcMint ?? DEVNET_USDC_MINT),
  };
}

function requireCtx(): CoreContext {
  if (!ctx) {
    throw new Error(
      'workerCore is not configured. Call configureWorkerCore({ rpcUrl }) from the ' +
        'per-app Worker entry before deriving keys or touching the chain.',
    );
  }
  return ctx;
}

/** Secret material for one derived identity. NEVER leaves this module. */
interface StealthSession {
  meta: string;
  /** Wallet (base58) this identity was derived for. Claims may only pay out to
   *  this wallet; a session without one cannot claim at all. */
  ownerWallet?: string;
  /** Ed25519 spending public key bytes (public — kept for scanner + register). */
  spendingPubKey: Uint8Array;
  /** X25519 viewing private key (scalar) — used for ECDH scan/claim. */
  viewingX25519Priv: Uint8Array;
  /** ML-KEM-768 secret key (2400 bytes). */
  kemSecretKey: Uint8Array;
  /** ML-KEM-768 public key (1184 bytes) — public, kept for register_v2. */
  kemPubKey: Uint8Array;
  /** X25519 viewing public key bytes — public, kept for register_v2. */
  viewingX25519Pub: Uint8Array;
  /** Full SDK payment objects from the last scan, keyed by payment id, so a
   *  later claim has the ephemeral key + KEM ciphertext without re-scanning. */
  scanCache: Map<string, SdkStealthPayment>;
}

const sessions = new Map<string, StealthSession>();

function requireSession(meta: string): StealthSession {
  const s = sessions.get(meta);
  if (!s) {
    throw new Error('No derived keys for this identity. Call deriveMeta first (sign to derive).');
  }
  return s;
}

// ===========================================================================
// Small local encoders (avoid pulling bs58 into pay-core)
// ===========================================================================

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

function explorerUrl(signature: string, cluster: Cluster): string {
  const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

// ===========================================================================
// Handlers
// ===========================================================================

/**
 * Derive the full stealth key set from the wallet signature and retain the
 * secrets in a session. Returns only the PUBLIC identity.
 *
 *   walletSeed = HKDF-SHA256(signature, info='p01:web:walletseed:v2', 64 bytes)
 *   spending/viewing keypairs  = deriveKeypair(walletSeed, STEALTH_DERIVATION.*)
 *   viewing X25519 priv        = ed25519SecretKeyToX25519(viewing seed)
 *   ML-KEM keypair             = kemGenerateKeypair(deriveKemSeed(walletSeed))
 *   meta                       = encodeStealthMetaAddress(spendPub, viewX25519Pub, kemPub)
 */
function handleDeriveMeta(req: DeriveMetaRequest): DeriveMetaResponse {
  const walletSeed = hkdf(sha256, req.signature, undefined, utf8ToBytes('p01:web:walletseed:v2'), 64);
  const seedBuf = Buffer.from(walletSeed);

  const spending = deriveKeypair(seedBuf, STEALTH_DERIVATION.SPENDING_KEY_PATH);
  const viewing = deriveKeypair(seedBuf, STEALTH_DERIVATION.VIEWING_KEY_PATH);

  const spendingPubKey = spending.keypair.publicKey.toBytes();
  // Ed25519 viewing key -> X25519 (Montgomery) so sender & recipient ECDH agree.
  const viewingX25519Priv = ed25519SecretKeyToX25519(Uint8Array.from(viewing.privateKey));
  const viewingX25519Pub = ed25519PublicKeyToX25519(viewing.keypair.publicKey.toBytes());

  const kem = kemGenerateKeypair(deriveKemSeed(walletSeed));

  const meta = encodeStealthMetaAddress(spendingPubKey, viewingX25519Pub, kem.publicKey);

  sessions.set(meta, {
    meta,
    ownerWallet: req.ownerWallet,
    spendingPubKey,
    viewingX25519Priv,
    kemSecretKey: kem.secretKey,
    kemPubKey: kem.publicKey,
    viewingX25519Pub,
    scanCache: new Map(),
  });

  const identity: DerivedIdentity = {
    chainId: 'solana',
    meta,
    spendingPubKey: bytesToHex(spendingPubKey),
    viewingPubKey: bytesToHex(viewingX25519Pub),
    kemPubKey: bytesToHex(kem.publicKey),
  };
  return { kind: 'deriveMeta', identity };
}

/**
 * Resolve a recipient. A pasted meta-address is `st` + base58 (~1700 chars, no
 * colon — encodeStealthMetaAddress format); anything that decodes is required
 * to be v2 hybrid. Short inputs are treated as a wallet address and looked up
 * in the on-chain registry.
 */
async function handleResolveRecipient(req: ResolveRecipientRequest): Promise<ResolveRecipientResponse> {
  const trimmed = req.input.trim();

  // A base58 wallet address is ≤44 chars; an encoded meta is >1000. Anything
  // starting 'st' and clearly longer than a wallet must be a meta-address.
  if (trimmed.startsWith('st') && trimmed.length > 100) {
    // decodeStealthMetaAddress throws on v1 unless allowLegacyV1 — we require v2.
    const decoded = decodeStealthMetaAddress(trimmed);
    if (!decoded.kemPubKey) {
      throw new Error('Recipient meta-address is not v2 hybrid (missing ML-KEM key).');
    }
    return {
      kind: 'resolveRecipient',
      recipient: { meta: trimmed, version: 2, label: 'pasted meta' },
    };
  }

  // Wallet address -> registry lookup.
  const { connection, registryProgramId } = requireCtx();
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(trimmed);
  } catch {
    throw new Error('Enter a Solana wallet address or an st… meta-address.');
  }

  const entry = await lookupMetaAddress(connection, wallet, registryProgramId);
  if (!entry) {
    throw new Error('That wallet has not published a stealth meta-address yet.');
  }
  if (entry.version !== 2 || !entry.kemPubKey) {
    throw new Error('That wallet is registered with a legacy (non-quantum) meta-address.');
  }

  const meta: StealthMetaAddress = entryToMetaAddress(entry);
  const short = `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
  return {
    kind: 'resolveRecipient',
    recipient: { meta: meta.encoded, version: 2, label: entry.name ? `${entry.name} (${short})` : short },
  };
}

/**
 * Assemble the UNSIGNED v2 hybrid send transactions (native SOL only):
 *   tx1:      [computeBudget, init_stealth_v2 header]
 *   tx2..N-1: write_stealth_kem_chunk (streams the 1088-byte ML-KEM ciphertext)
 *   txN:      systemTransfer(sender -> stealth)  ← the ONLY tx that moves funds
 * All txs share one blockhash so the wallet signs them in a single approval.
 * The funds transfer is deliberately LAST: if the announcement or a KEM chunk
 * fails (blockhash expiry, RPC error), the caller aborts before txN and the
 * worst case is a little announcement rent lost — never the payment. A stealth
 * account whose ciphertext never lands would be unclaimable by anyone.
 */
async function handleBuildSend(req: BuildSendRequest): Promise<BuildSendResponse> {
  if (req.assetSymbol !== 'SOL' && req.assetSymbol !== 'USDC') {
    throw new Error(`Unsupported asset '${req.assetSymbol}'. Send SOL or USDC.`);
  }
  const { connection, programId, usdcMint } = requireCtx();
  const sender = new PublicKey(req.senderPubkey);
  const amount = BigInt(req.amountLamports);

  const stealth = generateStealthAddress(req.recipientMeta);
  if (!stealth.kemCiphertext) {
    throw new Error('Recipient meta-address is not v2 hybrid (missing KEM ciphertext).');
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  const tx1 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    buildInitStealthV2Ix({
      programId,
      sender,
      stealthAddress: stealth.address,
      amount,
      ephemeralPubKey: stealth.ephemeralPubKey,
      viewTag: stealth.viewTag,
    }),
  );

  const chunkIxs = buildKemChunkIxs({
    programId,
    sender,
    stealthAddress: stealth.address,
    kemCiphertext: stealth.kemCiphertext,
  });

  // The funds tx (always LAST). SOL: plain transfer. USDC: create the stealth
  // ATA, move the tokens, and top the stealth address up with enough SOL that
  // the recipient's self-funded claim can pay its fee + destination ATA rent.
  const transferTx = new Transaction();
  if (req.assetSymbol === 'USDC') {
    const senderAta = getAssociatedTokenAddressSync(usdcMint, sender);
    const stealthAta = getAssociatedTokenAddressSync(usdcMint, stealth.address);
    transferTx.add(
      createAssociatedTokenAccountIdempotentInstruction(sender, stealthAta, stealth.address, usdcMint),
      createTransferInstruction(senderAta, stealthAta, sender, amount),
      SystemProgram.transfer({
        fromPubkey: sender,
        toPubkey: stealth.address,
        lamports: SPL_CLAIM_FUND_LAMPORTS,
      }),
    );
  } else {
    transferTx.add(
      SystemProgram.transfer({ fromPubkey: sender, toPubkey: stealth.address, lamports: amount }),
    );
  }

  // One-time secret the SDK requires callers to wipe once the ixs are built.
  stealth.ephemeralPrivateKey?.fill(0);

  const txs = [tx1, ...chunkIxs.map((ix) => new Transaction().add(ix)), transferTx];
  const transactionsB64 = txs.map((tx) => {
    tx.recentBlockhash = blockhash;
    tx.feePayer = sender;
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  });

  return {
    kind: 'buildSend',
    transactionsB64,
    stealthAddress: stealth.address.toBase58(),
    blockhash,
    lastValidBlockHeight,
  };
}

/** Scan the chain for inbound payments; cache full SDK payments for claim. */
async function handleScan(req: ScanRequest): Promise<ScanResponse> {
  const { connection, programId, usdcMint } = requireCtx();
  const session = requireSession(req.meta);

  const scanner = new StealthScanner(
    connection,
    session.viewingX25519Priv,
    session.spendingPubKey,
    session.kemSecretKey,
    programId,
  );
  // Default limit is 100 announcements program-wide — raise it so payments
  // don't silently fall off the end as the program grows.
  let found;
  try {
    found = await scanner.scan({ includeClaimed: false, limit: 5000 });
  } catch (err) {
    // The SDK wraps the underlying failure in a generic SpecterError — surface
    // the real cause for diagnosis (public message stays generic), then retry
    // once: public devnet RPC rate limits burst traffic from browsers.
    console.warn('[stealth-worker] scan failed, retrying once:', err, (err as { cause?: unknown }).cause);
    await new Promise((r) => setTimeout(r, 1500));
    found = await scanner.scan({ includeClaimed: false, limit: 5000 });
  }

  session.scanCache.clear();
  const payments: StealthPayment[] = await Promise.all(
    found.map(async (p) => {
      const id = p.stealthAddress.toBase58();

      // USDC detection: the announcement layout carries no mint, so probe the
      // stealth address's USDC ATA. A balance there marks this payment as USDC
      // and flips the cached SDK payment to the token-claim path.
      let assetSymbol = 'SOL';
      let amount = Number(p.amount) / 1e9;
      try {
        const ata = getAssociatedTokenAddressSync(usdcMint, p.stealthAddress);
        const bal = await connection.getTokenAccountBalance(ata);
        if (bal.value.amount !== '0') {
          assetSymbol = 'USDC';
          amount = bal.value.uiAmount ?? Number(bal.value.amount) / 1e6;
          p.tokenMint = usdcMint;
          p.amount = BigInt(bal.value.amount);
        }
      } catch {
        // No token account — native SOL payment.
      }

      session.scanCache.set(id, p);
      return {
        id,
        stealthAddress: id,
        amount,
        assetSymbol,
        ephemeralPubKey: bytesToHex(p.ephemeralPubKey),
        receivedAt: p.blockTime > 0 ? p.blockTime * 1000 : Date.now(),
        claimed: p.claimed,
      };
    }),
  );
  return { kind: 'scan', payments };
}

/** Claim a scanned payment: the SDK derives the one-time stealth keypair from
 *  the session secrets, self-signs the drain, and submits it. */
async function handleClaim(req: ClaimRequest): Promise<ClaimResponse> {
  const { connection, cluster } = requireCtx();
  const session = requireSession(req.meta);
  // Spend-authority guard: a claim self-signs with the derived one-time key, so
  // the destination is the only thing standing between same-origin script and
  // the funds. Lock it to the wallet the identity was derived for — and refuse
  // outright if the session was never bound (an unbound session would let any
  // same-origin script claim to an arbitrary destination).
  if (!session.ownerWallet) {
    throw new Error('This session has no bound wallet; reconnect and re-derive.');
  }
  if (req.destination !== session.ownerWallet) {
    throw new Error('Claims can only be sent to the wallet these keys were derived for.');
  }
  const payment = session.scanCache.get(req.paymentId);
  if (!payment) {
    throw new Error('Unknown payment. Re-scan before claiming.');
  }

  const result = await claimStealth({
    connection,
    payment,
    spendingPubKey: session.spendingPubKey,
    viewingPrivateKey: session.viewingX25519Priv,
    kemSecretKey: session.kemSecretKey,
    destination: new PublicKey(req.destination),
  });

  return {
    kind: 'claim',
    tx: { signature: result.signature, explorerUrl: explorerUrl(result.signature, cluster) },
  };
}

/**
 * Build the UNSIGNED `register_v2` transaction publishing this identity's meta
 * on-chain. Matches programs/p01_registry `register_v2(spending_pub_key: [u8;32],
 * viewing_pub_key: [u8;32], kem_pub_key: Vec<u8>, name: String)` — Borsh, so the
 * Vec<u8> KEM key carries a u32 LE length prefix (privacy-sdk's builder omits it
 * and is broken; do NOT mirror it):
 *   sha256("global:register_v2")[0..8] || spendingPub(32) || viewingPub(32)
 *     || u32le(1184) || kemPub(1184) || u32le(len) || nameBytes
 * with accounts [owner(signer,writable), registryPDA(writable), systemProgram].
 * The wallet (owner) signs + submits.
 */
async function handleRegisterSelf(req: RegisterSelfRequest): Promise<RegisterSelfResponse> {
  const { connection, registryProgramId, programId: _programId } = requireCtx();
  void _programId;
  const session = requireSession(req.meta);
  const owner = new PublicKey(req.senderPubkey);
  const [registryPDA] = getRegistryPDA(owner, registryProgramId);

  const disc = anchorDiscriminator('global', 'register_v2');
  const nameBytes = Buffer.from(req.name ?? '', 'utf-8');
  const nameLen = Buffer.alloc(4);
  nameLen.writeUInt32LE(nameBytes.length);
  const kemLen = Buffer.alloc(4);
  kemLen.writeUInt32LE(session.kemPubKey.length);
  const data = Buffer.concat([
    disc,
    Buffer.from(session.spendingPubKey),
    Buffer.from(session.viewingX25519Pub),
    kemLen,
    Buffer.from(session.kemPubKey),
    nameLen,
    nameBytes,
  ]);

  const ix = new TransactionInstruction({
    programId: registryProgramId,
    data,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: registryPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;
  const transactionsB64 = [
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
  ];
  return { kind: 'registerSelf', transactionsB64 };
}

// ===========================================================================
// Dispatch
// ===========================================================================

/**
 * The single RPC entry point. The per-app Worker entry pipes messages into this
 * and posts the result back. Also used directly by the in-process client.
 */
export async function handleWorkerRequest<R extends WorkerRequest>(req: R): Promise<ResponseFor<R>> {
  let res: WorkerResponse;
  switch (req.kind) {
    case 'deriveMeta':
      res = handleDeriveMeta(req);
      break;
    case 'resolveRecipient':
      res = await handleResolveRecipient(req);
      break;
    case 'buildSend':
      res = await handleBuildSend(req);
      break;
    case 'scan':
      res = await handleScan(req);
      break;
    case 'claim':
      res = await handleClaim(req);
      break;
    case 'registerSelf':
      res = await handleRegisterSelf(req);
      break;
    case 'clearSessions':
      sessions.clear();
      res = { kind: 'clearSessions' };
      break;
    default: {
      const _exhaustive: never = req;
      throw new Error(`Unknown worker request: ${JSON.stringify(_exhaustive)}`);
    }
  }
  return res as ResponseFor<R>;
}

/** Test/diagnostic helper: forget all in-memory secret sessions. */
export function clearWorkerSessions(): void {
  sessions.clear();
}
