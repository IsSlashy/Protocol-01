/**
 * A REAL v4 withdrawal, on devnet, on one circuit-7 proof.
 *
 * ⛔ INERT UNLESS `P01_LIVE_DEVNET=1`. It spends real devnet SOL, takes minutes,
 * and needs an RPC, so it must never run in a normal suite. Skipped is the
 * correct default: a green suite that quietly included this would be measuring
 * the network, not the code.
 *
 * WHY IT EXISTS
 * ─────────────
 * Everything else in this repository that touches circuit 7 compares the tree
 * against itself. `unshieldV4.test.ts` builds an instruction and inspects its
 * bytes with no RPC, no worker and no WASM. `c7-live-proof.ts` proves the
 * VERIFIER accepts a C7 proof, but says nothing about the pool: `zk_shielded`
 * reads the verified buffer cross-program and applies its own checks — the
 * subtree walk, the root ring, the nullifier, the payout.
 *
 * 🚨 SO UNTIL THIS FILE, NO v4 WITHDRAWAL HAD EVER LANDED. "The path is open"
 * and "the flow lands" are different claims and this repository has already paid
 * for confusing them.
 *
 * WHAT IT MEASURES
 * ────────────────
 * Shield a fresh note, then spend it through `prepareUnshieldV4` +
 * `unshieldDenominatedStarkV4`, then read the withdrawal transaction back OFF
 * THE CHAIN and require that no field of the deposit appears in it — not the
 * commitment, not the blinding, not the epoch. That last assertion is the whole
 * point of the circuit; the rest is what makes it reachable.
 *
 * WHAT IT DOES NOT COVER, STATED SO NOBODY READS MORE INTO A GREEN RUN
 * ────────────────────────────────────────────────────────────────────
 * The deposit is funded straight from the wallet, not through the deployment
 * relay, so THIS DEPOSIT IS LINKABLE BY CONSTRUCTION — the wallet paid the
 * ephemeral and an RPC walk finds it. That is the documented fallback and is
 * not a privacy claim. What C7 removes is the commitment linkage between the
 * withdrawal and the deposit leaf; the funding edge, the sender's identity and
 * the anonymity-set size are separate work and are not delivered here.
 *
 * Run:
 *   P01_LIVE_DEVNET=1 P01_LIVE_KEYPAIR=~/.config/solana/id.json \
 *     npx vitest run --config vitest.pool.config.mts lib/privacy/pool/liveDevnetUnshieldV4.test.ts
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { buildDerivationMessage } from '../message';
import {
  configurePoolHandlers,
  handlePoolRequest,
  locateOwnedNote,
} from '../worker/poolHandlers';
import { prepareUnshieldV4, unshieldDenominatedStarkV4 } from './denominatedPool';
import type { WalletSigner } from './stark';

/**
 * `Worker` does not exist in Node, and `starkProver` needs one.
 *
 * ⛔ NOT A STUBBED PROVER. A fake proof would make this harness worthless: the
 * transaction would be refused on chain and the failure would read as a v4 bug.
 * This runs the REAL `starkProver.worker` module in-process over the same WASM
 * bytes, by giving it the two browser globals it uses. Only the thread boundary
 * is removed.
 */
class InProcessStarkWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private inbox: unknown[] = [];
  private shim: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };

  constructor() {
    const outer = this;
    this.shim = {
      onmessage: null,
      postMessage(m: unknown) { outer.onmessage?.({ data: m }); },
    };
    (globalThis as unknown as { self: unknown }).self = this.shim;
    void import('./starkProver.worker').then(() => {
      for (const m of this.inbox) this.shim.onmessage?.({ data: m });
      this.inbox = [];
    });
  }

  postMessage(m: unknown) {
    if (this.shim.onmessage) this.shim.onmessage({ data: m });
    else this.inbox.push(m);
  }

  terminate() {}
}

if (typeof (globalThis as unknown as { Worker?: unknown }).Worker === 'undefined') {
  (globalThis as unknown as { Worker: unknown }).Worker = InProcessStarkWorker;
}

const LIVE = process.env.P01_LIVE_DEVNET === '1';
const RPC = process.env.P01_LIVE_RPC ?? 'https://api.devnet.solana.com';
/** The demo denomination and the only pool open to new deposits. */
const DENOMINATION = 1;

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
}

