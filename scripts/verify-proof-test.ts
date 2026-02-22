/**
 * Quick test script to verify if Groth16 proofs from the Rust prover are valid.
 *
 * Usage: npx tsx scripts/verify-proof-test.ts
 *
 * This calls the Railway-deployed Rust prover, gets a proof, then verifies
 * it locally using snarkjs. This determines if the InvalidProof error is:
 * - A proof generation bug (snarkjs verify fails)
 * - An on-chain encoding bug (snarkjs verify passes but on-chain fails)
 */

import * as snarkjs from 'snarkjs';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVER_URL = 'https://p01-relayer-production.up.railway.app';
const VK_PATH = path.join(__dirname, '..', 'circuits', 'build', 'verification_key.json');

// Generate dummy inputs that satisfy the circuit
// The circuit checks: in_amount_1 + in_amount_2 + public_amount = out_amount_1 + out_amount_2
// For a simple test: shield 1000 lamports (public_amount = 1000, out_amount_1 = 1000)

const FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

// Poseidon hash placeholder - we need the actual commitment
// For this test, we'll use a known good commitment approach
async function main() {
  console.log('=== Groth16 Proof Verification Test ===\n');

  // 1. Load VK
  const vk = JSON.parse(fs.readFileSync(VK_PATH, 'utf8'));
  console.log('VK loaded:', vk.protocol, vk.curve, 'nPublic:', vk.nPublic, 'IC:', vk.IC.length);

  // 2. Generate a proof via the Rust prover with simple inputs
  // We need valid circuit inputs. Let's construct a minimal valid set:
  // - 2 input notes (one real with some amount, one dummy)
  // - 2 output notes (one with the unshielded amount, one dummy)
  // - Merkle proof (dummy - all zeros means root = H(H(H(...H(note)...))))

  // For a simpler test, let's just try the /verify endpoint directly
  // with a proof generated from /prove

  // Let's first check if /health works
  console.log('\nChecking prover health...');
  try {
    const healthResp = await fetch(`${PROVER_URL}/health`);
    const health = await healthResp.json() as any;
    console.log('Prover health:', JSON.stringify(health, null, 2));
  } catch (e: any) {
    console.error('Health check failed:', e.message);
  }

  // Try /verify endpoint on the Rust prover (proxied through relayer)
  console.log('\nChecking if /verify endpoint exists...');
  try {
    const verifyResp = await fetch(`${PROVER_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof: { pi_a: [], pi_b: [], pi_c: [] }, publicSignals: [] }),
    });
    const verifyText = await verifyResp.text();
    console.log('/verify response:', verifyResp.status, verifyText.slice(0, 200));
  } catch (e: any) {
    console.error('/verify failed:', e.message);
  }

  // Since we can't easily generate valid circuit inputs without Poseidon,
  // let's use snarkjs directly to generate AND verify a proof
  console.log('\n--- Testing with snarkjs fullProve + verify ---');

  const wasmPath = path.join(__dirname, '..', 'circuits', 'build', 'transfer_js', 'transfer.wasm');
  const zkeyPath = path.join(__dirname, '..', 'circuits', 'build', 'transfer_final.zkey');

  if (!fs.existsSync(wasmPath)) {
    console.error('Circuit WASM not found at:', wasmPath);
    console.log('Run: cd circuits && ./build.sh');
    return;
  }
  if (!fs.existsSync(zkeyPath)) {
    console.error('Circuit ZKEY not found at:', zkeyPath);
    return;
  }

  // Generate a valid proof using snarkjs
  // We need to construct valid inputs with Poseidon commitments
  // This requires the circomlibjs Poseidon
  try {
    const circomlibjs = await import('circomlibjs');
    const poseidon = await circomlibjs.buildPoseidon();

    const poseidonHash = (...inputs: bigint[]): bigint => {
      const hash = poseidon(inputs.map(i => BigInt(i)));
      return BigInt(poseidon.F.toString(hash));
    };

    // Create test data
    const spendingKey = BigInt(12345);
    const spendingKeyHash = poseidonHash(spendingKey);
    const ownerPubkey = spendingKeyHash;
    const tokenMint = BigInt(0); // SOL

    // Input note 1: amount=1000
    const inAmount1 = BigInt(1000);
    const inRandomness1 = BigInt(42);
    const inCommitment1 = poseidonHash(inAmount1, ownerPubkey, inRandomness1, tokenMint);
    const nullifier1 = poseidonHash(inCommitment1, spendingKeyHash);

    // Input note 2: dummy (amount=0)
    const inAmount2 = BigInt(0);
    const inRandomness2 = BigInt(99);
    const inCommitment2 = poseidonHash(inAmount2, BigInt(0), inRandomness2, tokenMint);
    const nullifier2 = poseidonHash(inCommitment2, spendingKeyHash);

    // Build a simple Merkle tree with just the two commitments
    const DEPTH = 20;
    const ZERO_VALUE = BigInt('0x2fe54c60d3acab34f3353a3b6ebb1ea15db4340f76e741e2249685ed4899af6c');

    // Zero values for each level
    const zeroValues = [ZERO_VALUE];
    for (let i = 1; i <= DEPTH; i++) {
      zeroValues.push(poseidonHash(zeroValues[i-1], zeroValues[i-1]));
    }

    // Insert commitment1 at index 0
    let currentHash = inCommitment1;
    const pathElements1: bigint[] = [];
    const pathIndices1: number[] = [];
    let idx = 0;
    for (let level = 0; level < DEPTH; level++) {
      pathElements1.push(zeroValues[level]);
      pathIndices1.push(0);
      currentHash = poseidonHash(currentHash, zeroValues[level]);
      idx = Math.floor(idx / 2);
    }
    const merkleRoot = currentHash;

    // Dummy path for input 2 (not in tree, amount=0 so circuit doesn't check)
    const pathElements2 = Array(DEPTH).fill(BigInt(0));
    const pathIndices2 = Array(DEPTH).fill(0);

    // Output note 1: change (amount=0 for full unshield)
    const outAmount1 = BigInt(0);
    const outRecipient1 = BigInt(0);
    const outRandomness1 = BigInt(0);
    const outCommitment1 = poseidonHash(outAmount1, outRecipient1, outRandomness1, tokenMint);

    // Output note 2: dummy
    const outAmount2 = BigInt(0);
    const outRecipient2 = BigInt(0);
    const outRandomness2 = BigInt(0);
    const outCommitment2 = poseidonHash(outAmount2, outRecipient2, outRandomness2, tokenMint);

    // public_amount = -(amount being unshielded) = -1000 in field
    const publicAmount = FIELD_MODULUS - BigInt(1000);

    // Value conservation: in_amount_1 + in_amount_2 + public_amount = out_amount_1 + out_amount_2
    // 1000 + 0 + (p-1000) = 0 + 0 (mod p) ← this is 0 ≡ 0 ✓

    const circuitInputs = {
      merkle_root: merkleRoot.toString(),
      nullifier_1: nullifier1.toString(),
      nullifier_2: nullifier2.toString(),
      output_commitment_1: outCommitment1.toString(),
      output_commitment_2: outCommitment2.toString(),
      public_amount: publicAmount.toString(),
      token_mint: tokenMint.toString(),

      in_amount_1: inAmount1.toString(),
      in_owner_pubkey_1: ownerPubkey.toString(),
      in_randomness_1: inRandomness1.toString(),
      in_path_elements_1: pathElements1.map(e => e.toString()),
      in_path_indices_1: pathIndices1.map(i => i.toString()),

      in_amount_2: inAmount2.toString(),
      in_owner_pubkey_2: BigInt(0).toString(),
      in_randomness_2: inRandomness2.toString(),
      in_path_elements_2: pathElements2.map(e => e.toString()),
      in_path_indices_2: pathIndices2.map(i => i.toString()),

      out_amount_1: outAmount1.toString(),
      out_recipient_1: outRecipient1.toString(),
      out_randomness_1: outRandomness1.toString(),
      out_amount_2: outAmount2.toString(),
      out_recipient_2: outRecipient2.toString(),
      out_randomness_2: outRandomness2.toString(),

      spending_key: spendingKey.toString(),
    };

    console.log('Generating proof with snarkjs...');
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInputs,
      wasmPath,
      zkeyPath
    );

    console.log('Proof generated! Public signals:', publicSignals.length);
    console.log('Public signals:', publicSignals);

    // Verify with snarkjs
    console.log('\nVerifying with snarkjs...');
    const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
    console.log('snarkjs verify:', valid ? 'PASS ✓' : 'FAIL ✗');

    if (valid) {
      console.log('\n--- Now testing Rust prover with same inputs ---');

      // Convert inputs for the Rust prover (JSON string format)
      const rustInputs: Record<string, string> = {};
      for (const [key, value] of Object.entries(circuitInputs)) {
        if (Array.isArray(value)) {
          rustInputs[key] = JSON.stringify(value);
        } else {
          rustInputs[key] = value as string;
        }
      }

      try {
        const rustResp = await fetch(`${PROVER_URL}/prove`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputs: rustInputs }),
        });

        const rustResult = await rustResp.json() as any;
        console.log('Rust prover result:', rustResult.prover, 'time:', rustResult.proofTimeMs, 'ms');
        console.log('Rust self-verified:', rustResult.selfVerified);

        if (rustResult.proof && rustResult.publicSignals) {
          // Verify Rust prover's proof with snarkjs
          console.log('\nVerifying Rust prover proof with snarkjs...');
          const rustValid = await snarkjs.groth16.verify(vk, rustResult.publicSignals, rustResult.proof);
          console.log('Rust proof snarkjs verify:', rustValid ? 'PASS ✓' : 'FAIL ✗');

          // Print full proof comparison
          console.log('\n--- Proof structure comparison ---');
          console.log('snarkjs pi_a:', proof.pi_a);
          console.log('rust    pi_a:', rustResult.proof.pi_a);
          console.log('snarkjs pi_b:', JSON.stringify(proof.pi_b));
          console.log('rust    pi_b:', JSON.stringify(rustResult.proof.pi_b));
          console.log('snarkjs pi_c:', proof.pi_c);
          console.log('rust    pi_c:', rustResult.proof.pi_c);

          // Check BN254 field bounds
          const Fq = BigInt('21888242871839275222246405745257275088696311157297823662689037894645226208583');
          const checkField = (name: string, vals: string[]) => {
            for (let i = 0; i < vals.length; i++) {
              const v = BigInt(vals[i]);
              if (v >= Fq) console.log(`  !! ${name}[${i}] >= Fq!`);
              if (v < 0n) console.log(`  !! ${name}[${i}] < 0!`);
            }
          };
          console.log('\nField bounds check (Rust proof):');
          checkField('pi_a', rustResult.proof.pi_a.slice(0, 2));
          checkField('pi_b[0]', rustResult.proof.pi_b[0]);
          checkField('pi_b[1]', rustResult.proof.pi_b[1]);
          checkField('pi_c', rustResult.proof.pi_c.slice(0, 2));
          console.log('  (no issues = all in range)');

          // Check G1 curve equation: y^2 = x^3 + 3 (mod Fq) for pi_a
          const modpow = (base: bigint, exp: bigint, mod: bigint): bigint => {
            let result = 1n;
            base = ((base % mod) + mod) % mod;
            while (exp > 0n) {
              if (exp % 2n === 1n) result = (result * base) % mod;
              exp = exp / 2n;
              base = (base * base) % mod;
            }
            return result;
          };

          const checkG1OnCurve = (name: string, coords: string[]) => {
            const x = BigInt(coords[0]);
            const y = BigInt(coords[1]);
            const lhs = (y * y) % Fq;
            const rhs = (modpow(x, 3n, Fq) + 3n) % Fq;
            const onCurve = lhs === rhs;
            console.log(`  ${name}: y²=x³+3 → ${onCurve ? 'ON CURVE ✓' : 'NOT ON CURVE ✗'}`);
            return onCurve;
          };

          console.log('\nCurve point checks:');
          checkG1OnCurve('snarkjs pi_a', proof.pi_a);
          checkG1OnCurve('rust pi_a', rustResult.proof.pi_a);
          checkG1OnCurve('snarkjs pi_c', proof.pi_c);
          checkG1OnCurve('rust pi_c', rustResult.proof.pi_c);

          // Try swapping Fq2 components in pi_b to check if that fixes it
          console.log('\n--- Testing with swapped Fq2 components (c0↔c1) in pi_b ---');
          const swappedProof = {
            ...rustResult.proof,
            pi_b: [
              [rustResult.proof.pi_b[0][1], rustResult.proof.pi_b[0][0]],
              [rustResult.proof.pi_b[1][1], rustResult.proof.pi_b[1][0]],
              rustResult.proof.pi_b[2],
            ],
          };
          const swappedValid = await snarkjs.groth16.verify(vk, rustResult.publicSignals, swappedProof);
          console.log('Swapped Fq2 verify:', swappedValid ? 'PASS ✓ (Fq2 ordering is the bug!)' : 'FAIL ✗ (not a Fq2 swap issue)');

          if (rustValid) {
            console.log('\n=== CONCLUSION: Proofs are valid. Issue is in on-chain byte encoding. ===');
          } else if (swappedValid) {
            console.log('\n=== CONCLUSION: Fq2 component ordering is SWAPPED in serialize.rs! ===');
            console.log('Fix: swap x.c0↔x.c1 and y.c0↔y.c1 in g2_to_strings()');
          } else {
            console.log('\n=== CONCLUSION: Rust prover generates invalid proofs! ===');

            // Compare public signals
            console.log('\nPublic signals comparison:');
            for (let i = 0; i < publicSignals.length; i++) {
              const match = publicSignals[i] === rustResult.publicSignals[i];
              console.log(`  [${i}] snarkjs: ${publicSignals[i].slice(0, 30)}... rust: ${rustResult.publicSignals[i].slice(0, 30)}... ${match ? '✓' : '✗ MISMATCH'}`);
            }

            // Check if Rust proof has protocol/curve metadata
            console.log('\nRust proof metadata:', {
              protocol: rustResult.proof.protocol,
              curve: rustResult.proof.curve,
              pi_a_len: rustResult.proof.pi_a?.length,
              pi_b_len: rustResult.proof.pi_b?.length,
              pi_b_inner: rustResult.proof.pi_b?.map((a: any) => a?.length),
              pi_c_len: rustResult.proof.pi_c?.length,
            });
          }
        }
      } catch (e: any) {
        console.error('Rust prover call failed:', e.message);
      }
    } else {
      console.log('\n=== snarkjs proof failed! Check circuit inputs. ===');
    }

  } catch (e: any) {
    console.error('Test failed:', e.message);
    console.error(e.stack);
  }
}

main().catch(console.error);
