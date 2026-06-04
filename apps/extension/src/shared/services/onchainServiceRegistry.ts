/**
 * onchainServiceRegistry — READ-ONLY reader for the on-chain P01 service registry
 * (program `p01_registry`, devnet). Ports the mobile reader + the specter-sdk
 * decoder into the extension's manual-buffer convention (no borsh, no new deps).
 *
 * A registered service carries everything cross-device subscription sync needs:
 *   - merchant identity: `owner` pubkey + `slug` (stable per-owner id) + `name`
 *   - `retailer` pubkey  — the JOIN KEY to match a subscription vault to a tile
 *   - `priceAtomic` + `intervalSlots` — real on-chain price / billing period
 *   - `verified` / `active` flags for badging + filtering
 *
 * Byte layout verified against programs/p01_registry/src/state/service_registry.rs
 * AND packages/specter-sdk/src/service-registry/account.ts (the two witnesses agree).
 * The 5 trailing strings are Borsh `String` ([u32 LE len][len UTF-8 bytes], UNPADDED)
 * — they must be read sequentially, advancing the offset by 4+len each.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { getConnection, type NetworkType } from './wallet';
import {
  SERVICE_REGISTRY as BRANDING_REGISTRY,
  detectServiceFromName,
  createGenericServiceInfo,
  type ServiceInfo,
} from './serviceRegistry';

/** p01_registry program — DEVNET ONLY (mainnet/testnet ids are PublicKey.default). */
export const REGISTRY_PROGRAM_ID = new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB');

/** sha256("account:ServiceRegistry")[..8] — distinguishes ServiceRegistry from UserRegistry. */
export const SERVICE_REGISTRY_DISCRIMINATOR = Buffer.from([105, 133, 96, 79, 207, 176, 202, 71]);

/** Native SOL sentinel mint (SystemProgram). */
export const NATIVE_MINT = '11111111111111111111111111111111';

/** Fixed prefix (8 disc + 3*32 pubkeys + 3*8 u64 + 5 bool/bump + 2*8 i64) + 5 mandatory u32 string prefixes. */
const MIN_ACCOUNT_LEN = 149 + 5 * 4; // 169

export interface OnchainServiceEntry {
  /** Base58 account address (the ServiceRegistry PDA). */
  address: string;
  owner: string;
  retailer: string;
  tokenMint: string;
  /** Price in tokenMint's smallest unit (lamports for native SOL). */
  priceAtomic: number;
  intervalSlots: number;
  subscriberCount: number;
  supportsOneshot: boolean;
  supportsVault: boolean;
  verified: boolean;
  active: boolean;
  bump: number;
  createdAt: number;
  updatedAt: number;
  slug: string;
  name: string;
  iconKey: string;
  category: string;
  metadataUri: string;
}

/** Read a Borsh `String`: [u32 LE len][len UTF-8 bytes]. Returns the value + next offset. */
function readBorshString(data: Buffer, offset: number): { value: string; next: number } {
  const len = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  return { value: data.subarray(start, end).toString('utf8'), next: end };
}

/**
 * Decode one ServiceRegistry account. Throws on a foreign/short account so the
 * bulk loop can skip it (mirrors the SDK's per-account tolerance).
 */
export function parseServiceRegistryAccount(data: Buffer, address: string): OnchainServiceEntry {
  if (data.length < MIN_ACCOUNT_LEN) {
    throw new Error('ServiceRegistry: account too short');
  }
  if (!data.subarray(0, 8).equals(SERVICE_REGISTRY_DISCRIMINATOR)) {
    throw new Error('ServiceRegistry: discriminator mismatch');
  }

  const owner = new PublicKey(data.subarray(8, 40)).toBase58();
  const retailer = new PublicKey(data.subarray(40, 72)).toBase58();
  const tokenMint = new PublicKey(data.subarray(72, 104)).toBase58();
  const priceAtomic = Number(data.readBigUInt64LE(104));
  const intervalSlots = Number(data.readBigUInt64LE(112));
  const subscriberCount = Number(data.readBigUInt64LE(120));
  const supportsOneshot = data[128] === 1;
  const supportsVault = data[129] === 1;
  const verified = data[130] === 1;
  const active = data[131] === 1;
  const bump = data[132];
  const createdAt = Number(data.readBigInt64LE(133));
  const updatedAt = Number(data.readBigInt64LE(141));

  let offset = 149;
  const slugR = readBorshString(data, offset); offset = slugR.next;
  const nameR = readBorshString(data, offset); offset = nameR.next;
  const iconR = readBorshString(data, offset); offset = iconR.next;
  const catR = readBorshString(data, offset); offset = catR.next;
  const metaR = readBorshString(data, offset); offset = metaR.next;

  return {
    address,
    owner,
    retailer,
    tokenMint,
    priceAtomic,
    intervalSlots,
    subscriberCount,
    supportsOneshot,
    supportsVault,
    verified,
    active,
    bump,
    createdAt,
    updatedAt,
    slug: slugR.value,
    name: nameR.value,
    iconKey: iconR.value,
    category: catR.value,
    metadataUri: metaR.value,
  };
}

