/**
 * THE SCRIPT. This file is the contract for the Styx presentation video.
 *
 * Structure asked for by the founder: show the USAGE, then the SYSTEM, then the
 * RESULT. Three acts, in that order, because that is the order a stranger can
 * follow: what would I do with it, how does it work, and did it actually happen.
 *
 * EVERY NUMBER BELOW IS MEASURED. They come from an adversarial verification
 * pass over the repository, npm and Solana devnet on 2026-08-11, the same source
 * as the pitch deck. Nothing here is an estimate dressed as a fact, and the two
 * uncomfortable ones (the deposit-to-withdrawal link, and no audit) are on
 * screen rather than in a footnote, because a viewer who can check one
 * uncomfortable claim tends to believe the comfortable ones.
 *
 * FORBIDDEN, in copy as much as in colour: untraceable, anonymous, unlinkable,
 * zero traces, sender hidden, audited, mainnet, any user or volume or TVL figure,
 * any performance number without its benchmark beside it.
 *
 * English on purpose: the deck an investor reads is English, and the video is
 * shown alongside it. A French cut is a translation of this file, not a rewrite.
 *
 * 7200 frames at 60fps = 120 seconds. Frame numbers are absolute.
 */

export const FPS = 60;
export const TOTAL_FRAMES = 7200;

export type Beat = {
  /** Absolute start frame. */
  from: number;
  /** How long this beat holds. */
  duration: number;
  /** Which act it belongs to, for the marginal numeral. */
  act: '' | 'I' | 'II' | 'III';
  /** The mono label above the statement. */
  eyebrow: string;
  /** The serif line. Keep it one sentence: it is read in about four seconds. */
  statement: string;
  /** Body copy under the rule. Two sentences at most. */
  lede?: string;
  /** Mono evidence, the thing a viewer could go and check. */
  evidence?: string;
};

export const OPENING: Beat = {
  from: 0,
  duration: 360,
  act: '',
  eyebrow: 'Styx Protocol',
  statement: 'Private payments on Solana. Built to be checked, not believed.',
  lede: 'A shielded payment pool, hash-based STARK proofs, and hybrid post-quantum stealth addresses. Running on devnet.',
};

/** ACT I, the usage. What a person actually does, and what the chain sees. */
export const ACT_I: Beat[] = [
  {
    from: 360,
    duration: 780,
    act: 'I',
    eyebrow: 'Act one, the usage',
    statement: 'You deposit into a pool everyone shares.',
    lede: 'A fixed denomination, so the amount you moved is not distinctive. The chain records that you paid in, plus one hash that binds the amount to secrets only you hold.',
    evidence: 'on chain: your deposit, one Poseidon commitment',
  },
  {
    from: 1140,
    duration: 840,
    act: 'I',
    eyebrow: 'Act one, the usage',
    statement: 'You pay without pointing at which note is yours.',
    lede: 'To spend, you prove that a note of yours sits in the pool and that value is conserved, without revealing the note. A Solana program checks the proof. There is no server in the middle.',
    evidence: 'on chain: one proof, one nullifier',
  },
  {
    from: 1980,
    duration: 780,
    act: 'I',
    eyebrow: 'Act one, the usage',
    statement: 'You withdraw, or a merchant collects a subscription.',
    lede: 'Recurring plans live as on-chain vaults the subscriber funds ahead of time. Collecting is permissionless: anyone may send the transaction, and only the address the merchant registered can receive.',
    evidence: 'on chain: one withdrawal, to whoever you say',
  },
];

/** ACT II, the system. What is underneath, at the level of a working engineer. */
export const ACT_II: Beat[] = [
  {
    from: 2760,
    duration: 780,
    act: 'II',
    eyebrow: 'Act two, the system',
    statement: 'Balances become commitments in a Merkle tree.',
    lede: 'The pool tracks hashes, not balances sitting on addresses. Spending inserts a nullifier that makes the same note unspendable twice, which is what lets the chain check a movement it cannot attribute.',
    evidence: '325 commitments across 72 pools, 161 nullifiers, and the two reconcile',
  },
  {
    from: 3540,
    duration: 840,
    act: 'II',
    eyebrow: 'Act two, the system',
    statement: 'The proof is verified on Solana, inside one instruction.',
    lede: 'A hash-based STARK over the Goldilocks field: Poseidon and Merkle only. No elliptic curves in the proof, no pairings, and no trusted setup, so there is no ceremony anyone has to trust.',
    evidence: '809,662 compute units of the 1,399,850 a single instruction can spend',
  },
  {
    from: 4380,
    duration: 780,
    act: 'II',
    eyebrow: 'Act two, the system',
    statement: 'Post-quantum where we control it. Classical where the chain decides.',
    lede: 'Recipients are paid at one-time addresses sealed with X25519 plus ML-KEM-768, the lattice KEM standardised in FIPS 203. Break one half and the other still holds.',
    evidence: 'transaction signatures stay Ed25519, because Solana verifies nothing else',
  },
];

/** ACT III, the result. What actually happened, including what did not. */
export const ACT_III: Beat[] = [
  {
    from: 5160,
    duration: 840,
    act: 'III',
    eyebrow: 'Act three, the result',
    statement: 'It accepts an honest proof and refuses two forgeries, differently.',
    lede: 'A proof with one byte flipped has to pay for the whole low-degree test before it fails. A tampered public input breaks Fiat-Shamir and dies at once. Two mechanisms, both closed.',
    evidence: 'accepted 809,812 CU · forged 542,150 CU · tampered input 19,777 CU',
  },
  {
    from: 6000,
    duration: 840,
    act: 'III',
    eyebrow: 'Act three, the result',
    statement: 'And here is what it does not do yet.',
    lede: 'A deposit can still be paired with its withdrawal: the withdrawal republishes the commitment the deposit created. The spend circuit that closes it is in development.',
    evidence: 'not audited · devnet only · no mainnet deployment',
  },
];

export const CLOSING: Beat = {
  from: 6840,
  duration: 360,
  act: '',
  eyebrow: 'Styx Protocol',
  statement: 'A commitment you cannot take back.',
  lede: 'Styx is the river the gods swore on, the one oath they could not break. Every figure in this video was measured on devnet and can be re-measured by you.',
};

export const ALL_BEATS: Beat[] = [OPENING, ...ACT_I, ...ACT_II, ...ACT_III, CLOSING];
