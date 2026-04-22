import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  buildRegisterServiceIx,
  buildUpdateServiceIx,
  buildDeregisterServiceIx,
  fetchService,
  type RegisterServiceArgs,
  type UpdateServiceArgs,
  type ServiceEntry,
} from '@protocol-01/specter-sdk';

/**
 * Pick either native SOL (via `SystemProgram.programId`) or an SPL mint
 * when pricing your service. Kept as a typed alias so merchant apps don't
 * have to import `SystemProgram` themselves.
 */
export const NATIVE_SOL_MINT = SystemProgram.programId;

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export interface MerchantRegistrationConfig extends RegisterServiceArgs {
  /** Skip re-registration if a PDA already exists for `(owner, slug)`. */
  skipIfExists?: boolean;
}

export interface MerchantRegistrationResult {
  /** Service PDA (stable address to share with subscribers). */
  pda: PublicKey;
  /** Transaction signature of the registration (null if skipped). */
  signature: string | null;
  /** `true` if the service existed before this call. */
  alreadyExisted: boolean;
}

/**
 * Register a new service in the on-chain registry. Caller supplies the
 * merchant's signing `Keypair` (usually a dedicated hot wallet separate
 * from the cold `retailer` that receives payments).
 *
 * Idempotent: if the PDA already exists and `skipIfExists` is true, the
 * function short-circuits with the existing PDA and `alreadyExisted: true`.
 */
export async function registerServiceOnChain(
  connection: Connection,
  merchantSigner: Keypair,
  config: MerchantRegistrationConfig,
): Promise<MerchantRegistrationResult> {
  const { skipIfExists = true, ...args } = config;

  const existing = await fetchService(connection, merchantSigner.publicKey, args.slug);
  if (existing && skipIfExists) {
    return {
      pda: existing.pda,
      signature: null,
      alreadyExisted: true,
    };
  }

  if (existing) {
    throw new Error(
      `service '${args.slug}' already registered at ${existing.pda.toBase58()} — ` +
        `pass skipIfExists: false to replace, or call updateService instead`,
    );
  }

  const ix = buildRegisterServiceIx(merchantSigner.publicKey, args);
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [merchantSigner], {
    commitment: 'confirmed',
  });

  const entry = await fetchService(connection, merchantSigner.publicKey, args.slug);
  if (!entry) {
    throw new Error(`registration confirmed but PDA not found — check RPC`);
  }

  return { pda: entry.pda, signature: sig, alreadyExisted: false };
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/**
 * Update mutable fields on an existing service. `retailer` and `tokenMint`
 * are intentionally immutable — migrate via deregister + re-register.
 */
export async function updateServiceOnChain(
  connection: Connection,
  merchantSigner: Keypair,
  args: UpdateServiceArgs,
): Promise<string> {
  const ix = buildUpdateServiceIx(merchantSigner.publicKey, args);
  const tx = new Transaction().add(ix);
  return sendAndConfirmTransaction(connection, tx, [merchantSigner], {
    commitment: 'confirmed',
  });
}

/**
 * Close the service PDA and reclaim rent. The service stops appearing in
 * subscriber UIs on their next registry refresh.
 */
export async function deregisterServiceOnChain(
  connection: Connection,
  merchantSigner: Keypair,
  slug: string,
): Promise<string> {
  const ix = buildDeregisterServiceIx(merchantSigner.publicKey, slug);
  const tx = new Transaction().add(ix);
  return sendAndConfirmTransaction(connection, tx, [merchantSigner], {
    commitment: 'confirmed',
  });
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Fetch the live on-chain state of a service the merchant registered.
 */
export async function getRegisteredService(
  connection: Connection,
  merchantPubkey: PublicKey,
  slug: string,
): Promise<ServiceEntry | null> {
  return fetchService(connection, merchantPubkey, slug);
}
