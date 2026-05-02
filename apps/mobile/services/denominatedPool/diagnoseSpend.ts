// Read-only diagnostic helper for the spend flow on a denominated shielded note.
//
// When a `simulateTransaction` fails (or before any spend), call
// `diagnoseSpend(receipt, connection, poolConfig)` to produce a structured
// JSON snapshot of every dimension that could be wrong:
//
//   - receipt completeness (leafIndex / merkleRoot / path data)
//   - on-chain pool state (current root + 100-entry historical ring)
//   - maturity (epoch delay + current epoch)
//   - leaf scan vs receipt commitment
//   - local Merkle rebuild vs on-chain (current + ring)
//   - nullifier PDA already exists on-chain
//
// The result is a single JSON object emitted to logcat with the [P01_DIAG] tag,
// safe to consume via `adb logcat -s ReactNativeJS | grep P01_DIAG`.
//
// This helper never mutates state and never throws. Every step is wrapped in
// a try/catch that records the failure rather than aborting the whole report.

import { type Connection } from '@solana/web3.js';
import {
  type PoolConfig,
  type ShieldReceipt,
  fetchPoolLeavesByIndex,
  parseFilledSubtrees,
  buildMerkleProofFromLeaves,
  replayMerkleProofFromEvents,
  deriveNullifierPDA,
  bigintToLeBytes32,
  slotToEpoch,
  MERKLE_DEPTH,
  createNullifier,
} from './index';
import { parsePoolAccount, bytesToHex, rootInRing } from './parsePool';
import { decodeSimError, type DecodedSimError, type SimResult } from './errorCatalog';

export interface DiagnosticReport {
  /** ISO timestamp of the diagnostic. */
  timestamp: string;
  /** Pool the note belongs to. */
  pool: {
    poolPDA: string;
    treePDA: string;
    token: 'SOL' | 'USDC';
    denomination: number;
  };
  /** Receipt as it sits in the store. */
  receipt: {
    commitment: string;
    leafIndex: number | undefined;
    leafIndexValid: boolean;
    depositEpoch: string;
    hasMerkleRoot: boolean;
    hasMerklePath: boolean;
    storedMerkleRoot: string | null;
  };
  /** On-chain pool snapshot, parsed from the ShieldedPool account. */
  poolState:
    | {
        ok: true;
        isActive: boolean;
        currentRoot: string;
        nextLeafIndex: string;
        totalShielded: string;
        historicalRootCount: number;
        historicalRootsSample: string[]; // first + last few
      }
    | { ok: false; error: string };
  /** Maturity check. */
  maturity:
    | {
        ok: true;
        currentSlot: number;
        currentEpoch: string;
        depositEpoch: string;
        epochsElapsed: string;
        // We don't know epochDelay from the pool struct (it's elsewhere), so
        // we just report counts. Caller can compare to PoolConfig.
        isMatureAssumingDelayOf1Epoch: boolean;
      }
    | { ok: false; error: string };
  /** Local merkle rebuild attempt. */
  rebuild:
    | {
        ok: true;
        scannedLeaves: number;
        missingLeafIndices: number[];
        leafCountFromTree: number;
        leafAtTargetMatchesReceipt: boolean;
        computedRoot: string;
        computedMatchesCurrent: boolean;
        computedInHistoricalRing: boolean;
        ringPosition: number | null;
      }
    | { ok: false; error: string };
  /** Nullifier PDA existence check. */
  nullifier:
    | {
        ok: true;
        nullifierPDA: string;
        alreadyExists: boolean;
      }
    | { ok: false; error: string };
  /** Decoded error if a sim result was provided. */
  simError?: DecodedSimError;
  /** One-word verdict to make scanning the report easy. */
  verdict:
    | 'OK'
    | 'NEEDS_MATURITY'
    | 'STALE_ROOT'
    | 'DIVERGENT_REBUILD'
    | 'NULLIFIER_USED'
    | 'POOL_INACTIVE'
    | 'CORRUPT_RECEIPT'
    | 'INCONCLUSIVE';
  /** Actionable hints. */
  hints: string[];
}

const MAX_LEAVES = 1 << MERKLE_DEPTH;
const SCAN_MAX_SIGNATURES = 15000;
const SLOTS_PER_EPOCH = 432000; // matches consensus default; aligned with index.ts

/**
 * Produce a complete diagnostic. Read-only — does not send any tx, does not
 * mutate any store. Designed to be safe to call from any error handler.
 */
