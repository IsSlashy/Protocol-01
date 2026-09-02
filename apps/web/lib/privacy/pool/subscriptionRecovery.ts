/**
 * subscriptionRecovery — find this identity's subscription vaults on chain with
 * no local record, so the subscription store becomes a CACHE instead of the
 * only pointer to money already spent.
 *
 * ## What it recovers, and from what
 *
 * A private vault's PDA is seeded on `subscriber_commitment`, the circuit-0
 * Poseidon commitment over the paying note's secret. The secret derives from
 * `(walletSeed, poolPDA, counter)` — so every input is reproducible from the
 * seed, and a browser with NOTHING stored can still recompute every commitment
 * it could ever have subscribed with and recognise its own vaults. A match
 * recovers vaultPDA, retailer, rate, intervalSlots, sourcePool AND which note
 * paid (pool + leafIndex), which is exactly what license-key re-derivation
 * needs. Only serviceName / openTxSig / openedAt are unrecoverable, and they
 * are cosmetic.
 *
 * ## 🚨 THE RPC SHAPE IS THE POINT — read before "simplifying" it
 *
 * The obvious implementation — derive each note's vault PDA and probe it with
 * `getAccountInfo(vaultPDA)` — is leak L4 in a new costume. It hands the RPC a
 * list of identifiers derived from THIS user's note secrets, for notes that may
 * never subscribe to anything. The day one of those PDAs is created by a real
 * subscribe, the provider joins on the address and recovers the IP that
 * pre-queried it: a full deanonymisation channel that needs no relayer
 * participation. That is the exact channel `fetchSpentNullifierSet` closed for
 * nullifier PDAs this morning; read its header in `denominatedPool.ts`.
 *
 * So this module asks ONE question whose answer is identical for every user —
 * "every SubscriptionVault account of the program", a discriminator-filtered
 * `getProgramAccounts` — and matches locally against commitments derived in
 * here. The only other reads are `getAccountInfo` on the pool TREE accounts,
 * fixed table constants every client reads on every shield. Nothing derived
 * from a note secret is ever sent. The response is bounded by the program's
 * live vault count (14 on devnet today, each ≤ 361 bytes), and a vault closed
 * by the merchant's final claim no longer exists to enumerate — which is fine,
 * because there is nothing left to recover in it.
 *
 * ## Where it runs
 *
 * In the stealth Worker only: candidate secrets come from the pool seeds and
 * from decrypted note blobs, and neither may cross to the main thread. Only
 * the whitelisted public result fields do (`poolHandlers.ts`).
 *
 * The commitment function is INJECTED, not chosen: callers must pass the same
 * `starkProver.computeCommitment` the subscribe prepare path calls
 * (`handlePoolSubscribePrepare`), because a second implementation that drifts
 * by one bit finds nothing and looks exactly like data loss.
 */

import { Buffer } from 'buffer';
import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';

import {
  ALL_POOLS_V3,
  ZK_SHIELDED_PROGRAM_ID,
  deriveNoteMaterial,
  type PoolConfig,
} from './denominatedPool';
import { readTreeLeafCount } from './shieldEphemeral';
import { deriveSubscriptionVaultPDA, goldilocksU64To32 } from './subscribePrivateStark';
import {
  SUBSCRIPTION_VAULT_DISCRIMINATOR,
  bytesToHex,
  decodeSubscriptionVault,
  type DecodedSubscriptionVault,
} from './subscriptionVaultAccount';
import {
  licenseTagCandidates,
  matchLicenseServiceTag,
  type LicenseTagListing,
} from '../licenseTagMatch';

/**
 * The one filter the enumeration sends: the account discriminator at offset 0.
 *
 * NOT a `dataSize` filter — the vault account exists in three sizes (263, 328,
 * 361 bytes; see `subscriptionVaultAccount.ts`) and pinning one would silently
 * drop the other two generations. And emphatically NOT a memcmp on the
 * `subscriber_commitment` field: that would put a secret-derived value in the
 * request, which is the exact leak this module exists to avoid.
 *
 * base64, not base58, for the same reason as `serviceRegistry.discriminatorFilter`:
 * base58 would pull in `bs58`, and web3.js accepts either encoding.
 */
export function subscriptionVaultFilter(): {
  memcmp: { offset: number; bytes: string; encoding: 'base64' };
} {
  return {
    memcmp: {
      offset: 0,
      bytes: Buffer.from(SUBSCRIPTION_VAULT_DISCRIMINATOR).toString('base64'),
      encoding: 'base64',
    },
  };
}

/** One note secret that might have opened a vault, and where it lives. */
export interface CandidateNoteSecret {
  /** Pool PDA (base58) the note belongs to. */
  pool: string;
  /** Leaf index the note occupies — also its derivation counter. */
  leafIndex: number;
  secret: bigint;
}

