import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS } from '../client';

/**
 * UC2: Anonymous Registry Lookup -- Private Meta-Address Query
 *
 * Queries a stealth meta-address from the on-chain registry without
 * revealing the target wallet to RPC nodes. The target address is
 * encrypted before submission; MPC decrypts, reads the registry PDA,
 * and returns the meta-address re-encrypted for the sender.
 *
 * **Inputs**: Target wallet address (encrypted).
 * **Output**: Spending public key + viewing public key (encrypted for sender),
 * plus optional ML-KEM-768 key for quantum resistance.
 *
 * @module registry
 */

/** Result of a private meta-address lookup. */
export interface PrivateLookupResult {
  /** Whether the target wallet has a registered meta-address. */
  isRegistered: boolean;
  /** Spending public key (32 bytes), or `null` if not registered. */
  spendingPubKey: Uint8Array | null;
  /** Viewing public key (32 bytes), or `null` if not registered. */
  viewingPubKey: Uint8Array | null;
  /** Whether the registry entry includes a post-quantum ML-KEM-768 key. */
  hasKemKey: boolean;
  /** ML-KEM-768 public key (1184 bytes), or `null` if not available. */
  kemPubKey: Uint8Array | null;
  /** Finalization callback transaction signature. */
  signature: string;
}

/** P01 Registry program ID (from memory) */
const P01_REGISTRY_PROGRAM_ID = new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB');
const REGISTRY_SEED = 'user_registry';

/** Derive the registry PDA for a wallet (same as p01_registry) */
export function getRegistryAddress(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(REGISTRY_SEED), wallet.toBuffer()],
    P01_REGISTRY_PROGRAM_ID
  );
}

/**
 * Look up a stealth meta-address without revealing the target to RPC.
 *
 * The target wallet address is encrypted before submission.
 * MPC decrypts, queries the registry PDA, and re-encrypts the result
 * for the sender.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param targetWallet - The wallet whose meta-address you want to look up.
 * @returns Lookup result with decrypted meta-address keys (if registered).
 * @throws {Error} "Registry MPC computation failed: ..." if submission or finalization fails.
 */
export async function privateLookup(
  client: ArciumClient,
  program: anchor.Program,
  targetWallet: PublicKey
): Promise<PrivateLookupResult> {
  // Encrypt the target wallet address (32 bytes → 4 u64 chunks)
  const walletBytes = targetWallet.toBuffer();
  const chunks: bigint[] = [];
  for (let i = 0; i < 32; i += 8) {
    chunks.push(
      BigInt(
        '0x' +
          Buffer.from(walletBytes.slice(i, i + 8))
            .reverse()
            .toString('hex')
      )
    );
  }

  const payload = client.encrypt(chunks);
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(CIRCUITS.PRIVATE_LOOKUP, computationOffset);

  // Include the registry PDA as a read-only account reference
  // MPC reads from this account to check registration
  const [registryAddress] = getRegistryAddress(targetWallet);

  let sig: string;
  let finalizeSig: string;
  try {
    sig = await program.methods
      .privateLookup(
        computationOffset,
        Array.from(payload.ciphertexts[0]),
        Array.from(payload.ciphertexts[1]),
        Array.from(payload.ciphertexts[2]),
        Array.from(payload.ciphertexts[3]),
        Array.from(payload.publicKey),
        client.nonceToU128(payload.nonce)
      )
      .accountsPartial({
        ...accounts,
        registryAccount: registryAddress,
        payer: client.wallet.publicKey,
      })
      .rpc({ commitment: 'confirmed' });

    finalizeSig = await client.awaitFinalization(computationOffset);
  } catch (err) {
    throw new Error(
      `Registry MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }

  // Parse result from callback
  const tx = await client.connection.getTransaction(finalizeSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  const logs = tx?.meta?.logMessages || [];

  // Callback emits encrypted meta-address
  const resultLine = logs.find((l) => l.includes('LookupResult:'));
  if (!resultLine || resultLine.includes('NotRegistered')) {
    return {
      isRegistered: false,
      spendingPubKey: null,
      viewingPubKey: null,
      hasKemKey: false,
      kemPubKey: null,
      signature: finalizeSig,
    };
  }

  // Decrypt the returned meta-address
  const encResultHex = resultLine.split('LookupResult:')[1].trim();
  const encResultBytes = Buffer.from(encResultHex, 'hex');

  // Result format: [nonce(16)] [spending_pub(32)] [viewing_pub(32)] [has_kem(1)] [kem_pub(1184)?]
  const resultNonce = encResultBytes.slice(0, 16);
  const encSpending = encResultBytes.slice(16, 48);
  const encViewing = encResultBytes.slice(48, 80);

  const decrypted = client.decrypt(
    [Array.from(encSpending), Array.from(encViewing)],
    resultNonce
  );

  return {
    isRegistered: true,
    spendingPubKey: Buffer.from(decrypted[0].toString(16).padStart(64, '0'), 'hex'),
    viewingPubKey: Buffer.from(decrypted[1].toString(16).padStart(64, '0'), 'hex'),
    hasKemKey: encResultBytes.length > 80 && encResultBytes[80] === 1,
    kemPubKey: encResultBytes.length > 81 ? encResultBytes.slice(81) : null,
    signature: finalizeSig,
  };
}
