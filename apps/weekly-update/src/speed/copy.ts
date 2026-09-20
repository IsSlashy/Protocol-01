/**
 * THE WORDS AND THE NUMBERS of the speed film, in one place.
 *
 * THE NARRATIVE, for someone who has never heard of a proof: privacy used to
 * cost you six minutes of waiting; it now costs twenty seconds; here is the
 * same operation timed before and after; here is why; here is where to look.
 * One idea per scene, one number per idea. The hook is the wait, because
 * everyone has watched a spinner and nobody has watched a STARK.
 *
 * Every measured figure names its source. The sources are docs/BENCHMARK-2026-09-13.md
 * (sections in brackets) and the raw logs those sections cite; the one figure that
 * is NOT from a log is marked as such and attributed to the founder on screen.
 *
 * FORBIDDEN in copy: untraceable, anonymous, unlinkable, zero-knowledge, trustless,
 * first, audited, mainnet as a fact, any user or volume figure.
 */
export const FPS = 60;

/** Frame layout. Each scene is a Series.Sequence; durations are in frames. */
export const SCENES = {
  intro: 420, // 7 s: the hook and the tension
  race: 840, // 14 s: the same withdrawal, before and after
  shield: 540, // 9 s: the number
  breakdown: 600, // 10 s: why
  outro: 300, // 5 s: the line and the address
} as const;

export const TOTAL_FRAMES = Object.values(SCENES).reduce((a, b) => a + b, 0);

export const N = {
  /** The founder's stopwatch on the previous web client, public RPC. Not a log. */
  beforeRealUseMinutes: 6,
  /** liveDevnetUnshieldV4, 12 Sept 15:31, whole test [§5]. bench/live_flow_liveDevnetUnshieldV4.log */
  withdrawTestBefore: 357.9,
  /** Same test, 12 Sept 16:59, redeployed verifier [§6c]. live_flow_liveDevnetUnshieldV4_masked_verifier.log */
  withdrawTestAfter: 66.3,
  /** The withdrawal alone inside that run: prepare 3.9 + execute 16.9 [§6c]. */
  withdrawAfter: 20.8,
  /** liveDevnetSubscribeV4 whole test, before [§5] and after [§6c]. */
  subscribeTestBefore: 436.8,
  subscribeTestAfter: 63.4,
  /** liveDevnetShield test 1, 12 Sept [§6c], 18,636 ms. */
  shield: 18.6,
  /** Subscription v4 alone, prepare 5.7 + execute 17.3 [§6c]. */
  subscribe: 23.0,
  /** C6 proof upload, chunks: legacy 1,232-byte vs transaction v1 3,840-byte [§2b]. */
  chunksBefore: 83,
  chunksAfter: 22,
  /** Proof step of one C6 shield, prove + pipeline, Helius [§3, §2, §2b]. */
  proofLegacy: 40.7,
  proofL2: 14.5,
  proofV1: 8.2,
  /** Pool scan before / after the epoch-bounded search [§5b, warm3 → warm4]. */
  scanBefore: 53.2,
  scanAfter: 2.2,
} as const;

export const SIG = {
  shield: '5Hcgq2W2…C68JHxop',
  withdrawBefore: '3uAzC3tT…Dxb8zR1',
  withdrawAfter: 'nYdypYKi…ok3XwpV',
  subscribe: '2y916CDP…TF6ZUUM',
} as const;

export const COPY = {
  intro: {
    eyebrow: 'Styx · private payments on Solana',
    /** The hook. Everyone knows the feeling; nobody needs the vocabulary. */
    statement: 'Waiting was the price of privacy.',
    lede: 'A private payment meant building a proof, sending it up in 83 pieces, and six minutes watching a spinner.',
  },
  race: {
    eyebrow: 'Not any more',
    title: 'The same private withdrawal, one afternoon apart.',
    before: 'Before · 12 Sept, 15:31',
    after: 'After · 12 Sept, 16:59',
    beforeLabel: 'the whole test, start to finish',
    afterLabel: 'the same test',
    afterInner: 'the withdrawal itself',
    foot:
      'Each run scans the pool, shields a fresh note, finds it, proves and spends it on Solana devnet. Single runs, Helius RPC. The after total still carries a 28.7 s shield and a 16.6 s harness reload the app does not do.',
  },
  shield: {
    eyebrow: 'Putting money in · was six minutes in real use',
    lede: 'to shield 1 SOL into the private pool, from the proof to the leaf, on the app’s own code.',
    stats: [
      { v: N.withdrawAfter, unit: 's', k: 'to take it out, privately' },
      { v: N.subscribe, unit: 's', k: 'to pay a subscription, privately' },
      { v: N.chunksAfter, unit: 'tx', k: `to send a proof up, was ${N.chunksBefore}` },
    ],
    foot: 'Six minutes: the founder’s stopwatch on the previous web client. 18.6 s: liveDevnetShield, 12 Sept 2026, single run.',
  },
  breakdown: {
    eyebrow: 'Why',
    title: 'Where the seconds went',
    lede: 'Solana’s new transaction format carries four times more per transaction. Styx rebuilt its proof pipeline around it, and stopped re-reading what it already knew.',
    bars: [
      { label: 'Old path', v: N.proofLegacy, note: '9 buffer transactions · 83 uploads · verify in 2', teal: false },
      { label: 'Styx pipeline rewrite', v: N.proofL2, note: '1 buffer transaction · 83 uploads · verify in 1', teal: false },
      { label: '+ Solana transaction v1', v: N.proofV1, note: 'SIMD-0385 · 4,096-byte transactions · 22 uploads', teal: true },
    ],
    scan: 'Finding your note in the pool history',
    foot: 'Transaction v1 is active on devnet (slot 492,480,000), not yet on mainnet (announced for epoch 1035). Proof step of one shield, single runs.',
  },
  outro: {
    statement: 'Privacy, at the speed of a payment.',
    brand: 'Styx',
    url: 'protocol-01.dev',
    foot: `Solana devnet · every figure has a signature · shield ${SIG.shield} · withdrawal ${SIG.withdrawAfter} · subscription ${SIG.subscribe}`,
  },
} as const;