/** A recovered subscription. Public values only — same fields the subscribe
 *  path records, minus the three unrecoverable cosmetics. */
export interface RecoveredSubscriptionVault {
  /** Base58 vault PDA — re-derived locally and checked against the account. */
  vaultPDA: string;
  retailer: string;
  /** `NATIVE_SOL_MINT_BASE58` for SOL vaults. */
  tokenMint: string;
  token: 'SOL' | 'USDC';
  /** Whole-token size of the escrowed note, from the pool table. */
  denomination: number;
  /** Decimal strings, as the store carries them. */
  rate: string;
  intervalSlots: string;
  /** The note that paid: its pool and leaf index, hence the license key. */
  pool: string;
  leafIndex: number;
  /** The vault's `license_commitment`, lowercase hex; null when it stores none. */
  licenseCommitment: string | null;
  /**
   * The service tag the license key is scoped to, VERIFIED: the first of
   * `licenseTagCandidates` (registry slugs on this (retailer, mint) from
   * `opts.services`, then the retailer address) whose derived key hashes to
   * `licenseCommitment`. Null when none does, or the vault stores no
   * commitment. Settled here because this is the one place that holds the
   * matching note secret and the decoded vault together; a tag guessed from
   * a registry join on the main thread was the defect this closes.
   */
  serviceTag: string | null;
}

export interface RecoverSubscriptionVaultsOptions {
  /** Notes whose secrets only local blobs know (received notes). Already
   *  decrypted by the caller — this module never sees ciphertext. */
  blobCandidates?: CandidateNoteSecret[];
  /** The registry roster, reduced to strings, for `serviceTag` above. */
  services?: LicenseTagListing[];
  /**
   * `starkProver.computeCommitment` — the circuit-0 commitment over a note
   * secret, as a decimal string in and out. Injected so there is exactly ONE
   * implementation in the app (the wasm the subscribe path proves against).
   */
  computeSubscriberCommitment: (secretDecimal: string) => Promise<string>;
  onProgress?: (step: string) => void;
}

export interface RecoverSubscriptionVaultsResult {
  recovered: RecoveredSubscriptionVault[];
  /** SubscriptionVault accounts the program-wide enumeration returned —
   *  everyone's, not this identity's. Context for the caller's messaging. */
  vaultsScanned: number;
}

interface EnumeratedVault {
  pubkey: PublicKey;
  decoded: DecodedSubscriptionVault;
}

/**
 * Enumerate every `SubscriptionVault` of the program. One request, identical
 * for every user; membership is decided locally by the caller.
 */
async function fetchAllSubscriptionVaults(connection: Connection): Promise<EnumeratedVault[]> {
  const accounts = await connection.getProgramAccounts(ZK_SHIELDED_PROGRAM_ID, {
    filters: [subscriptionVaultFilter()],
  });
  const out: EnumeratedVault[] = [];
  for (const acc of accounts) {
    try {
      out.push({ pubkey: acc.pubkey, decoded: decodeSubscriptionVault(acc.account.data) });
    } catch {
      // The discriminator matched but the body did not decode: a corrupt or
      // future-generation account. Skipping it can only miss a vault, never
      // invent one, and the sequential decoder already tolerates all three
      // known generations.
    }
  }
  return out;
}

/**
 * Walk this identity's possible note secrets and match them against the
 * program's subscription vaults. See the module header for the leak analysis;
 * the summary is that everything sent over RPC here is identical for every
 * user, and every secret-derived value stays local.
 *
 * Candidate secrets come from two sides:
 *   - derivation: for each seed, every counter `0..leafCount` of each pool a
 *     vault names as its `source_pool` (the counter IS the leaf index, see
 *     `shieldEphemeral.ts`). A counter that was never ours yields a secret
 *     whose commitment matches nothing — a wasted hash, not a wrong match.
 *   - `blobCandidates`: received notes, whose secrets no seed of ours derives.
 *
 * A tree read failing THROWS rather than degrading: a silent partial scan
 * reports "nothing found" for vaults it never checked, which reads as data
 * loss. Loud beats wrong here, exactly as in `recoverNotes`.
 */