export interface FetchServicesOpts {
  activeOnly?: boolean;
  verifiedOnly?: boolean;
  /** Filter to one merchant owner (base58). Applied as a memcmp at offset 8. */
  owner?: string;
}

/**
 * Fetch + decode all on-chain services. DEVNET only — returns [] on other networks
 * (the registry program isn't deployed there). Never throws on a bad account.
 */
export async function fetchAllServices(
  network: NetworkType,
  opts: FetchServicesOpts = {},
): Promise<OnchainServiceEntry[]> {
  if (network !== 'devnet') return [];

  const connection: Connection = getConnection(network);
  const filters: any[] = [
    {
      memcmp: {
        offset: 0,
        bytes: SERVICE_REGISTRY_DISCRIMINATOR.toString('base64'),
        encoding: 'base64' as const,
      },
    },
  ];
  if (opts.owner) {
    filters.push({
      memcmp: {
        offset: 8,
        bytes: new PublicKey(opts.owner).toBuffer().toString('base64'),
        encoding: 'base64' as const,
      },
    });
  }

  const accounts = await connection.getProgramAccounts(REGISTRY_PROGRAM_ID, { filters });

  const out: OnchainServiceEntry[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const entry = parseServiceRegistryAccount(Buffer.from(account.data), pubkey.toBase58());
      if (opts.activeOnly && !entry.active) continue;
      if (opts.verifiedOnly && !entry.verified) continue;
      out.push(entry);
    } catch (err) {
      // Foreign account under the same program (e.g. UserRegistry) or malformed — skip.
      console.warn('[onchainServiceRegistry] skip account', pubkey.toBase58(), (err as Error).message);
    }
  }

  // Verified first, then alphabetical — same ordering intent as mobile.
  out.sort((a, b) => Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name));
  return out;
}

/** Fetch a single service account by its PDA address. */
export async function fetchServiceRegistry(
  address: string,
  network: NetworkType,
): Promise<OnchainServiceEntry | null> {
  if (network !== 'devnet') return null;
  const info = await getConnection(network).getAccountInfo(new PublicKey(address));
  if (!info) return null;
  try {
    return parseServiceRegistryAccount(Buffer.from(info.data), address);
  } catch {
    return null;
  }
}

/**
 * The vault->tile JOIN. Matches a subscription vault's `retailer` to a service.
 * `retailer` is NOT unique across services, so tokenMint equality is REQUIRED to
 * disambiguate (a retailer can offer SOL and SPL plans). Prefers a verified entry.
 */
export function findServiceByRetailer(
  services: OnchainServiceEntry[],
  retailer: string,
  tokenMint: string,
): OnchainServiceEntry | undefined {
  const matches = services.filter((s) => s.retailer === retailer && s.tokenMint === tokenMint);
  if (matches.length <= 1) return matches[0];
  return matches.find((s) => s.verified) ?? matches[0];
}

/**
 * Resolve a branding ServiceInfo (logo/category) for an on-chain entry. iconKey and
 * slug are merchant-controllable free text, so try exact catalog hits, then fall
 * back to fuzzy name detection, then a generic placeholder. Never trusts iconKey blindly.
 */
export function resolveServiceBranding(entry: OnchainServiceEntry): ServiceInfo {
  const exact =
    BRANDING_REGISTRY[entry.iconKey] ||
    BRANDING_REGISTRY[entry.slug] ||
    detectServiceFromName(entry.name);
  if (exact) return exact;
  const generic = createGenericServiceInfo(entry.name);
  return { id: entry.slug || entry.name, domains: [], ...generic } as ServiceInfo;
}
