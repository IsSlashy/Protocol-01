import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { REGISTRY_PROGRAM_ID } from '../constants';
import {
  decodeServiceRegistryAccount,
  SERVICE_REGISTRY_DISCRIMINATOR,
  type ServiceRegistryAccount,
} from './account';
import { getServicePDA } from './pda';

/** A decoded service together with its on-chain PDA. */
export interface ServiceEntry extends ServiceRegistryAccount {
  /** PDA address of this service entry. */
  pda: PublicKey;
}

/**
 * Fetch a single service by `(owner, slug)`. Returns `null` if not found.
 */
export async function fetchService(
  connection: Connection,
  owner: PublicKey,
  slug: string,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): Promise<ServiceEntry | null> {
  const [pda] = getServicePDA(owner, slug, programId);
  const info = await connection.getAccountInfo(pda);
  if (!info || !info.data || info.data.length === 0) {
    return null;
  }
  const decoded = decodeServiceRegistryAccount(info.data);
  return { ...decoded, pda };
}

/**
 * Fetch a single service by its PDA address. Returns `null` if not found.
 */
export async function fetchServiceByPda(
  connection: Connection,
  pda: PublicKey,
): Promise<ServiceEntry | null> {
  const info = await connection.getAccountInfo(pda);
  if (!info || !info.data || info.data.length === 0) {
    return null;
  }
  const decoded = decodeServiceRegistryAccount(info.data);
  return { ...decoded, pda };
}

export interface FetchServicesOptions {
  /** Only return services where `active === true`. Default: true. */
  activeOnly?: boolean;
  /** Only return verified services. Default: false (returns both). */
  verifiedOnly?: boolean;
  /** Filter by category. */
  category?: string;
  /** Filter by owner pubkey (merchant). */
  owner?: PublicKey;
  /** RPC commitment level. */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/**
 * Fetch every `ServiceRegistry` account registered with the program and
 * apply the given filters client-side.
 *
 * The discriminator filter is pushed to the RPC (`memcmp` at offset 0) so we
 * only hydrate actual service accounts — UserRegistry entries under the same
 * program are ignored.
 *
 * ⚠ On busy clusters `getProgramAccounts` is expensive. Callers should cache
 * results and refresh on a schedule (see `apps/mobile/services/solana/
 * serviceRegistry.ts`).
 */
export async function fetchAllServices(
  connection: Connection,
  opts: FetchServicesOptions = {},
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): Promise<ServiceEntry[]> {
  const {
    activeOnly = true,
    verifiedOnly = false,
    category,
    owner,
    commitment = 'confirmed',
  } = opts;

  const filters: Array<{ memcmp: { offset: number; bytes: string } }> = [
    {
      memcmp: {
        offset: 0,
        bytes: bs58.encode(SERVICE_REGISTRY_DISCRIMINATOR),
      },
    },
  ];

  if (owner) {
    filters.push({
      memcmp: {
        offset: 8,
        bytes: owner.toBase58(),
      },
    });
  }

  const accounts = await connection.getProgramAccounts(programId, {
    commitment,
    filters,
  });

  // Debug hook — lets the mobile app surface why N raw accounts turned into
  // 0 decoded entries (common cause: base64/Buffer shape differences across
  // web3.js runtimes). Keep logs cheap; no-op when no accounts come back.
  const first = accounts[0];
  if (!first) {
    console.log(
      `[fetchAllServices] getProgramAccounts returned 0 accounts for ${programId.toBase58()} ` +
        `(filters: discriminator memcmp at offset 0)`,
    );
  } else {
    console.log(
      `[fetchAllServices] got ${accounts.length} raw accounts. ` +
        `First data: type=${typeof first.account.data} ` +
        `isBuffer=${Buffer.isBuffer(first.account.data)} ` +
        `length=${(first.account.data as { length?: number }).length ?? 'n/a'}`,
    );
  }

  const entries: ServiceEntry[] = [];
  let decodeFailures = 0;
  for (const acc of accounts) {
    let decoded: ServiceRegistryAccount;
    try {
      decoded = decodeServiceRegistryAccount(acc.account.data);
    } catch (err) {
      decodeFailures += 1;
      if (decodeFailures <= 3) {
        console.warn(
          `[fetchAllServices] decode failed for ${acc.pubkey.toBase58()}: ${(err as Error).message}`,
        );
      }
      continue;
    }
    if (activeOnly && !decoded.active) continue;
    if (verifiedOnly && !decoded.verified) continue;
    if (category && decoded.category !== category) continue;
    entries.push({ ...decoded, pda: acc.pubkey });
  }
  if (decodeFailures > 0) {
    console.warn(
      `[fetchAllServices] ${decodeFailures}/${accounts.length} accounts failed to decode`,
    );
  }

  entries.sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

