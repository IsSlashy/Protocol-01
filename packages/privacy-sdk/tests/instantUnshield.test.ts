import { describe, it, expect } from 'vitest';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  InstantUnshieldFlow,
  buildInstantUnshield,
  buildCloseStarkProofBufferIx,
  goldilocksU64ToNullifierBytes,
  keypairSigner,
  adapterSigner,
  P01_STARK_VERIFIER_PROGRAM_ID,
  P01_LIQUIDITY_PROGRAM_ID,
  CIRCUIT_POOL_COMMITMENT,
  STARK_MAX_CHUNK_SIZE,
  STARK_PROOF_DATA_OFFSET,
  STARK_MAX_INIT_SIZE,
  STARK_MAX_REALLOC_STEP,
  STARK_VERIFY_CU,
  PREFUND_CU,
  SLOTS_PER_EPOCH,
  LiquidityModule,
} from '../src';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function disc(name: string): Buffer {
  return Buffer.from(sha256(utf8ToBytes(`global:${name}`))).subarray(0, 8);
}

function makeInput(overrides: {
  proofSize?: number;
  ephemeralSigner?: Keypair;
} = {}) {
  const proofSize = overrides.proofSize ?? 2400; // small proof, 3 chunks
  const proofBytes = new Uint8Array(proofSize);
  for (let i = 0; i < proofSize; i++) proofBytes[i] = i & 0xff;
  const recipient = Keypair.generate().publicKey;
  const denominatedPool = Keypair.generate().publicKey;

  // publicInputs[0] = nullifier u64; publicInputs[1] = stark commitment u64
  const nullifierU64 = 0xdeadbeefcafebaben;
  const commitment = 0x0123456789abcdefn;
  const publicInputs = [nullifierU64, commitment, 42n, 7n];

  const nullifier = goldilocksU64ToNullifierBytes(nullifierU64);
  const merkleRoot = new Uint8Array(32).fill(0xab);

  return {
    proofBytes,
    publicInputs,
    proofSize,
    recipient,
    denominatedPool,
    nullifier,
    merkleRoot,
    amount: 1_000_000_000n,
    minEpoch: 12345n,
    ...(overrides.ephemeralSigner ? { ephemeralSigner: overrides.ephemeralSigner } : {}),
  };
}

// Use a valid devnet URL so Connection constructor doesn't choke; we don't hit it.
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');

// ─── Constants surface ───────────────────────────────────────────────────────

describe('InstantUnshield constants', () => {
  it('exposes the deployed devnet stark verifier program id', () => {
    expect(P01_STARK_VERIFIER_PROGRAM_ID.toBase58()).toBe(
      'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs',
    );
  });

  it('exposes the deployed devnet liquidity program id', () => {
    expect(P01_LIQUIDITY_PROGRAM_ID.toBase58()).toBe(
      '6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg',
    );
  });

  it('uses circuit 1 (pool_commitment) for instant unshield', () => {
    expect(CIRCUIT_POOL_COMMITMENT).toBe(1);
  });

  it('exposes Solana on-chain limits used by the chunk + resize loops', () => {
    expect(STARK_MAX_CHUNK_SIZE).toBe(1000);
    expect(STARK_MAX_INIT_SIZE).toBe(10_240);
    expect(STARK_MAX_REALLOC_STEP).toBe(10_240);
    expect(STARK_PROOF_DATA_OFFSET).toBe(83);
    expect(STARK_VERIFY_CU).toBe(1_400_000);
    expect(PREFUND_CU).toBe(200_000);
    expect(SLOTS_PER_EPOCH).toBe(7200n);
  });
});

// ─── Helper exports ──────────────────────────────────────────────────────────