export async function recoverSubscriptionVaults(
  connection: Connection,
  seeds: Uint8Array[],
  opts: RecoverSubscriptionVaultsOptions,
): Promise<RecoverSubscriptionVaultsResult> {
  opts.onProgress?.('Reading the subscription vaults...');
  const vaults = await fetchAllSubscriptionVaults(connection);

  // Only commitment-keyed vaults can be ours: a legacy normal-mode vault is
  // keyed by a wallet pubkey and was never opened from a note.
  const privateVaults = vaults.filter((v) => v.decoded.subscriberCommitment !== null);
  if (privateVaults.length === 0) {
    return { recovered: [], vaultsScanned: vaults.length };
  }

  // Pools worth deriving under: the ones the vaults actually name. These come
  // from the enumeration (public chain data), so the set of tree accounts read
  // next is the same for every user who runs this. A vault with no source_pool
  // recorded implicates every pool in the table.
  const poolsByBase58 = new Map<string, PoolConfig>(
    ALL_POOLS_V3.map((p) => [p.poolPDA.toBase58(), p]),
  );
  let implicated: PoolConfig[];
  if (privateVaults.some((v) => v.decoded.sourcePool === null)) {
    implicated = ALL_POOLS_V3;
  } else {
    const named = new Set(privateVaults.map((v) => v.decoded.sourcePool!));
    implicated = [...named]
      .map((b58) => poolsByBase58.get(b58))
      .filter((p): p is PoolConfig => p !== undefined);
  }

  // Candidate secrets. Blob notes first — they are exact — then derivation.
  const candidates: CandidateNoteSecret[] = [];
  const seenNote = new Set<string>();
  for (const c of opts.blobCandidates ?? []) {
    const key = `${c.pool}:${c.leafIndex}`;
    if (seenNote.has(key)) continue;
    seenNote.add(key);
    candidates.push(c);
  }
  opts.onProgress?.('Deriving your candidate notes...');
  for (const pool of implicated) {
    const leafCount = await readTreeLeafCount(connection, pool);
    const poolB58 = pool.poolPDA.toBase58();
    for (const seed of seeds) {
      for (let counter = 0; counter < leafCount; counter++) {
        const { secret } = deriveNoteMaterial(seed, pool.poolPDA, counter);
        candidates.push({ pool: poolB58, leafIndex: counter, secret });
      }
    }
  }

  // Commitments, computed locally (wasm), deduped by secret. The map key is
  // the full 32-byte hex the vault stores: the low 8 bytes are the Goldilocks
  // commitment LE and the high 24 are zero (`goldilocksU64To32`), which is the
  // exact encoding the PDA is seeded on.
  opts.onProgress?.('Matching your notes against the vaults...');
  const byCommitmentHex = new Map<string, CandidateNoteSecret>();
  const seenSecret = new Set<string>();
  for (const candidate of candidates) {
    const decimal = candidate.secret.toString();
    if (seenSecret.has(decimal)) continue;
    seenSecret.add(decimal);
    const commitment = BigInt(await opts.computeSubscriberCommitment(decimal));
    const hex = bytesToHex(goldilocksU64To32(commitment));
    if (!byCommitmentHex.has(hex)) byCommitmentHex.set(hex, candidate);
  }

  const recovered: RecoveredSubscriptionVault[] = [];
  for (const vault of privateVaults) {
    const commitmentBytes = vault.decoded.subscriberCommitment!;
    const candidate = byCommitmentHex.get(bytesToHex(commitmentBytes));
    if (!candidate) continue;

    // The PDA check the brief calls "derive the vault PDA": recompute the
    // address from (retailer, commitment, mint) and require it to be the
    // account we read. A mismatch means the decode drifted from the on-chain
    // layout — recovering a record under a wrong address would be worse than
    // recovering nothing.
    const [derived] = deriveSubscriptionVaultPDA(
      new PublicKey(vault.decoded.retailer),
      commitmentBytes,
      new PublicKey(vault.decoded.tokenMint),
    );
    if (!derived.equals(vault.pubkey)) continue;

    const poolConfig = poolsByBase58.get(candidate.pool);
    if (!poolConfig) continue; // a blob note from a pool this build does not know

    // The tag, checked against the chain while the secret is in hand. Local
    // hashing only; nothing here touches the RPC.
    const licenseCommitment = vault.decoded.licenseCommitment
      ? bytesToHex(vault.decoded.licenseCommitment)
      : null;
    const serviceTag = matchLicenseServiceTag(
      candidate.secret,
      licenseCommitment,
      licenseTagCandidates({
        services: opts.services,
        retailer: vault.decoded.retailer,
        tokenMint: vault.decoded.tokenMint,
      }),
    );

    recovered.push({
      vaultPDA: vault.pubkey.toBase58(),
      retailer: vault.decoded.retailer,
      tokenMint: vault.decoded.tokenMint,
      token: poolConfig.token,
      denomination: poolConfig.denomination,
      rate: vault.decoded.rate.toString(),
      intervalSlots: vault.decoded.intervalSlots.toString(),
      pool: candidate.pool,
      leafIndex: candidate.leafIndex,
      licenseCommitment,
      serviceTag,
    });
  }

  return { recovered, vaultsScanned: vaults.length };
}
