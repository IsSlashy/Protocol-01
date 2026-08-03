/**
 * Permissionless settler keeper for p01_liquidity.
 *
 * ## THIS KEEPER CANNOT SETTLE ANYTHING. It runs in report-only mode.
 *
 * `p01_liquidity::settle` CPIs `zk_shielded::unshield_denominated_stark`,
 * which was retired on purpose by f5bb7514 ("circuit-1 only, no C3 membership
 * = unshield-undeposited risk") and replaced by
 * `unshield_denominated_stark_v3`. Byte-probing the deployed devnet
 * `zk_shielded` confirms the v2 discriminator is not in the binary — run
 * `node scripts/probe-liquidity-exposure.mjs` to reproduce, read-only.
 * `settle` now returns `LiquidityError::SettlementPathRetired` before doing
 * anything, and so does `prefund`. See
 * `programs/p01_liquidity/src/settlement_path.rs` for the checklist that has
 * to be worked before either can be re-opened.
 *
 * So this script scans and reports, and refuses to send. Sending would burn
 * fees on a transaction that cannot succeed. Set `SETTLER_FORCE_SEND=1` to
 * override once the on-chain path exists.
 *
 * It is kept rather than deleted because it is the only client-side record of
 * `settle`'s account order, and the v3 port has to reproduce it.
 *
 * ### The `merkle_tree` seed here is correct — do not "fix" it to `merkle_tree_v4`
 *
 * `deriveTreePDA` uses `b"merkle_tree"`, which is `MerkleTreeState`'s
 * SEED_PREFIX — the v2 tree, paired with `DenominatedPool` (v2) and with the
 * v2 unshield this script drives. `b"merkle_tree_v4"` is `MerkleTreeStateV3`,
 * a different pool version. Changing the seed without porting the whole script
 * to V3 would derive a PDA that does not exist for the v2 pools the live
 * PrefundRecords actually point at.
 *
 * Usage:
 *   npx tsx scripts/run-settler.ts
 *
 * ENV:
 *   RPC_URL            (default: devnet)
 *   ANCHOR_WALLET      (default: ~/.config/solana/id.json) — the settler
 *   SETTLER_FORCE_SEND set to 1 to actually broadcast (see above)
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL, SystemProgram,
} from '@solana/web3.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const P01_LIQUIDITY_ID = new PublicKey('6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg');
const ZK_SHIELDED_ID   = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const PROTOCOL_FEE     = new PublicKey('BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN');
const COMPUTE_BUDGET   = new PublicKey('ComputeBudget111111111111111111111111111111');
const SLOTS_PER_EPOCH  = 7200n;

const RPC = process.env.RPC_URL || 'https://api.devnet.solana.com';

/**
 * `settle` is failed closed on chain (see the header). Broadcasting would only
 * buy a guaranteed failure and a fee, so report-only is the default.
 */
const FORCE_SEND = process.env.SETTLER_FORCE_SEND === '1';

// PrefundRecord layout, must stay in sync with programs/p01_liquidity/src/state/prefund_record.rs
// 8 disc + 32 pool + 32 denom_pool + 32 nullifier + 32 root + 32 inputs_hash
//   + 8 commitment + 8 amount + 8 min_epoch + 32 proof_buffer + 32 ephemeral + 8 reward + 8 slot + 1 bump
const PREFUND_RECORD_LEN = 273;

// Anchor "account discriminator" is sha256("account:PrefundRecord")[..8].
const PREFUND_RECORD_DISC = createHash('sha256')
  .update('account:PrefundRecord')
  .digest()
  .subarray(0, 8);

function disc(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair(): Keypair {
  // Prefer inline JSON for serverless/CI (Vercel Cron, GitHub Actions); fall
  // back to the standard on-disk keypair otherwise.
  const inline = process.env.SETTLER_KEYPAIR_JSON;
  if (inline) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(inline)));
  }
  const p = process.env.ANCHOR_WALLET || join(homedir(), '.config/solana/id.json');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
}

function parsePrefundRecord(data: Buffer) {
  return {
    pool:              new PublicKey(data.subarray(8, 40)),
    denominatedPool:   new PublicKey(data.subarray(40, 72)),
    nullifier:         Uint8Array.from(data.subarray(72, 104)),
    merkleRoot:        Uint8Array.from(data.subarray(104, 136)),
    publicInputsHash:  Uint8Array.from(data.subarray(136, 168)),
    starkCommitment:   data.readBigUInt64LE(168),
    amount:            data.readBigUInt64LE(176),
    minEpoch:          data.readBigUInt64LE(184),
    proofBuffer:       new PublicKey(data.subarray(192, 224)),
    ephemeralSigner:   new PublicKey(data.subarray(224, 256)),
    settlerReward:     data.readBigUInt64LE(256),
    openedAtSlot:      data.readBigUInt64LE(264),
    bump:              data[272],
  };
}