describe('goldilocksU64ToNullifierBytes', () => {
  it('packs LE u64 into bytes 0..8 and zero-pads to 32', () => {
    const out = goldilocksU64ToNullifierBytes(0x0102030405060708n);
    expect(out.length).toBe(32);
    expect(Array.from(out.slice(0, 8))).toEqual([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
    expect(Array.from(out.slice(8))).toEqual(new Array(24).fill(0));
  });

  it('handles zero', () => {
    const out = goldilocksU64ToNullifierBytes(0n);
    expect(Array.from(out)).toEqual(new Array(32).fill(0));
  });
});

describe('keypairSigner / adapterSigner', () => {
  it('keypairSigner wraps a raw Keypair', () => {
    const kp = Keypair.generate();
    const s = keypairSigner(kp);
    expect(s.type).toBe('keypair');
    if (s.type === 'keypair') expect(s.keypair).toBe(kp);
  });

  it('adapterSigner wraps a (publicKey, signTransaction) pair', () => {
    const pk = Keypair.generate().publicKey;
    const sign = async (tx: any) => tx;
    const s = adapterSigner(pk, sign);
    expect(s.type).toBe('adapter');
    if (s.type === 'adapter') {
      expect(s.publicKey).toBe(pk);
      expect(s.signTransaction).toBe(sign);
    }
  });
});

// ─── buildInstructions (sync, no RPC) ────────────────────────────────────────

describe('InstantUnshieldFlow.buildInstructions', () => {
  it('produces every phase\'s instructions with correct counts', () => {
    const flow = new InstantUnshieldFlow(conn);
    // 25KB proof:
    //   target account = 25000 + 83 = 25083
    //   resizes = ceil((25083 - 10240) / 10240) = ceil(14843/10240) = 2
    //   chunks = ceil(25000 / 1000) = 25
    const input = makeInput({ proofSize: 25_000 });
    const ixs = flow.buildInstructions(input);

    expect(ixs.init.programId.equals(P01_STARK_VERIFIER_PROGRAM_ID)).toBe(true);
    expect(ixs.resizes.length).toBe(2);
    expect(ixs.chunks.length).toBe(25);
    expect(ixs.verifyPhase1.programId.equals(P01_STARK_VERIFIER_PROGRAM_ID)).toBe(true);
    expect(ixs.verifyPhase2.programId.equals(P01_STARK_VERIFIER_PROGRAM_ID)).toBe(true);
    expect(ixs.prefund.programId.equals(P01_LIQUIDITY_PROGRAM_ID)).toBe(true);
    expect(ixs.proofBuffer).toBeInstanceOf(PublicKey);
    expect(ixs.prefundRecord).toBeInstanceOf(PublicKey);
    expect(ixs.minEpoch).toBe(12345n);
  });

  it('emits zero resizes when proof fits in 10KB', () => {
    const flow = new InstantUnshieldFlow(conn);
    const ixs = flow.buildInstructions(makeInput({ proofSize: 5_000 }));
    expect(ixs.resizes.length).toBe(0);
    expect(ixs.chunks.length).toBe(5);
  });

  it('uses the supplied ephemeral signer instead of generating one', () => {
    const flow = new InstantUnshieldFlow(conn);
    const eph = Keypair.generate();
    const ixs = flow.buildInstructions(makeInput({ ephemeralSigner: eph }));
    expect(ixs.ephemeralSigner.publicKey.equals(eph.publicKey)).toBe(true);

    // proofBuffer PDA must derive from ephemeral pubkey + circuit_id 1
    const [expectedBuf] = PublicKey.findProgramAddressSync(
      [Buffer.from('stark_proof'), eph.publicKey.toBuffer(), Buffer.from([CIRCUIT_POOL_COMMITMENT])],
      P01_STARK_VERIFIER_PROGRAM_ID,
    );
    expect(ixs.proofBuffer.equals(expectedBuf)).toBe(true);
  });

  it('throws if proofSize disagrees with proofBytes.length', () => {
    const flow = new InstantUnshieldFlow(conn);
    const input = { ...makeInput(), proofSize: 999 };
    expect(() => flow.buildInstructions(input)).toThrow(/proofSize.*proofBytes/);
  });

  it('throws on wrong-length nullifier or merkle root', () => {
    const flow = new InstantUnshieldFlow(conn);
    expect(() =>
      flow.buildInstructions({ ...makeInput(), nullifier: new Uint8Array(16) }),
    ).toThrow(/nullifier must be 32 bytes/);
    expect(() =>
      flow.buildInstructions({ ...makeInput(), merkleRoot: new Uint8Array(8) }),
    ).toThrow(/merkleRoot must be 32 bytes/);
  });

  it('throws when publicInputs has fewer than 2 entries', () => {
    const flow = new InstantUnshieldFlow(conn);
    expect(() =>
      flow.buildInstructions({ ...makeInput(), publicInputs: [42n] }),
    ).toThrow(/≥2 public inputs/);
  });
});

// ─── Init ix encoding ────────────────────────────────────────────────────────

describe('init_proof_buffer instruction encoding', () => {
  it('matches the on-chain Anchor layout: 8 disc + u32 size + u8 circuit_id', () => {
    const flow = new InstantUnshieldFlow(conn);
    const ixs = flow.buildInstructions(makeInput({ proofSize: 7_777 }));

    expect(ixs.init.data.length).toBe(8 + 4 + 1);
    expect(ixs.init.data.subarray(0, 8).equals(disc('init_proof_buffer'))).toBe(true);
    expect(ixs.init.data.readUInt32LE(8)).toBe(7_777);
    expect(ixs.init.data.readUInt8(12)).toBe(CIRCUIT_POOL_COMMITMENT);

    // Keys: [proofBuffer (w), authority (s+w), system (ro)]
    expect(ixs.init.keys.length).toBe(3);
    expect(ixs.init.keys[0]!.pubkey.equals(ixs.proofBuffer)).toBe(true);
    expect(ixs.init.keys[0]!.isWritable).toBe(true);
    expect(ixs.init.keys[0]!.isSigner).toBe(false);
    expect(ixs.init.keys[1]!.pubkey.equals(ixs.ephemeralSigner.publicKey)).toBe(true);
    expect(ixs.init.keys[1]!.isSigner).toBe(true);
    expect(ixs.init.keys[1]!.isWritable).toBe(true);
    expect(ixs.init.keys[2]!.pubkey.equals(SystemProgram.programId)).toBe(true);
  });
});

// ─── Resize ix ───────────────────────────────────────────────────────────────

describe('resize_proof_buffer instruction encoding', () => {
  it('uses the bare discriminator (no args) and the same 3-key layout as init', () => {
    const flow = new InstantUnshieldFlow(conn);
    const ixs = flow.buildInstructions(makeInput({ proofSize: 25_000 }));
    const r = ixs.resizes[0]!;
    expect(r.data.length).toBe(8);
    expect(r.data.equals(disc('resize_proof_buffer'))).toBe(true);
    expect(r.keys.length).toBe(3);
  });
});

// ─── Chunk ix ────────────────────────────────────────────────────────────────

describe('write_proof_chunk instruction encoding', () => {
  it('encodes [disc][u32 offset][u32 len][bytes] and slices proofBytes correctly', () => {
    const flow = new InstantUnshieldFlow(conn);
    const input = makeInput({ proofSize: 2_400 }); // 3 chunks: 1000 + 1000 + 400
    const ixs = flow.buildInstructions(input);
    expect(ixs.chunks.length).toBe(3);

    const expectedDisc = disc('write_proof_chunk');
    const expectedOffsets = [0, 1000, 2000];
    const expectedLens = [1000, 1000, 400];

    for (let i = 0; i < 3; i++) {
      const c = ixs.chunks[i]!;
      expect(c.data.subarray(0, 8).equals(expectedDisc)).toBe(true);
      expect(c.data.readUInt32LE(8)).toBe(expectedOffsets[i]);
      expect(c.data.readUInt32LE(12)).toBe(expectedLens[i]);
      expect(c.data.length).toBe(8 + 4 + 4 + expectedLens[i]!);
      // First payload byte should be input.proofBytes[offset]
      expect(c.data[16]).toBe(input.proofBytes[expectedOffsets[i]!]);
    }
  });
});

// ─── verify_stark_proof_v2 ix ────────────────────────────────────────────────

describe('verify_stark_proof_v2 + verify_deep_ali_phase2 encoding', () => {
  it('encodes [disc][borsh Vec<u64> publicInputs] for both phases', () => {
    const flow = new InstantUnshieldFlow(conn);
    const input = makeInput();
    const ixs = flow.buildInstructions(input);

    const expectedLen = 8 + 4 + input.publicInputs.length * 8;
    expect(ixs.verifyPhase1.data.length).toBe(expectedLen);
    expect(ixs.verifyPhase2.data.length).toBe(expectedLen);

    expect(ixs.verifyPhase1.data.subarray(0, 8).equals(disc('verify_stark_proof_v2'))).toBe(true);
    expect(ixs.verifyPhase2.data.subarray(0, 8).equals(disc('verify_deep_ali_phase2'))).toBe(true);

    // Vec<u64> length prefix
    expect(ixs.verifyPhase1.data.readUInt32LE(8)).toBe(input.publicInputs.length);

    // Round-trip: read each u64
    for (let i = 0; i < input.publicInputs.length; i++) {
      const v = ixs.verifyPhase1.data.readBigUInt64LE(12 + i * 8);
      expect(v).toBe(input.publicInputs[i]);
    }
  });
});

// ─── prefund ix ──────────────────────────────────────────────────────────────

describe('prefund instruction', () => {
  it('uses the liquidity program, has the prefund discriminator, and embeds nullifier+root+epoch+commitment+amount', () => {
    const flow = new InstantUnshieldFlow(conn);
    const input = makeInput();
    const ixs = flow.buildInstructions(input);

    expect(ixs.prefund.programId.equals(P01_LIQUIDITY_PROGRAM_ID)).toBe(true);

    // 8 disc + 32 nullifier + 32 root + 8 min_epoch + 8 commitment + 8 amount
    expect(ixs.prefund.data.length).toBe(8 + 32 + 32 + 8 + 8 + 8);
    expect(ixs.prefund.data.subarray(0, 8).equals(disc('prefund'))).toBe(true);

    expect(ixs.prefund.data.subarray(8, 40).equals(Buffer.from(input.nullifier))).toBe(true);
    expect(ixs.prefund.data.subarray(40, 72).equals(Buffer.from(input.merkleRoot))).toBe(true);
    expect(ixs.prefund.data.readBigUInt64LE(72)).toBe(input.minEpoch);
    // starkCommitment is publicInputs[1]
    expect(ixs.prefund.data.readBigUInt64LE(80)).toBe(input.publicInputs[1]);
    expect(ixs.prefund.data.readBigUInt64LE(88)).toBe(input.amount);

    // 7-key layout: [ephemeral (s+w), recipient (w), pool (w), proofBuffer (ro), denomPool (ro), prefundRecord (w), system]
    expect(ixs.prefund.keys.length).toBe(7);
    expect(ixs.prefund.keys[0]!.pubkey.equals(ixs.ephemeralSigner.publicKey)).toBe(true);
    expect(ixs.prefund.keys[0]!.isSigner).toBe(true);
    expect(ixs.prefund.keys[0]!.isWritable).toBe(true);
    expect(ixs.prefund.keys[1]!.pubkey.equals(input.recipient)).toBe(true);
    expect(ixs.prefund.keys[3]!.pubkey.equals(ixs.proofBuffer)).toBe(true);
    expect(ixs.prefund.keys[4]!.pubkey.equals(input.denominatedPool)).toBe(true);
    expect(ixs.prefund.keys[5]!.pubkey.equals(ixs.prefundRecord)).toBe(true);
  });

  it('echoes correct fee math via LiquidityModule.computePrefundFees', () => {
    const flow = new InstantUnshieldFlow(conn);
    const ixs = flow.buildInstructions(makeInput());
    // default 30bps prefund + 30bps reward on 1 SOL (1e9 lamports)
    expect(ixs.fees.prefundFee).toBe(3_000_000n);
    expect(ixs.fees.settlerReward).toBe(3_000_000n);
    expect(ixs.fees.recipientAmount).toBe(994_000_000n);
    // Sanity: parity with the live helper
    const direct = LiquidityModule.computePrefundFees(1_000_000_000n, 30, 30);
    expect(ixs.fees).toEqual(direct);
  });
});

// ─── close_proof_buffer (for post-settle rent reclaim) ───────────────────────

describe('buildCloseStarkProofBufferIx', () => {
  it('emits the 8-byte close discriminator with [buffer (w), authority (s+w)] keys', () => {
    const buf = Keypair.generate().publicKey;
    const auth = Keypair.generate().publicKey;
    const ix = buildCloseStarkProofBufferIx(buf, auth);

    expect(ix.programId.equals(P01_STARK_VERIFIER_PROGRAM_ID)).toBe(true);
    expect(ix.data.length).toBe(8);
    expect(ix.data.equals(disc('close_proof_buffer'))).toBe(true);
    expect(ix.keys.length).toBe(2);
    expect(ix.keys[0]!.pubkey.equals(buf)).toBe(true);
    expect(ix.keys[0]!.isWritable).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(auth)).toBe(true);
    expect(ix.keys[1]!.isSigner).toBe(true);
    expect(ix.keys[1]!.isWritable).toBe(true);
  });
});

// ─── buildAll plan shape ─────────────────────────────────────────────────────

describe('buildAll / buildInstantUnshield (plan shape)', () => {
  it('wraps each phase in a Transaction with the ephemeral as feePayer and adds CU budget ixs where needed', async () => {
    const eph = Keypair.generate();
    const input = { ...makeInput({ proofSize: 12_000, ephemeralSigner: eph }) };
    // 12000 + 83 = 12083; needs 1 resize (12083-10240=1843, ceil/10240=1)
    // chunks = 12

    // Use buildAll with explicit minEpoch so we don't hit RPC.
    const plan = await new InstantUnshieldFlow(conn).buildAll(input);

    expect(plan.ephemeralSigner.publicKey.equals(eph.publicKey)).toBe(true);
    expect(plan.minEpoch).toBe(input.minEpoch);

    expect(plan.initTx.feePayer?.equals(eph.publicKey)).toBe(true);
    expect(plan.initTx.instructions.length).toBe(1);

    expect(plan.resizeTxs.length).toBe(1);
    // Each resize tx has [SetComputeUnitPrice, resize_proof_buffer]
    expect(plan.resizeTxs[0]!.instructions.length).toBe(2);
    expect(plan.resizeTxs[0]!.instructions[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);

    expect(plan.chunkTxs.length).toBe(12);
    plan.chunkTxs.forEach((tx) => {
      expect(tx.feePayer?.equals(eph.publicKey)).toBe(true);
      expect(tx.instructions.length).toBe(1);
    });

    expect(plan.verifyTxs.length).toBe(2);
    plan.verifyTxs.forEach((tx) => {
      expect(tx.instructions.length).toBe(2);
      expect(tx.instructions[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    });

    // Prefund: [SetComputeUnitLimit, prefund]
    expect(plan.prefundTx.instructions.length).toBe(2);
    expect(plan.prefundTx.instructions[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(plan.prefundTx.instructions[1]!.programId.equals(P01_LIQUIDITY_PROGRAM_ID)).toBe(true);
  });

  it('function-form alias buildInstantUnshield is identical to class form', async () => {
    const input = makeInput();
    const a = await buildInstantUnshield(conn, input);
    const b = await new InstantUnshieldFlow(conn).buildAll({
      ...input,
      ephemeralSigner: a.ephemeralSigner, // share signer for byte-equality
    });
    expect(a.proofBuffer.equals(b.proofBuffer)).toBe(true);
    expect(a.prefundRecord.equals(b.prefundRecord)).toBe(true);
    expect(a.minEpoch).toBe(b.minEpoch);
    expect(a.chunkTxs.length).toBe(b.chunkTxs.length);
  });

  it('unique CU price per resize tx so serialized bytes differ', async () => {
    // 35KB proof => 3 resizes (35083 - 10240 = 24843, /10240 = 3)
    const input = makeInput({ proofSize: 35_000 });
    const plan = await new InstantUnshieldFlow(conn).buildAll(input);
    expect(plan.resizeTxs.length).toBe(3);
    const microLamportsExtracted = plan.resizeTxs.map((tx) => {
      const cuIx = tx.instructions[0]!;
      // SetComputeUnitPrice layout: 1-byte disc (3) + u64 LE microLamports
      expect(cuIx.data.readUInt8(0)).toBe(3);
      return cuIx.data.readBigUInt64LE(1);
    });
    expect(microLamportsExtracted).toEqual([1n, 2n, 3n]);
  });
});

