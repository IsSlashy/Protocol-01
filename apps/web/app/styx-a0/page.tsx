import type { Metadata } from "next";
import { Instrument_Serif } from "next/font/google";
import Reveal from "./_components/Reveal";
import s from "./styx-a.module.css";
import { notFound } from "next/navigation";

/* One serif voice for statements. Body stays on Inter, evidence on JetBrains
   Mono, both already loaded by the root layout. */
const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
  variable: "--styx-serif",
});

export const metadata: Metadata = {
  title: "Styx Protocol — A baseline",
  description:
    "Private payments on Solana. A shielded pool, hash-based STARK proofs, hybrid post-quantum stealth addresses. Deployed on devnet. Not yet audited.",
};

const POOL_PROGRAM_ID = "GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c";
const REPO_URL = "https://github.com/IsSlashy/Protocol-01";
const EXPLORER_URL = `https://explorer.solana.com/address/${POOL_PROGRAM_ID}?cluster=devnet`;

export default function StyxVaultBaseline() {
  /* Internal design-exploration route. These six pages exist to compare
     directions and to document the shared vocabulary; they are not part of the
     public site, so production answers 404 exactly as /void used to. Delete the
     guard, or the route, when a direction is settled. */
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  return (
    <div className={`${s.page} ${serif.variable}`}>
      <a href="#content" className={s.skipLink}>
        Skip to content
      </a>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className={s.header}>
        <div className={`${s.container} ${s.headerInner}`}>
          <a href="#content" className={s.wordmark} aria-label="Styx Protocol, top of page">
            <span className={s.wordmarkName}>Styx</span>
            <span className={s.wordmarkSuffix}>Protocol</span>
          </a>
          <nav className={s.nav} aria-label="Sections">
            <a className={s.navLink} href="#problem">
              Problem
            </a>
            <a className={s.navLink} href="#mechanism">
              Mechanism
            </a>
            <a className={s.navLink} href="#sdk">
              Merchants
            </a>
            <a className={s.navLink} href="#verify">
              Verification
            </a>
            <a className={s.navLink} href="/pay">
              App
            </a>
          </nav>
          <span className={s.statusChip}>
            <span className={s.statusDot} aria-hidden="true" />
            Devnet
          </span>
        </div>
      </header>

      {/* The root layout already provides the <main> landmark; this is only a
          skip-link target. */}
      <div id="content">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className={`${s.container} ${s.hero}`}>
          <p className={s.overline}>
            Styx Protocol &middot; Formerly Protocol 01 &middot; Private payments on Solana
          </p>
          <h1 className={s.heroTitle}>
            Private payments, <em className={s.heroTitleEm}>provable</em> to anyone.
          </h1>
          <div className={s.heroRule} aria-hidden="true" />
          <div className={s.heroBody}>
            <p className={s.heroLede}>
              Styx shields value in a common pool on Solana. Every movement is
              authorized by a STARK proof built from hashes alone, and recipients
              stand behind one-time addresses sealed with X25519 and ML-KEM-768.{" "}
              <strong>It runs on devnet today. It has not been audited.</strong>{" "}
              This page is careful to say which is which.
            </p>
            <div className={s.heroActions}>
              <a className={s.btnPrimary} href="/pay">
                Open the devnet app
              </a>
              <a
                className={s.btnGhost}
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Read the source
              </a>
            </div>
          </div>
        </section>

        {/* ── Facts strip ──────────────────────────────────────────────── */}
        <section className={s.container} aria-label="Protocol facts">
          <div className={s.facts}>
            <Reveal className={`${s.fact} ${s.reveal}`}>
              <p className={s.factLabel}>Proof system</p>
              <p className={s.factValue}>Hash-based STARK</p>
              <p className={s.factNote}>
                Poseidon and Merkle trees only. No elliptic curves anywhere in
                the proof.
              </p>
            </Reveal>
            <Reveal className={`${s.fact} ${s.reveal}`} delay={80}>
              <p className={s.factLabel}>Key encapsulation</p>
              <p className={s.factValue}>X25519 + ML-KEM-768</p>
              <p className={s.factNote}>
                Hybrid stealth addresses. The lattice half follows FIPS 203.
              </p>
            </Reveal>
            <Reveal className={`${s.fact} ${s.reveal}`} delay={160}>
              <p className={s.factLabel}>Status</p>
              <p className={s.factValue}>Devnet</p>
              <p className={s.factNote}>
                Deployed and running. There is no mainnet deployment.
              </p>
            </Reveal>
            <Reveal className={`${s.fact} ${s.reveal}`} delay={240}>
              <p className={s.factLabel}>Audits</p>
              <p className={s.factValue}>None yet</p>
              <p className={s.factNote}>
                We say so on the front page, and will until it changes.
              </p>
            </Reveal>
          </div>
        </section>

        {/* ── 01 · The problem ─────────────────────────────────────────── */}
        <section id="problem" className={s.section}>
          <div className={`${s.container} ${s.sectionGrid}`}>
            <div className={s.sectionLabel}>
              <p className={s.sectionIndex}>01 &middot; The problem</p>
              <h2 className={s.sectionTitle}>
                A public ledger is a public record.
              </h2>
            </div>
            <div>
              <Reveal className={`${s.prose} ${s.reveal}`}>
                <p>
                  Every ordinary transfer on Solana publishes the sender, the
                  recipient, the amount and the time. Permanently, to anyone,
                  for free. That is the design, and for most of finance it is
                  the wrong one.
                </p>
                <p>
                  Pay a salary and you have published payroll. Run a
                  subscription and you maintain a public register of who pays
                  you, how much, and the day they stop. None of this requires an
                  attacker. <strong>It only requires a reader.</strong>
                </p>
              </Reveal>
              <Reveal className={`${s.ledgers} ${s.reveal}`} delay={100}>
                <div className={s.ledger}>
                  <p className={s.ledgerCaption}>
                    An ordinary transfer, as anyone sees it
                  </p>
                  <div className={s.ledgerRow}>
                    <span className={s.ledgerKey}>from</span>
                    <span className={s.ledgerLeader} />
                    <span className={s.ledgerValue}>7xKQ…3fUw</span>
                  </div>
                  <div className={s.ledgerRow}>
                    <span className={s.ledgerKey}>to</span>
                    <span className={s.ledgerLeader} />
                    <span className={s.ledgerValue}>9mPa…Rt2c</span>
                  </div>
                  <div className={s.ledgerRow}>
                    <span className={s.ledgerKey}>amount</span>
                    <span className={s.ledgerLeader} />
                    <span className={s.ledgerValue}>1,250.00 USDC</span>
                  </div>
                  <div className={s.ledgerRow}>
                    <span className={s.ledgerKey}>memo</span>
                    <span className={s.ledgerLeader} />
                    <span className={s.ledgerValue}>&quot;salary-aug&quot;</span>
                  </div>
                  <div className={s.ledgerRow}>
                    <span className={s.ledgerKey}>history</span>
                    <span className={s.ledgerLeader} />
                    <span className={s.ledgerValue}>linked, forever</span>
                  </div>
                </div>
                <div className={s.ledger}>
                  <p className={s.ledgerCaption}>
                    The same payment through the Styx pool
                  </p>
                  <div className={s.ledgerRow}>
                    <span className={s.ledgerKey}>from</span>
                    <span className={s.ledgerLeader} />
                    <span className={`${s.ledgerValue} ${s.redacted}`}>
                      not published
                    </span>
                  </div>
                  <div className={s.ledgerRow}>
                    <span className={s.ledgerKey}>to</span>
                    <span className={s.ledgerLeader} />
                    <span className={`${s.ledgerValue} ${s.redacted}`}>
                      one-time address
                    </span>
                  </div>
                  <div className={s.ledgerRow}>
                    <span className={s.ledgerKey}>amount</span>
                    <span className={s.ledgerLeader} />
                    <span className={`${s.ledgerValue} ${s.redacted}`}>
                      inside the note
                    </span>
                  </div>
                  <div className={s.ledgerRow}>
                    <span className={s.ledgerKey}>proof</span>
                    <span className={s.ledgerLeader} />
                    <span className={s.ledgerValue}>STARK, verified on-chain</span>
                  </div>
                  <div className={s.ledgerRow}>
                    <span className={s.ledgerKey}>nullifier</span>
                    <span className={s.ledgerLeader} />
                    <span className={s.ledgerValue}>blocks double-spends</span>
                  </div>
                </div>
              </Reveal>
              <p className={s.ledgerFoot}>
                An illustration of the data model, not a live transaction.
              </p>
            </div>
          </div>
        </section>

        {/* ── 02 · Mechanism ───────────────────────────────────────────── */}
        <section id="mechanism" className={s.section}>
          <div className={`${s.container} ${s.sectionGrid}`}>
            <div className={s.sectionLabel}>
              <p className={s.sectionIndex}>02 &middot; Mechanism</p>
              <h2 className={s.sectionTitle}>Three moves, one pool.</h2>
            </div>
            <div>
              <Reveal className={`${s.prose} ${s.reveal}`}>
                <p>
                  Styx is a shielded pool: a shared vault whose contents are
                  tracked by cryptographic commitments instead of balances on
                  addresses. The chain checks that every movement is legitimate.
                  It does not learn whose movement it was.
                </p>
              </Reveal>
              <div className={s.steps}>
                <Reveal className={`${s.step} ${s.reveal}`}>
                  <span className={s.stepIndex}>01</span>
                  <div>
                    <h3 className={s.stepTitle}>Shield</h3>
                    <p className={s.stepBody}>
                      Deposit into the pool. The chain records that you paid in,
                      plus a Poseidon commitment: a hash that binds the amount
                      to secrets only you hold.
                    </p>
                    <p className={s.stepChain}>
                      On chain: <b>your deposit, one commitment.</b>
                    </p>
                  </div>
                </Reveal>
                <Reveal className={`${s.step} ${s.reveal}`} delay={80}>
                  <span className={s.stepIndex}>02</span>
                  <div>
                    <h3 className={s.stepTitle}>Pay in private</h3>
                    <p className={s.stepBody}>
                      To spend, you prove in zero knowledge that a note of yours
                      sits in the pool&apos;s Merkle tree, that you know its
                      secrets, and that value is conserved, without pointing at
                      the note itself. A Solana program verifies the STARK.
                      There is no server you must trust.
                    </p>
                    <p className={s.stepChain}>
                      On chain: <b>one proof, one nullifier.</b>
                    </p>
                  </div>
                </Reveal>
                <Reveal className={`${s.step} ${s.reveal}`} delay={160}>
                  <span className={s.stepIndex}>03</span>
                  <div>
                    <h3 className={s.stepTitle}>Unshield, or claim</h3>
                    <p className={s.stepBody}>
                      Withdraw to any address, or let a merchant claim a funded
                      subscription period. Claiming is permissionless: anyone
                      may send the transaction, and funds can only move to the
                      address the merchant registered.
                    </p>
                    <p className={s.stepChain}>
                      On chain: <b>one withdrawal, to whoever you say.</b>
                    </p>
                  </div>
                </Reveal>
              </div>

              <Reveal className={`${s.pqPanel} ${s.reveal}`}>
                <div className={s.pqHead}>
                  <p className={s.overline}>Where the post-quantum line is</p>
                  <p className={s.pqHeadTitle}>
                    Post-quantum where we control it. Classical where the chain
                    decides.
                  </p>
                </div>
                <div className={s.pqRow}>
                  <p className={s.pqRowLabel}>Proof system</p>
                  <p className={s.pqRowBody}>
                    The STARK is built from Poseidon hashes and Merkle trees.{" "}
                    <strong>No elliptic curves, no pairings</strong>, so no
                    known quantum shortcut. Post-quantum by construction, not by
                    patch.
                  </p>
                </div>
                <div className={s.pqRow}>
                  <p className={s.pqRowLabel}>Stealth addresses</p>
                  <p className={s.pqRowBody}>
                    Recipients are paid at one-time addresses sealed with hybrid
                    key encapsulation: <strong>X25519 plus ML-KEM-768</strong>,
                    the lattice KEM standardized in FIPS 203. Break one and the
                    other still holds.
                  </p>
                </div>
                <div className={s.pqRow}>
                  <p className={s.pqRowLabel}>Transaction signature</p>
                  <p className={s.pqRowBody}>
                    <strong>Ed25519, and it stays Ed25519.</strong> Solana
                    verifies nothing else. Any protocol claiming a fully
                    post-quantum transaction on Solana today is overstating. We
                    prefer the accurate sentence.
                  </p>
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── 03 · Merchants ───────────────────────────────────────────── */}
        <section id="sdk" className={s.section}>
          <div className={`${s.container} ${s.sectionGrid}`}>
            <div className={s.sectionLabel}>
              <p className={s.sectionIndex}>03 &middot; Merchants</p>
              <h2 className={s.sectionTitle}>
                A TypeScript SDK that treats privacy as plumbing.
              </h2>
            </div>
            <div>
              <Reveal className={`${s.prose} ${s.reveal}`}>
                <p>
                  Your customers pay from the pool. You ship a product. The SDK
                  covers the part in between, and never asks you to hold anyone
                  else&apos;s data to do it.
                </p>
              </Reveal>
              <Reveal as="div" className={s.reveal}>
                <ul className={s.sdkList}>
                  <li className={s.sdkItem}>
                    <span className={s.sdkItemIndex}>01</span>
                    <span className={s.sdkItemBody}>
                      <strong>Payments.</strong> Request a payment, detect
                      settlement from the pool, grant access.
                    </span>
                  </li>
                  <li className={s.sdkItem}>
                    <span className={s.sdkItemIndex}>02</span>
                    <span className={s.sdkItemBody}>
                      <strong>Subscriptions.</strong> Recurring plans live as
                      on-chain vaults the subscriber funds ahead of time.
                    </span>
                  </li>
                  <li className={s.sdkItem}>
                    <span className={s.sdkItemIndex}>03</span>
                    <span className={s.sdkItemBody}>
                      <strong>Claims.</strong> Collecting a period is
                      permissionless to send and pinned to your payout address.
                      No keeper of yours has custody.
                    </span>
                  </li>
                  <li className={s.sdkItem}>
                    <span className={s.sdkItemIndex}>04</span>
                    <span className={s.sdkItemBody}>
                      <strong>Entitlement.</strong> Whether a subscriber is
                      current is a read against the chain, not a webhook you
                      babysit.
                    </span>
                  </li>
                </ul>
              </Reveal>
              <Reveal className={`${s.codePanel} ${s.reveal}`} delay={80}>
                <div className={s.codeHead}>
                  <span>@protocol-01/merchant-sdk &middot; MIT</span>
                  <span>devnet</span>
                </div>
                <pre className={s.code}>
                  <code>
                    <span className={s.codeComment}>
                      {"// Register once. The retailer is an address, never a secret."}
                    </span>
                    {"\n"}
                    {"const service = await "}
                    <span className={s.codeName}>registerServiceOnChain</span>
                    {"(connection, merchant, {\n"}
                    {"  slug: 'standard-plan',\n"}
                    {"  priceLamports: 50_000_000n,\n"}
                    {"  intervalSlots: 6_480_000n, "}
                    <span className={s.codeComment}>{"// about 30 days"}</span>
                    {"\n"}
                    {"  retailer,\n"}
                    {"});\n\n"}
                    <span className={s.codeComment}>
                      {"// Entitlement is a read, not a webhook."}
                    </span>
                    {"\n"}
                    {"const active = "}
                    <span className={s.codeName}>subscriptionIsCurrent</span>
                    {"(vault, service);\n\n"}
                    <span className={s.codeComment}>
                      {"// Anyone may send the claim. Only your address receives."}
                    </span>
                    {"\n"}
                    {"await "}
                    <span className={s.codeName}>claimPeriod</span>
                    {"(connection, anySigner, vault);"}
                  </code>
                </pre>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── 04 · Verification ────────────────────────────────────────── */}
        <section id="verify" className={s.section}>
          <div className={`${s.container} ${s.sectionGrid}`}>
            <div className={s.sectionLabel}>
              <p className={s.sectionIndex}>04 &middot; Verification</p>
              <h2 className={s.sectionTitle}>
                Do not take our word for it.
              </h2>
            </div>
            <div>
              <Reveal className={`${s.prose} ${s.reveal}`}>
                <p>
                  This project once wrote its marketing ahead of its software.
                  The rebrand is the correction, and it comes with a rule:{" "}
                  <strong>
                    nothing appears on this page that a stranger cannot check.
                  </strong>
                </p>
              </Reveal>
              <Reveal className={`${s.claims} ${s.reveal}`} delay={80}>
                <div className={s.claim}>
                  <p className={s.claimText}>
                    <span className={s.claimCheck} aria-hidden="true">
                      &#10003;
                    </span>
                    The shielded pool runs on devnet.
                  </p>
                  <p className={s.claimHow}>
                    Look up program <code>{POOL_PROGRAM_ID}</code> on any Solana
                    explorer, cluster devnet.
                  </p>
                </div>
                <div className={s.claim}>
                  <p className={s.claimText}>
                    <span className={s.claimCheck} aria-hidden="true">
                      &#10003;
                    </span>
                    Proofs are verified on-chain, not by a server you trust.
                  </p>
                  <p className={s.claimHow}>
                    Read the verifier program in the repository, then read the
                    logs of any shielded transaction on the explorer.
                  </p>
                </div>
                <div className={s.claim}>
                  <p className={s.claimText}>
                    <span className={s.claimCheck} aria-hidden="true">
                      &#10003;
                    </span>
                    The proof system contains no elliptic-curve cryptography.
                  </p>
                  <p className={s.claimHow}>
                    Grep the verifier source. You will find Poseidon, Merkle
                    paths and field arithmetic, and nothing with a curve in it.
                  </p>
                </div>
                <div className={s.claim}>
                  <p className={s.claimText}>
                    <span className={s.claimCheck} aria-hidden="true">
                      &#10003;
                    </span>
                    Stealth addresses use ML-KEM-768 as standardized.
                  </p>
                  <p className={s.claimHow}>
                    FIPS 203 is public. Compare its parameter sets against the
                    key encapsulation code in the repository.
                  </p>
                </div>
              </Reveal>
              <Reveal className={`${s.notClaimed} ${s.reveal}`} delay={120}>
                <p className={s.overline}>And in the other column</p>
                <p className={s.notClaimedTitle}>What we do not claim.</p>
                <ul className={s.notClaimedList}>
                  <li className={s.notClaimedItem}>
                    Audited. It is not, and this page will say so until it is.
                  </li>
                  <li className={s.notClaimedItem}>
                    Mainnet. Devnet only, on purpose, for now.
                  </li>
                  <li className={s.notClaimedItem}>
                    Performance figures. None appear here until the benchmark
                    can be published beside them.
                  </li>
                  <li className={s.notClaimedItem}>
                    Users, volume, value locked. A devnet has none worth
                    quoting.
                  </li>
                </ul>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── CTA ──────────────────────────────────────────────────────── */}
        <section className={s.cta}>
          <div className={s.container}>
            <p className={s.overline}>The invitation</p>
            <h2 className={s.ctaTitle}>
              Test it with money you can afford to lose.
            </h2>
            <p className={s.ctaNote}>
              That is the honest offer a devnet can make. Shield, pay, unshield,
              then read the programs that did it.
            </p>
            <div className={s.ctaActions}>
              <a className={s.btnPrimary} href="/pay">
                Open the devnet app
              </a>
              <a
                className={s.btnGhost}
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Read the source
              </a>
            </div>
            <p className={s.ctaOath}>
              Styx is the river the Greek gods swore by: the one oath they could
              not break. A commitment you cannot take back is the entire
              product.
            </p>
          </div>
        </section>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className={s.footer}>
        <div className={s.container}>
          <div className={s.footerGrid}>
            <div className={s.footerBrand}>
              <span className={s.wordmark}>
                <span className={s.wordmarkName}>Styx</span>
                <span className={s.wordmarkSuffix}>Protocol</span>
              </span>
              <p className={s.footerBrandLine}>
                Private payments on Solana. Shielded pool, hash-based STARK
                proofs, hybrid post-quantum stealth addresses. Formerly
                Protocol 01.
              </p>
            </div>
            <div>
              <p className={s.footerColTitle}>Protocol</p>
              <ul className={s.footerLinks}>
                <li>
                  <a className={s.footerLink} href="/pay">
                    Devnet app
                  </a>
                </li>
                <li>
                  <a
                    className={s.footerLink}
                    href={REPO_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Source repository
                  </a>
                </li>
                <li>
                  <a
                    className={s.footerLink}
                    href={EXPLORER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Pool program on explorer
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <p className={s.footerColTitle}>This page</p>
              <ul className={s.footerLinks}>
                <li>
                  <a className={s.footerLink} href="#problem">
                    The problem
                  </a>
                </li>
                <li>
                  <a className={s.footerLink} href="#mechanism">
                    How it works
                  </a>
                </li>
                <li>
                  <a className={s.footerLink} href="#sdk">
                    For merchants
                  </a>
                </li>
                <li>
                  <a className={s.footerLink} href="#verify">
                    Verification
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className={s.footerLegal}>
            <span>
              Devnet software. Not audited. Use funds you can afford to lose.
            </span>
            <span>&copy; 2026 Styx Protocol</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