// Parse denominated_pool dynamic_delay the same way mobile fetchPoolInfo does.
// From state/pool.rs: get_dynamic_delay uses mature_note_count thresholds.
function dynamicDelay(matureNoteCount: bigint): bigint {
  if (matureNoteCount >= 1000n) return 0n;
  if (matureNoteCount >= 100n)  return 1n;
  if (matureNoteCount >= 10n)   return 1n;
  return 2n;
}

// DenominatedPool layout — kept in lockstep with apps/mobile/services/denominatedPool/index.ts
// (see fetchPoolInfo for the canonical reader). Walking past historical_roots is required because
// it's a Vec<[u8;32]>, so its length isn't fixed and we can't seek directly to mature_note_count.
async function loadDenomPool(connection: Connection, pda: PublicKey) {
  const acc = await connection.getAccountInfo(pda);
  if (!acc) return null;
  const d = acc.data;
  let off = 8;     // disc
  off += 32;       // authority
  off += 32;       // token_mint
  off += 8;        // denomination
  const epochDelay = d.readBigUInt64LE(off); off += 8;
  off += 32;       // merkle_root
  off += 1;        // tree_depth
  off += 8;        // next_leaf_index
  off += 32;       // vk_hash
  off += 8;        // total_shielded
  off += 8;        // note_count
  off += 1;        // is_active
  const histLen = d.readUInt32LE(off); off += 4;
  off += histLen * 32;
  off += 1;        // max_historical_roots
  off += 8;        // created_at
  off += 8;        // last_tx_at
  off += 1;        // bump
  const matureNoteCount = d.readBigUInt64LE(off);
  return { epochDelay, matureNoteCount };
}

function deriveNullifierPDA(denomPool: PublicKey, nullifier: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('nullifier'), denomPool.toBuffer(), Buffer.from(nullifier)],
    ZK_SHIELDED_ID,
  )[0];
}

function deriveTreePDA(denomPool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_tree'), denomPool.toBuffer()],
    ZK_SHIELDED_ID,
  )[0];
}

function cuLimitIx(units: number): TransactionInstruction {
  const d = Buffer.alloc(5);
  d.writeUInt8(2, 0);
  d.writeUInt32LE(units, 1);
  return new TransactionInstruction({ programId: COMPUTE_BUDGET, keys: [], data: d });
}

