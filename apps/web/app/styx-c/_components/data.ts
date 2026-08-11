/**
 * Every value on this page that refers to the chain or the repo lives here,
 * so there is exactly one place to audit.
 *
 * The four program IDs below are the `declare_id!` values in this repo AND
 * were re-checked against devnet immediately before this page was written:
 * `getMultipleAccounts` on api.devnet.solana.com at slot 481,970,548
 * (2026-08-08) returned all four as `executable: true`. The standalone
 * `subscription` program's declare_id is deliberately NOT listed: it is not
 * deployed. Subscription vaults live inside `zk_shielded`.
 */

export const REPO = 'https://github.com/IsSlashy/Protocol-01';

export const explorerUrl = (id: string): string =>
  `https://explorer.solana.com/address/${id}?cluster=devnet`;

export const sourceUrl = (path: string): string => `${REPO}/blob/master/${path}`;

export const VERIFIED = {
  rpc: 'api.devnet.solana.com',
  slot: '481,970,548',
  date: '2026-08-08',
} as const;

export interface ProgramRow {
  name: string;
  id: string;
  role: string;
  sourcePath: string;
}

export const PROGRAMS: ProgramRow[] = [
  {
    name: 'zk_shielded',
    id: 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c',
    role: 'Shielded pool: denominated deposits as Poseidon commitments in a Merkle tree, STARK-gated unshield, on-chain subscription vaults.',
    sourcePath: 'programs/zk_shielded/src/lib.rs',
  },
  {
    name: 'p01_stark_verifier',
    id: 'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs',
    role: 'On-chain STARK verifier: Poseidon and Merkle constraints over the Goldilocks field, FRI low-degree test. No elliptic curves, no trusted setup.',
    sourcePath: 'programs/p01_stark_verifier/src/lib.rs',
  },
  {
    name: 'specter',
    id: 'FgKhXakZGsd4PdiGgACYy8gwj1JLMYA691yQr2PhUNfL',
    role: 'Stealth wallet accounts and payment announcements: the on-chain transport stealth payments ride on.',
    sourcePath: 'programs/specter/src/lib.rs',
  },
  {
    name: 'p01_registry',
    id: 'QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB',
    role: 'Merchant service registry: the services a subscription vault can be scoped to.',
    sourcePath: 'programs/p01_registry/src/lib.rs',
  },
];

export interface CryptoRow {
  layer: string;
  construction: string;
  job: string;
  status: 'pq' | 'hybrid' | 'classical';
  note: string;
}

export const CRYPTO_ROWS: CryptoRow[] = [
  {
    layer: 'Note commitments',
    construction: 'Poseidon hash, Goldilocks field',
    job: 'Binds each deposit to a secret without storing an owner.',
    status: 'pq',
    note: 'Hash-based. No number-theoretic assumption to break.',
  },
  {
    layer: 'Membership',
    construction: 'Merkle tree over Poseidon',
    job: 'Proves a note is in the pool without saying which one.',
    status: 'pq',
    note: 'Hash-based, same footing as the commitments.',
  },
  {
    layer: 'Proof system',
    construction: 'STARK with FRI',
    job: 'Proves the withdrawal is well-formed.',
    status: 'pq',
    note: 'Post-quantum by construction: no curves, no pairings, no trusted setup.',
  },
  {
    layer: 'Stealth addressing',
    construction: 'X25519 + ML-KEM-768 hybrid',
    job: 'Derives a one-time address per payment.',
    status: 'hybrid',
    note: 'ML-KEM-768 is the FIPS 203 lattice KEM. The hybrid holds if either component holds.',
  },
  {
    layer: 'Transaction signature',
    construction: 'Ed25519',
    job: 'Authorizes the Solana transaction itself.',
    status: 'classical',
    note: 'The Solana runtime verifies only Ed25519. Not our choice to make.',
  },
];

export interface LimitRow {
  label: string;
  body: string;
  linkText?: string;
  linkHref?: string;
}

export const LIMITS: LimitRow[] = [
  {
    label: 'Not audited',
    body: 'No third-party security audit has been performed on any part of this system. That sentence stays on this page until it stops being true.',
  },
  {
    label: 'Devnet only',
    body: 'Every program listed here runs on Solana devnet. There is no mainnet deployment. Anything claiming to be this protocol on mainnet is not this project.',
  },
  {
    label: 'Spend linkability',
    body: 'The current unshield passes the spent note commitment as a public input, so a withdrawal can be matched to its deposit by anyone reading the chain. The spend circuit that removes this is specified and in development. Until it ships, do not treat the deposit-to-withdrawal link as private.',
    linkText: 'docs/C7_SPEND_CIRCUIT_PLAN.md',
    linkHref: 'docs/C7_SPEND_CIRCUIT_PLAN.md',
  },
  {
    label: 'No cancel, no refund',
    body: 'A funded subscription period is a commitment. There is no cancel instruction and no refund path, by design. Know this before funding periods.',
  },
  {
    label: 'Classical signature',
    body: 'Post-quantum on the proof and the encryption, classical on the transaction signature: Solana leaves no other option for the outer signature.',
  },
];
