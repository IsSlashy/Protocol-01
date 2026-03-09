import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS } from '../client';

/**
 * UC2: Anonymous Registry Lookup
 *
 * Problem: When looking up a stealth meta-address in the on-chain registry,
 * the RPC node sees which wallet address you're querying — leaking the
 * sender→recipient relationship before any payment is even made.
 *
 * Solution: User submits encrypted wallet address → MPC queries the registry →
 * returns encrypted meta-address. RPC node never sees the target wallet.
 *
 * Flow:
 * 1. Sender encrypts target wallet address with Arcium shared secret
 * 2. Submits to P01 Arcium program
 * 3. MPC reads registry PDA for that wallet (via account reference)
 * 4. If registered: returns encrypted meta-address (spending_pub + viewing_pub)
 * 5. If not registered: returns encrypted zero/sentinel
 * 6. Sender decrypts client-side → has meta-address without RPC knowledge
 */

export interface PrivateLookupResult {
  /** Whether the target wallet is registered */
  isRegistered: boolean;
  /** Encrypted meta-address (only sender can decrypt) */
  spendingPubKey: Uint8Array | null;
  viewingPubKey: Uint8Array | null;
  /** Whether v2 (ML-KEM) key is available */
  hasKemKey: boolean;
  kemPubKey: Uint8Array | null;
  /** Computation signature */
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
 * MPC decrypts, queries registry, re-encrypts result for sender.
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

  const sig = await program.methods
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

  const finalizeSig = await client.awaitFinalization(computationOffset);

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
