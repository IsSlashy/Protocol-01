/**
 * ZK Prover for generating Groth16 proofs
 * Uses snarkjs with WebAssembly for client-side proof generation
 */

import * as snarkjs from 'snarkjs';
import { fieldToBytes } from '../circuits';
import { CIRCUIT_FILES, PROOF_GENERATION_TIMEOUT } from '../constants';
import type {
  Groth16ProofData,
  TransferPublicInputs,
  TransferPrivateInputs,
  FullProofInputs,
} from '../types';

/**
 * Groth16 proof structure
 */
export interface Groth16Proof {
  pi_a: Uint8Array;
  pi_b: Uint8Array;
  pi_c: Uint8Array;
}

/**
 * Proof inputs for the transfer circuit
 */
export interface ProofInputs {
  [key: string]: string | string[];
  // Public inputs
  merkle_root: string;
  nullifier_1: string;
  nullifier_2: string;
  output_commitment_1: string;
  output_commitment_2: string;
  public_amount: string;
  token_mint: string;

  // Private inputs - Note 1
  in_amount_1: string;
  in_owner_pubkey_1: string;
  in_randomness_1: string;
  in_path_indices_1: string[];
  in_path_elements_1: string[];

  // Private inputs - Note 2
  in_amount_2: string;
  in_owner_pubkey_2: string;
  in_randomness_2: string;
  in_path_indices_2: string[];
  in_path_elements_2: string[];

  // Output notes
  out_amount_1: string;
  out_recipient_1: string;
  out_randomness_1: string;
  out_amount_2: string;
  out_recipient_2: string;
  out_randomness_2: string;

  // Spending key
  spending_key: string;
}

/**
 * ZK Prover class for managing proof generation
 */
export class ZkProver {
  private wasmPath: string;
  private zkeyPath: string;
  private isInitialized: boolean = false;

  constructor(wasmPath?: string, zkeyPath?: string) {
    this.wasmPath = wasmPath || CIRCUIT_FILES.WASM;
    this.zkeyPath = zkeyPath || CIRCUIT_FILES.ZKEY;
  }

  /**
   * Initialize the prover (load circuit files)
   */
  async initialize(): Promise<void> {
    // In browser, files should be loaded from URLs
    // In Node.js, they can be loaded from filesystem
    this.isInitialized = true;
  }

  /**
   * Generate a transfer proof
   */
  async generateTransferProof(
    publicInputs: TransferPublicInputs,
    privateInputs: TransferPrivateInputs
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
    const inputs = this.buildCircuitInputs(publicInputs, privateInputs);
    return this.generateProof(inputs);
  }

  /**
   * Build circuit inputs from structured data
   */
  private buildCircuitInputs(
    publicInputs: TransferPublicInputs,
    privateInputs: TransferPrivateInputs
  ): ProofInputs {
    return {
      // Public inputs
      merkle_root: publicInputs.merkleRoot.toString(),
      nullifier_1: publicInputs.nullifier1.toString(),
      nullifier_2: publicInputs.nullifier2.toString(),
      output_commitment_1: publicInputs.outputCommitment1.toString(),
      output_commitment_2: publicInputs.outputCommitment2.toString(),
      public_amount: publicInputs.publicAmount.toString(),
      token_mint: publicInputs.tokenMint.toString(),

      // Private inputs - Note 1
      in_amount_1: privateInputs.inAmount1.toString(),
      in_owner_pubkey_1: privateInputs.inOwnerPubkey1.toString(),
      in_randomness_1: privateInputs.inRandomness1.toString(),
      in_path_indices_1: privateInputs.inPathIndices1.map(x => x.toString()),
      in_path_elements_1: privateInputs.inPathElements1.map(x => x.toString()),

      // Private inputs - Note 2
      in_amount_2: privateInputs.inAmount2.toString(),
      in_owner_pubkey_2: privateInputs.inOwnerPubkey2.toString(),
      in_randomness_2: privateInputs.inRandomness2.toString(),
      in_path_indices_2: privateInputs.inPathIndices2.map(x => x.toString()),
      in_path_elements_2: privateInputs.inPathElements2.map(x => x.toString()),

      // Output notes
      out_amount_1: privateInputs.outAmount1.toString(),
      out_recipient_1: privateInputs.outRecipient1.toString(),
      out_randomness_1: privateInputs.outRandomness1.toString(),
      out_amount_2: privateInputs.outAmount2.toString(),
      out_recipient_2: privateInputs.outRecipient2.toString(),
      out_randomness_2: privateInputs.outRandomness2.toString(),

      // Spending key
      spending_key: privateInputs.spendingKey.toString(),
    };
  }