export async function diagnoseSpend(
  receipt: ShieldReceipt,
  connection: Connection,
  poolConfig: PoolConfig,
  simResultForDecode?: SimResult | null,
): Promise<DiagnosticReport> {
  const hints: string[] = [];
  const timestamp = new Date().toISOString();

  // Phase 1: receipt
  const receiptDigest: DiagnosticReport['receipt'] = {
    commitment: receipt.commitment.toString(),
    leafIndex: receipt.leafIndex,
    leafIndexValid:
      Number.isInteger(receipt.leafIndex) &&
      receipt.leafIndex >= 0 &&
      receipt.leafIndex < MAX_LEAVES,
    depositEpoch: receipt.depositEpoch.toString(),
    hasMerkleRoot: receipt.merkleRoot !== undefined,
    hasMerklePath:
      Array.isArray(receipt.merklePathElements) &&
      Array.isArray(receipt.merklePathIndices) &&
      receipt.merklePathElements.length > 0,
    storedMerkleRoot:
      receipt.merkleRoot !== undefined ? '0x' + receipt.merkleRoot.toString(16) : null,
  };

  // Phase 2: on-chain pool state
  let poolState: DiagnosticReport['poolState'];
  let parsedPool = null as Awaited<ReturnType<typeof parsePoolAccount>>;
  try {
    const acc = await connection.getAccountInfo(poolConfig.poolPDA);
    if (!acc) throw new Error('Pool account not found on-chain');
    parsedPool = parsePoolAccount(acc.data);
    if (!parsedPool) throw new Error('Pool account layout did not parse — schema drift?');
    const ringSampleSize = Math.min(parsedPool.historicalRoots.length, 6);
    const ringSample: string[] = [];
    for (let i = 0; i < ringSampleSize; i++) ringSample.push(bytesToHex(parsedPool.historicalRoots[i]));
    if (parsedPool.historicalRoots.length > 6) {
      ringSample.push('...');
      const lastIdx = parsedPool.historicalRoots.length - 1;
      ringSample.push(bytesToHex(parsedPool.historicalRoots[lastIdx]));
    }
    poolState = {
      ok: true,
      isActive: parsedPool.isActive,
      currentRoot: bytesToHex(parsedPool.currentRoot),
      nextLeafIndex: parsedPool.nextLeafIndex.toString(),
      totalShielded: parsedPool.totalShielded.toString(),
      historicalRootCount: parsedPool.historicalRoots.length,
      historicalRootsSample: ringSample,
    };
    if (!parsedPool.isActive) hints.push('Pool is not active on-chain — spends will fail.');
  } catch (e: any) {
    poolState = { ok: false, error: e?.message ?? String(e) };
  }

  // Phase 3: maturity
  let maturity: DiagnosticReport['maturity'];
  try {
    const slot = await connection.getSlot('confirmed');
    const currentEpoch = slotToEpoch(slot);
    const depositEpoch = receipt.depositEpoch;
    const elapsed = currentEpoch - depositEpoch;
    maturity = {
      ok: true,
      currentSlot: slot,
      currentEpoch: currentEpoch.toString(),
      depositEpoch: depositEpoch.toString(),
      epochsElapsed: elapsed.toString(),
      isMatureAssumingDelayOf1Epoch: elapsed >= 1n,
    };
    if (elapsed < 1n) hints.push('Note may be too young — wait at least one epoch after the shield.');
  } catch (e: any) {
    maturity = { ok: false, error: e?.message ?? String(e) };
  }

  // Phase 4: local merkle rebuild
  let rebuild: DiagnosticReport['rebuild'];
  let computedRootHex: string | null = null;
  let computedInRing = false;
  let computedMatchesCurrent = false;
  try {
    if (!receiptDigest.leafIndexValid) {
      throw new Error(`receipt.leafIndex is invalid: ${receipt.leafIndex}`);
    }
    const treeAccount = await connection.getAccountInfo(poolConfig.treePDA);
    if (!treeAccount) throw new Error('Merkle tree account not found');
    const { leafCount } = parseFilledSubtrees(treeAccount.data);

    const { leavesByIndex, missing } = await fetchPoolLeavesByIndex(connection, poolConfig.poolPDA, {
      maxSignatures: SCAN_MAX_SIGNATURES,
    });
    while (leavesByIndex.length < leafCount) leavesByIndex.push(0n);
    const leafAtTarget = leavesByIndex[receipt.leafIndex];
    const leafMatches = leafAtTarget === receipt.commitment;

    // Use replay to mirror ensureMerkleProof behavior: the on-chain "tree" is
    // computed with stale subtrees (insert_with_root only persists level 0),
    // so a pure rebuild would diverge from on-chain by design.
    const { root: computedRoot } = replayMerkleProofFromEvents({
      leavesByIndex,
      targetLeafIndex: receipt.leafIndex,
    });
    computedRootHex = '0x' + computedRoot.toString(16).padStart(64, '0');

    if (parsedPool) {
      const rootBytes = new Uint8Array(32);
      let tmp = computedRoot;
      for (let i = 0; i < 32; i++) {
        rootBytes[i] = Number(tmp & 0xffn);
        tmp >>= 8n;
      }
      // Compare against current and ring.
      computedMatchesCurrent = (() => {
        for (let i = 0; i < 32; i++) {
          if (rootBytes[i] !== parsedPool.currentRoot[i]) return false;
        }
        return true;
      })();
      const ringPos = rootInRing(rootBytes, parsedPool.historicalRoots);
      computedInRing = ringPos !== null;
      rebuild = {
        ok: true,
        scannedLeaves: leavesByIndex.length,
        missingLeafIndices: missing.slice(0, 16),
        leafCountFromTree: leafCount,
        leafAtTargetMatchesReceipt: leafMatches,
        computedRoot: computedRootHex,
        computedMatchesCurrent,
        computedInHistoricalRing: computedInRing,
        ringPosition: ringPos,
      };
    } else {
      rebuild = {
        ok: true,
        scannedLeaves: leavesByIndex.length,
        missingLeafIndices: missing.slice(0, 16),
        leafCountFromTree: leafCount,
        leafAtTargetMatchesReceipt: leafMatches,
        computedRoot: computedRootHex,
        computedMatchesCurrent: false,
        computedInHistoricalRing: false,
        ringPosition: null,
      };
    }

    if (!leafMatches) hints.push(`Leaf at index ${receipt.leafIndex} does not match receipt commitment — pool re-deployed or scan missed leaves.`);
    if (missing.length > 0) hints.push(`${missing.length} leaves missing from rebuild scan; raise SCAN_MAX_SIGNATURES if this persists.`);
    if (parsedPool && !computedMatchesCurrent && !computedInRing) {
      hints.push('Local computed root is NOT in the on-chain historical ring — the proof root will be rejected by is_valid_root.');
    } else if (parsedPool && !computedMatchesCurrent && computedInRing) {
      hints.push(`Local computed root is in the historical ring at position ${rebuild.ringPosition}. Acceptable but stale, prefer current root.`);
    }
  } catch (e: any) {
    rebuild = { ok: false, error: e?.message ?? String(e) };
  }

  // Phase 5: nullifier already exists on-chain
  let nullifier: DiagnosticReport['nullifier'];
  try {
    const nullifierBig = createNullifier(receipt.nullifierPreimage, receipt.secret);
    const nullifierBytes = bigintToLeBytes32(nullifierBig);
    const [nullifierPDA] = deriveNullifierPDA(poolConfig.poolPDA, nullifierBytes);
    const nAcc = await connection.getAccountInfo(nullifierPDA);
    nullifier = {
      ok: true,
      nullifierPDA: nullifierPDA.toBase58(),
      alreadyExists: nAcc !== null,
    };
    if (nAcc !== null) hints.push('Nullifier already exists on-chain — this note has already been spent.');
  } catch (e: any) {
    nullifier = { ok: false, error: e?.message ?? String(e) };
  }

  // Phase 6: decode any provided simulation error
  const simError = simResultForDecode ? decodeSimError(simResultForDecode) : undefined;
  if (simError) {
    if (simError.errorCode === 6002) hints.push('On-chain returned InvalidMerkleRoot — confirms a root mismatch.');
    if (simError.errorCode === 6001) hints.push('On-chain returned NullifierAlreadySpent — note is double-spend.');
    if (simError.errorCode === 6023) hints.push('On-chain returned EpochDelayNotMet — note is too young.');
  }

  // Compute verdict from the strongest signal.
  let verdict: DiagnosticReport['verdict'] = 'INCONCLUSIVE';
  if (poolState.ok && !poolState.isActive) verdict = 'POOL_INACTIVE';
  else if (nullifier.ok && nullifier.alreadyExists) verdict = 'NULLIFIER_USED';
  else if (
    rebuild.ok &&
    !rebuild.leafAtTargetMatchesReceipt
  )
    verdict = 'CORRUPT_RECEIPT';
  else if (
    rebuild.ok &&
    !rebuild.computedMatchesCurrent &&
    !rebuild.computedInHistoricalRing
  )
    verdict = 'DIVERGENT_REBUILD';
  else if (
    rebuild.ok &&
    !rebuild.computedMatchesCurrent &&
    rebuild.computedInHistoricalRing
  )
    verdict = 'STALE_ROOT';
  else if (maturity.ok && !maturity.isMatureAssumingDelayOf1Epoch) verdict = 'NEEDS_MATURITY';
  else verdict = 'OK';

  if (simError?.errorCode === 6002 && verdict === 'OK') {
    // The chain says merkle root is invalid but our local rebuild says everything is current.
    // That means a concurrent shield landed between rebuild and submit.
    verdict = 'STALE_ROOT';
    hints.push('Local rebuild looks current but on-chain rejected — likely a concurrent shield raced past the rebuild.');
  }

  return {
    timestamp,
    pool: {
      poolPDA: poolConfig.poolPDA.toBase58(),
      treePDA: poolConfig.treePDA.toBase58(),
      token: poolConfig.token,
      denomination: poolConfig.denomination,
    },
    receipt: receiptDigest,
    poolState,
    maturity,
    rebuild,
    nullifier,
    simError,
    verdict,
    hints,
  };
}

/**
 * Pretty-print a `DiagnosticReport` to logcat with the `[P01_DIAG]` tag so it
 * is grep-able from `adb logcat`.
 */
export function logDiagnostic(report: DiagnosticReport, label?: string): void {
  // Single-line JSON line so logcat doesn't fragment the report across many
  // entries. The full structure is preserved.
  const tag = label ? `[P01_DIAG:${label}]` : '[P01_DIAG]';
  // Convert any BigInt that may have leaked in with a stringifier replacer.
  const json = JSON.stringify(report, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  // We use console.log so it lands at the default ReactNativeJS log level.
  // eslint-disable-next-line no-console
  console.log(`${tag} ${json}`);
}