function buildSettleIx(args: {
  settler: PublicKey;
  poolPDA: PublicKey;
  prefundRecord: PublicKey;
  denominatedPool: PublicKey;
  merkleTree: PublicKey;
  nullifierRecord: PublicKey;
  starkProofBuffer: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: P01_LIQUIDITY_ID,
    keys: [
      { pubkey: args.settler,          isSigner: true,  isWritable: true  },
      { pubkey: args.poolPDA,          isSigner: false, isWritable: true  },
      { pubkey: args.prefundRecord,    isSigner: false, isWritable: true  },
      { pubkey: args.denominatedPool,  isSigner: false, isWritable: true  },
      { pubkey: args.merkleTree,       isSigner: false, isWritable: false },
      { pubkey: args.nullifierRecord,  isSigner: false, isWritable: true  },
      { pubkey: args.starkProofBuffer, isSigner: false, isWritable: false },
      { pubkey: PROTOCOL_FEE,          isSigner: false, isWritable: true  },
      { pubkey: ZK_SHIELDED_ID,        isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc('settle'),
  });
}

async function main() {
  const connection = new Connection(RPC, 'confirmed');

  console.log('='.repeat(78));
  if (FORCE_SEND) {
    console.log('SETTLER_FORCE_SEND=1 — broadcasting settle transactions.');
    console.log('p01_liquidity::settle returns SettlementPathRetired unless the CPI');
    console.log('target has been restored. Expect every one of these to fail.');
  } else {
    console.log('REPORT-ONLY. No transaction will be sent.');
    console.log('p01_liquidity::settle CPIs zk_shielded::unshield_denominated_stark,');
    console.log('retired by f5bb7514 and absent from the deployed binary, so settle');
    console.log('fails closed with SettlementPathRetired. Every PrefundRecord found');
    console.log('below is stranded until the v3 prefund path exists — see');
    console.log('programs/p01_liquidity/src/settlement_path.rs.');
    console.log('Override with SETTLER_FORCE_SEND=1.');
  }
  console.log('='.repeat(78) + '\n');

  // In report-only mode a keypair is not needed to answer the question, and
  // demanding one turns a diagnostic into something only CI can run.
  let settler: Keypair | null = null;
  try {
    settler = loadKeypair();
  } catch (e: any) {
    if (FORCE_SEND) throw e;
    console.log(`No settler keypair (${e.message?.slice(0, 80)}) — fine in report-only mode.`);
  }
  console.log('Settler:', settler ? settler.publicKey.toBase58() : '(none)');
  console.log('RPC    :', RPC);

  const [poolPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('liquidity_pool')], P01_LIQUIDITY_ID,
  );
  console.log('Pool   :', poolPDA.toBase58());

  const slot = await connection.getSlot('confirmed');
  const currentEpoch = BigInt(Math.floor(slot / Number(SLOTS_PER_EPOCH)));
  console.log(`Epoch  : ${currentEpoch} (slot ${slot})\n`);

  // getProgramAccounts with disc + exact size filter
  const accs = await connection.getProgramAccounts(P01_LIQUIDITY_ID, {
    filters: [
      { dataSize: PREFUND_RECORD_LEN },
      { memcmp: { offset: 0, bytes: bs58Encode(PREFUND_RECORD_DISC) } },
    ],
  });
  console.log(`Found ${accs.length} PrefundRecord(s).`);

  if (accs.length === 0) {
    console.log('Nothing to settle.');
    return;
  }

  let settled = 0;
  let stranded = 0;
  for (const { pubkey, account } of accs) {
    const rec = parsePrefundRecord(account.data);
    const denom = await loadDenomPool(connection, rec.denominatedPool);
    if (!denom) {
      console.log(`${pubkey.toBase58()}: denom pool missing, skipping`);
      continue;
    }
    const requiredEpoch = rec.minEpoch + denom.epochDelay + dynamicDelay(denom.matureNoteCount);
    if (currentEpoch < requiredEpoch) {
      console.log(`${pubkey.toBase58()}: not mature (need epoch ${requiredEpoch}, have ${currentEpoch})`);
      continue;
    }

    // The STARK proof buffer is closed by the user after their original prefund tx; if it no
    // longer exists on-chain the settle CPI will fail with InvalidProof every time.
    //
    // This is PERMANENT, not "try again later": the buffer is gone and cannot be
    // recreated, because recreating it needs the note secret AND the ephemeral
    // signer, and the record's rent is only returned by `close = settler` on a
    // successful settle. Say so, instead of "skipping" — that wording is why a
    // stranded record sat here unnoticed and the run still exited 0.
    const proofBufAcc = await connection.getAccountInfo(rec.proofBuffer);
    if (!proofBufAcc) {
      stranded++;
      console.log(
        `${pubkey.toBase58()}: STRANDED PERMANENTLY — proof buffer ${rec.proofBuffer.toBase58()} ` +
        `is closed, so settle can never succeed for it. amount=${Number(rec.amount) / LAMPORTS_PER_SOL} SOL, ` +
        `rent=${account.lamports / LAMPORTS_PER_SOL} SOL locked in the record.`
      );
      continue;
    }

    if (!FORCE_SEND) {
      console.log(
        `${pubkey.toBase58()}: mature and has a proof buffer, but settle is failed closed ` +
        `on chain. Not sending. amount=${Number(rec.amount) / LAMPORTS_PER_SOL} SOL.`
      );
      continue;
    }

    console.log(`\nSettling ${pubkey.toBase58()}:`);
    console.log(`  denom_pool: ${rec.denominatedPool.toBase58()}`);
    console.log(`  amount    : ${Number(rec.amount) / LAMPORTS_PER_SOL} SOL`);
    console.log(`  reward    : ${Number(rec.settlerReward) / LAMPORTS_PER_SOL} SOL`);

    const tx = new Transaction().add(
      cuLimitIx(1_400_000),
      buildSettleIx({
        settler: settler!.publicKey,
        poolPDA,
        prefundRecord: pubkey,
        denominatedPool: rec.denominatedPool,
        merkleTree: deriveTreePDA(rec.denominatedPool),
        nullifierRecord: deriveNullifierPDA(rec.denominatedPool, rec.nullifier),
        starkProofBuffer: rec.proofBuffer,
      }),
    );

    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [settler!]);
      console.log(`  settled: ${sig}`);
      settled++;
    } catch (e: any) {
      console.log(`  FAILED: ${e.message?.slice(0, 200)}`);
    }
  }

  console.log(`\nSettled ${settled}/${accs.length}.`);
  if (stranded > 0) {
    console.log(
      `${stranded} record(s) are stranded permanently — their prefunded lamports left the ` +
      `LP reserve and no instruction can bring them back.`
    );
  }
}

// Minimal base58 encode (just for the memcmp filter). web3.js doesn't expose bs58 directly.
function bs58Encode(buf: Buffer | Uint8Array): string {
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes = Buffer.from(buf);
  if (bytes.length === 0) return '';
  let digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHA[digits[i]];
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