function loadKeypair(): Keypair {
  const path = expandHome(process.env.P01_LIVE_KEYPAIR ?? `${homedir()}/.config/solana/id.json`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

/** A `WalletSigner` over a raw Keypair — the harness has no browser wallet. */
function signerFor(kp: Keypair): WalletSigner {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => { tx.partialSign(kp); return tx; },
    signAllTransactions: async (txs: Transaction[]) => {
      for (const tx of txs) tx.partialSign(kp);
      return txs;
    },
  } as WalletSigner;
}

const log = (...a: unknown[]) => { /* eslint-disable-next-line no-console */ console.log(...a); };

describe.skipIf(!LIVE)('a v4 withdrawal that actually lands on devnet', () => {
  it('shields a note, spends it on one circuit-7 proof, and publishes no deposit field', async () => {
    const wallet = loadKeypair();
    const connection = new Connection(RPC, 'confirmed');
    configurePoolHandlers(RPC);

    // An assertion, not a courtesy: running out of SOL three minutes into a
    // proof reads as a broken withdrawal.
    const balance = await connection.getBalance(wallet.publicKey);
    log(`wallet ${wallet.publicKey.toBase58()} — ${balance / 1e9} SOL`);
    expect(balance).toBeGreaterThan(1.8e9);

    // ---------------------------------------------------------------- shield
    const message = buildDerivationMessage({
      walletPubkey: wallet.publicKey.toBase58(),
      origin: 'http://localhost:3000',
      chainTag: 'solana:devnet',
    });
    const signature = nacl.sign.detached(new TextEncoder().encode(message), wallet.secretKey);
    const meta = 'live-devnet-unshield-v4';
    await handlePoolRequest({ kind: 'poolDeriveIdentity', meta, signature: Array.from(signature) });

    const prep = await handlePoolRequest(
      { kind: 'poolShieldPrepare', meta, token: 'SOL', denomination: DENOMINATION },
      (s: string) => log('  shield-prepare:', s),
    );
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(prep.ephemeralPubkey),
        lamports: prep.requiredLamports,
      })),
      [wallet],
      { commitment: 'confirmed' },
    );
    const shielded = await handlePoolRequest(
      {
        kind: 'poolShieldExecute',
        jobId: prep.jobId,
        ownerPubkey: wallet.publicKey.toBase58(),
        sweepTo: wallet.publicKey.toBase58(),
      },
      (s: string) => log('  shield-execute:', s),
    );
    log('  SHIELD LANDED:', shielded.txSig, 'leaf', shielded.leafIndex);
    expect(shielded.leafIndex).toBeGreaterThanOrEqual(0);

    // ------------------------------------------------------- resolve the note
    // The receipt has to come from the same derivation the app uses. An
    // invented one would prove nothing: its commitment is not a leaf on chain.
    const located = await locateOwnedNote({
      meta, token: 'SOL', denomination: DENOMINATION,
      leafIndex: shielded.leafIndex,
      encryptedNotes: [shielded.encryptedNote],
    });
    const receipt = located.note.receipt;
    expect(receipt.commitment.toString()).toBe(String(shielded.commitment));

    // ------------------------------------------------------------ spend (v4)
    // An address unrelated to the wallet ON CHAIN, so the withdrawal does not
    // pay the account that funded the deposit — that edge would re-create the
    // very linkage C7 removes.
    //
    // Derived rather than `Keypair.generate()` so the harness can always
    // re-derive it and sweep the devnet SOL back instead of burning a coin per
    // run. The derivation is off-chain and appears nowhere in any transaction,
    // so it does not weaken what is being measured.
    const payeeSeed = sha256(concatBytes(
      wallet.secretKey.slice(0, 32), utf8ToBytes('p01:v4-harness-payee:v1'),
    ));
    const payeeKp = Keypair.fromSeed(payeeSeed);
    const payee = payeeKp.publicKey;
    log(`  payee ${payee.toBase58()} (re-derivable — sweep it back when done)`);

    const prepared = await prepareUnshieldV4(
      receipt, payee, located.pool, connection,
      (s: string) => log('  v4-prepare:', s),
    );
    expect(prepared.c7ProofResult.proofSize).toBe(77_965);
    expect(prepared.c7ProofResult.publicInputs).toHaveLength(6);
    // 12 in the circuit, 3 on chain. If the pool tree depth ever changes this
    // is where it shows, not in a rejected transaction.
    expect(prepared.siblings).toHaveLength(3);
    expect(prepared.directions).toHaveLength(3);

    const before = await connection.getBalance(payee);
    const sig = await unshieldDenominatedStarkV4(
      located.pool, payee, prepared, signerFor(wallet), connection,
      (s: string) => log('  v4-execute:', s),
    );
    log('  V4 WITHDRAWAL LANDED:', sig);

    // -------------------------------------------------- read it off the chain
    // ⛔ NOT FROM THE CLIENT. The 2026-08-18 leak was found on a program dump,
    // and 46d37ad9 fixed a client that reported success on a half-verified
    // proof. Ask the chain what happened.
    const tx = await connection.getTransaction(sig, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    });
    expect(tx, 'the chain has no record of the withdrawal').not.toBeNull();
    expect(tx!.meta?.err, JSON.stringify(tx!.meta?.logMessages ?? [])).toBeNull();

    const after = await connection.getBalance(payee);
    log(`  payee received ${(after - before) / 1e9} SOL`);
    expect(after).toBeGreaterThan(before);

    // ------------------------------------------------------- THE MEASUREMENT
    // Every byte the withdrawal put on the wire, swept for anything that names
    // the deposit. This is the claim the circuit exists to support; everything
    // above is what makes it reachable.
    const ix = tx!.transaction.message.compiledInstructions
      ?? (tx!.transaction.message as unknown as { instructions: { data: Uint8Array }[] }).instructions;
    const payloads = (ix as { data: Uint8Array }[]).map((i) => Buffer.from(i.data));

    // Two values, not three. `noteBlinding` IS the field that used to be
    // `deposit_epoch` — the commitment's third input, renamed when blinding
    // landed and still serialised under the old key. There is no separate epoch
    // to sweep for, and asserting on one would have been asserting on nothing.
    const forbidden: Array<[string, bigint]> = [
      ['the note commitment', receipt.commitment],
      ['the note blinding (the old deposit_epoch slot)', receipt.noteBlinding],
      // The nullifier IS published, on purpose — it is what makes double
      // spending impossible — so it is deliberately absent from this list.
    ];
    for (const [label, value] of forbidden) {
      // A legacy note can carry 0 here, and 0 appears all over any instruction.
      // Skip rather than assert something false.
      if (value === 0n) continue;
      for (const data of payloads) {
        for (let off = 0; off + 8 <= data.length; off++) {
          expect(
            data.readBigUInt64LE(off),
            `${label} is on the wire at byte ${off} of a withdrawal instruction`,
          ).not.toBe(value);
          expect(data.readBigUInt64BE(off)).not.toBe(value);
        }
      }
    }
    log('  NO DEPOSIT FIELD APPEARS IN THE WITHDRAWAL.');
  }, 20 * 60 * 1000);
});