  /**
   * Generate proof with raw circuit inputs
   */
  async generateProof(
    inputs: ProofInputs
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
    // Set timeout for proof generation
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('Proof generation timeout')),
        PROOF_GENERATION_TIMEOUT
      );
    });

    const proofPromise = this.doGenerateProof(inputs);

    return Promise.race([proofPromise, timeoutPromise]);
  }

  private async doGenerateProof(
    inputs: ProofInputs
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
    try {
      // Generate proof using snarkjs
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        inputs,
        this.wasmPath,
        this.zkeyPath
      );

      // Convert proof to byte format for on-chain verification
      const proofBytes = this.proofToBytes(proof);

      return {
        proof: proofBytes,
        publicSignals,
      };
    } catch (error) {
      throw new Error(`Proof generation failed: ${error}`);
    }
  }

  /**
   * Convert snarkjs proof to bytes for on-chain verification
   */
  private proofToBytes(proof: any): Groth16Proof {
    // pi_a is a G1 point [x, y, z] - we need compressed format
    const pi_a = this.g1ToBytes(proof.pi_a);

    // pi_b is a G2 point [[x0, x1], [y0, y1], [z0, z1]]
    const pi_b = this.g2ToBytes(proof.pi_b);

    // pi_c is a G1 point
    const pi_c = this.g1ToBytes(proof.pi_c);

    return { pi_a, pi_b, pi_c };
  }

  /**
   * Convert G1 point to compressed bytes
   */
  private g1ToBytes(point: string[]): Uint8Array {
    const bytes = new Uint8Array(64);

    // x coordinate (32 bytes)
    const x = BigInt(point[0]);
    bytes.set(fieldToBytes(x), 0);

    // y coordinate (32 bytes)
    const y = BigInt(point[1]);
    bytes.set(fieldToBytes(y), 32);

    return bytes;
  }

  /**
   * Convert G2 point to compressed bytes
   */
  private g2ToBytes(point: string[][]): Uint8Array {
    const bytes = new Uint8Array(128);

    // x coordinates (2 Fq elements = 64 bytes)
    const x0 = BigInt(point[0][0]);
    const x1 = BigInt(point[0][1]);
    bytes.set(fieldToBytes(x0), 0);
    bytes.set(fieldToBytes(x1), 32);

    // y coordinates (2 Fq elements = 64 bytes)
    const y0 = BigInt(point[1][0]);
    const y1 = BigInt(point[1][1]);
    bytes.set(fieldToBytes(y0), 64);
    bytes.set(fieldToBytes(y1), 96);

    return bytes;
  }

  /**
   * Verify proof locally (for testing)
   */
  async verifyProof(
    proof: any,
    publicSignals: string[],
    vkPath: string
  ): Promise<boolean> {
    try {
      const vk = await fetch(vkPath).then(r => r.json());
      return snarkjs.groth16.verify(vk, publicSignals, proof);
    } catch {
      return false;
    }
  }
}

/**
 * Generate a transfer proof (convenience function)
 */
export async function generateProof(
  inputs: FullProofInputs,
  wasmPath?: string,
  zkeyPath?: string
): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
  const prover = new ZkProver(wasmPath, zkeyPath);
  return prover.generateTransferProof(inputs.public, inputs.private);
}

// Re-export types
export type { FullProofInputs };
