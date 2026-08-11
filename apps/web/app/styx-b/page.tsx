import type { Metadata } from "next";
import { Newsreader } from "next/font/google";
import RiverCanvas from "./_components/RiverCanvas";
import Reveal from "./_components/Reveal";
import styles from "./styx-b.module.css";
import { notFound } from "next/navigation";

// Editorial serif for display lines only; UI stays on Inter (already loaded
// by the root layout), code on JetBrains Mono.
const serif = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--styx-serif",
});

export const metadata: Metadata = {
  title: "Styx Protocol — Private payments on Solana",
  description:
    "A shielded payment pool on Solana: STARK proofs over Poseidon hashes and Merkle trees, hybrid X25519 + ML-KEM-768 stealth addresses, a merchant SDK, and on-chain subscriptions. Live on devnet. Not audited.",
};

const GITHUB_URL = "https://github.com/IsSlashy/Protocol-01";

function cx(...classes: (string | false | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

export default function StyxRiverPage() {
  /* Internal design-exploration route. These six pages exist to compare
     directions and to document the shared vocabulary; they are not part of the
     public site, so production answers 404 exactly as /void used to. Delete the
     guard, or the route, when a direction is settled. */
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  return (
    <div className={cx(styles.root, serif.variable)}>
      {/* ============================== header ============================== */}
      <header className={styles.header}>
        <div className={cx(styles.container, styles.headerInner)}>
          <a href="#top" className={styles.wordmarkGroup}>
            <span className={styles.wordmark}>Styx</span>
            <span className={styles.wordTag}>DEVNET</span>
          </a>
          <nav className={styles.nav} aria-label="Sections">
            <a href="#ledger" className={styles.navLink}>
              The ledger
            </a>
            <a href="#how" className={styles.navLink}>
              How it works
            </a>
            <a href="#oath" className={styles.navLink}>
              The oath
            </a>
            <a href="#merchants" className={styles.navLink}>
              Merchants
            </a>
          </nav>
          <a href="/pay" className={cx(styles.btnPrimary, styles.btnSmall)}>
            Open the app
          </a>
        </div>
      </header>

      {/* =============================== hero =============================== */}
      <section className={styles.hero} id="top">
        <RiverCanvas className={styles.riverCanvas} />
        <div className={styles.heroGlow} aria-hidden="true" />
        <div className={styles.heroShade} aria-hidden="true" />

        <div className={cx(styles.container, styles.heroContent)}>
          <p className={styles.heroOverline}>Styx Protocol · Shielded payments on Solana</p>
          <h1 className={styles.h1}>
            Payments that <em>hold their oath.</em>
          </h1>
          <p className={styles.heroSub}>
            In the old stories, an oath sworn on the Styx could not be broken. A
            cryptographic commitment is the same idea, kept by mathematics. Styx
            shields payments on Solana: deposits become private notes, and STARK
            proofs let you spend them without pointing at which note is yours.
          </p>

          <div className={styles.stateRow} aria-label="Current project status">
            <span className={styles.stateChip}>Live on devnet</span>
            <span className={styles.stateChip}>Open source</span>
            <span className={styles.stateChip}>Not yet audited</span>
          </div>

          <div className={cx(styles.btnRow, styles.heroCtas)}>
            <a href="/pay" className={styles.btnPrimary}>
              Try it on devnet
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.btnGhost}
            >
              Read the source
            </a>
          </div>
        </div>

        <div className={styles.cue} aria-hidden="true">
          <span>Follow the current</span>
          <span className={styles.cueLine} />
        </div>
      </section>

      {/* ========================== I. the ledger ========================== */}
      <section className={styles.section} id="ledger">
        <div className={styles.container}>
          <div className={styles.splitGrid}>
            <Reveal className={styles.reveal}>
              <p className={styles.kicker}>I · The ledger</p>
              <h2 className={styles.h2}>A public ledger forgets nothing.</h2>
              <p className={styles.lead}>
                Every transfer on Solana is public: sender, recipient, amount,
                time. Not for a while — forever, replicated on every node,
                indexed by anyone who cares to look.
              </p>
              <p className={styles.quietClose}>
                Privacy is not about hiding wrongdoing. It is about not
                broadcasting everything, to everyone, forever.
              </p>
            </Reveal>

            <Reveal className={styles.reveal} delay={120}>
              <div className={styles.factList}>
                <div className={styles.fact}>
                  <span className={styles.factIndex}>01</span>
                  <p className={styles.factBody}>
                    A salary paid on-chain publishes the salary.
                    <small>
                      One transfer, and the amount, the employer and the
                      employee&apos;s whole account history are linked in public.
                    </small>
                  </p>
                </div>
                <div className={styles.fact}>
                  <span className={styles.factIndex}>02</span>
                  <p className={styles.factBody}>
                    A treasury that moves publishes its strategy.
                    <small>
                      Positions, counterparties and timing are readable by
                      competitors before the ink is dry.
                    </small>
                  </p>
                </div>
                <div className={styles.fact}>
                  <span className={styles.factIndex}>03</span>
                  <p className={styles.factBody}>
                    A customer who pays you announces they are your customer.
                    <small>
                      Every checkout writes a permanent, public record of the
                      relationship.
                    </small>
                  </p>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <div className={styles.container}>
        <div className={styles.rule} aria-hidden="true" />
      </div>

      {/* ========================= II. the current ========================= */}
      <section className={styles.section} id="how">
        <div className={styles.container}>
          <Reveal className={styles.reveal}>
            <p className={styles.kicker}>II · The current</p>
            <h2 className={styles.h2}>How value moves through Styx.</h2>
            <p className={styles.lead}>
              One pool, three movements. The chain verifies every step; what it
              verifies is a proof, not your identity.
            </p>
          </Reveal>

          <div className={styles.steps}>
            <div className={styles.flowline} aria-hidden="true" />

            <Reveal className={cx(styles.reveal, styles.step)}>
              <p className={styles.stepNum}>01 — Shield</p>
              <h3 className={styles.stepTitle}>Your deposit becomes a note.</h3>
              <p className={styles.stepBody}>
                Deposit SOL into the shielded pool. It is recorded as a note: a
                Poseidon commitment in a Merkle tree that only you can open.
                From the outside, one more leaf in the tree.
              </p>
            </Reveal>

            <Reveal className={cx(styles.reveal, styles.step)} delay={80}>
              <p className={styles.stepNum}>02 — Flow</p>
              <h3 className={styles.stepTitle}>Proofs speak, notes stay silent.</h3>
              <p className={styles.stepBody}>
                To spend, you present a STARK proof that a note exists in the
                tree and has never been spent — without revealing which note it
                is. To receive, hybrid stealth addresses (X25519 + ML-KEM-768)
                derive a fresh one-time address for each payment.
              </p>
            </Reveal>

            <Reveal className={cx(styles.reveal, styles.step)} delay={160}>
              <p className={styles.stepNum}>03 — Unshield</p>
              <h3 className={styles.stepTitle}>Leave the river when you choose.</h3>
              <p className={styles.stepBody}>
                Withdraw to any Solana address by presenting a proof. The Styx
                verifier program checks it on-chain, in a single transaction,
                before a single lamport moves.
              </p>
            </Reveal>
          </div>

          <Reveal className={styles.reveal}>
            <p className={styles.honest}>
              Styx runs on Solana devnet and is under active development. It has
              not been audited, and the privacy it provides today has known
              limits we are still engineering away. Do not use it for value you
              cannot afford to lose.
            </p>
          </Reveal>
        </div>
      </section>

      <div className={styles.container}>
        <div className={styles.rule} aria-hidden="true" />
      </div>

      {/* =========================== III. the oath ========================== */}
      <section className={styles.section} id="oath">
        <div className={styles.container}>
          <Reveal className={styles.reveal}>
            <p className={styles.kicker}>III · The oath</p>
            <h2 className={styles.h2}>
              Post-quantum where we control it. Classical where the chain
              decides.
            </h2>
            <p className={styles.lead}>
              Marketing loves the words &ldquo;quantum-safe&rdquo;. Here is the
              exact, layer-by-layer truth instead.
            </p>
          </Reveal>

          <Reveal className={styles.reveal}>
            <div className={styles.oathTable}>
              <div className={cx(styles.oathRow, styles.oathHead)} aria-hidden="true">
                <span>Layer</span>
                <span>Primitive</span>
                <span>Standing</span>
              </div>

              <div className={styles.oathRow}>
                <p className={styles.oathLayer}>Proof system</p>
                <p className={styles.oathPrimitive}>
                  STARK over Poseidon hashes and Merkle trees
                </p>
                <p className={styles.oathStatus}>
                  <strong>Post-quantum by construction</strong>
                  No elliptic curves anywhere in the proof. Its security rests
                  on hash functions, which quantum computers only weaken, not
                  break.
                </p>
              </div>

              <div className={styles.oathRow}>
                <p className={styles.oathLayer}>Stealth encryption</p>
                <p className={styles.oathPrimitive}>
                  Hybrid X25519 + ML-KEM-768 (FIPS 203)
                </p>
                <p className={styles.oathStatus}>
                  <strong>Post-quantum key encapsulation</strong>
                  A NIST-standardised lattice KEM runs alongside the classical
                  curve; breaking the pair requires breaking both.
                </p>
              </div>

              <div className={styles.oathRow}>
                <p className={styles.oathLayer}>Transaction signature</p>
                <p className={styles.oathPrimitive}>Ed25519</p>
                <p className={cx(styles.oathStatus, styles.classical)}>
                  <strong>Classical — by the chain&apos;s rule</strong>
                  Solana verifies only Ed25519, so every transaction on the
                  chain signs this way. Ours included. We say so plainly.
                </p>
              </div>
            </div>
          </Reveal>

          <div className={styles.verifyGrid}>
            <Reveal className={cx(styles.reveal, styles.verifyCard)}>
              <p className={styles.verifyTitle}>The source is open.</p>
              <p className={styles.verifyBody}>
                The programs, the prover, the SDK and this site are public.
                Every claim on this page can be checked against the code.
              </p>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.verifyLink}
              >
                github.com/IsSlashy/Protocol-01
              </a>
            </Reveal>

            <Reveal className={cx(styles.reveal, styles.verifyCard)} delay={80}>
              <p className={styles.verifyTitle}>The verifier runs on devnet.</p>
              <p className={styles.verifyBody}>
                Every accepted proof is a public Solana transaction you can
                inspect in any explorer. Not a demo video — a program you can
                call.
              </p>
            </Reveal>

            <Reveal className={cx(styles.reveal, styles.verifyCard)} delay={160}>
              <p className={styles.verifyTitle}>No audit has happened yet.</p>
              <p className={styles.verifyBody}>
                Until an independent audit exists, treat Styx as research
                software. We will not imply otherwise anywhere on this site.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      <div className={styles.container}>
        <div className={styles.rule} aria-hidden="true" />
      </div>

      {/* ========================== IV. merchants ========================== */}
      <section className={styles.section} id="merchants">
        <div className={styles.container}>
          <div className={styles.merchantGrid}>
            <div>
              <Reveal className={styles.reveal}>
                <p className={styles.kicker}>IV · For merchants</p>
                <h2 className={styles.h2}>
                  Accept payment. Keep nobody&apos;s diary.
                </h2>
                <p className={styles.lead}>
                  A small TypeScript SDK for taking private payments: your
                  customer settles from the shielded pool, you receive a plain
                  Solana transfer. No gateway in the middle.
                </p>
              </Reveal>

              <Reveal className={styles.reveal} delay={100}>
                <div className={styles.merchantFeature}>
                  <p className={styles.merchantFeatureTitle}>Checkout</p>
                  <p className={styles.merchantFeatureBody}>
                    Request an amount against a reference; the buyer pays from
                    their shielded balance. You reconcile a normal transfer,
                    they keep their account history to themselves.
                  </p>
                </div>
                <div className={styles.merchantFeature}>
                  <p className={styles.merchantFeatureTitle}>
                    Subscriptions, on-chain
                  </p>
                  <p className={styles.merchantFeatureBody}>
                    Recurring payments live in a program, not a database. Each
                    period, the amount becomes claimable by the merchant — and
                    claiming is permissionless, so any keeper can trigger it
                    while funds can only ever reach you.
                  </p>
                </div>
              </Reveal>
            </div>

            <Reveal className={styles.reveal} delay={140}>
              <div className={styles.codePanel}>
                <div className={styles.codeHeader}>
                  <span>checkout.ts</span>
                  <span className={styles.codeDot} aria-hidden="true" />
                </div>
                <pre className={styles.code}>
                  <code>
                    <span className={styles.tokKw}>import</span>
                    {" { Checkout } "}
                    <span className={styles.tokKw}>from</span>{" "}
                    <span className={styles.tokStr}>&quot;@styx/merchant-sdk&quot;</span>
                    {";\n\n"}
                    <span className={styles.tokKw}>const</span>
                    {" checkout = "}
                    <span className={styles.tokKw}>new</span>
                    {" Checkout({ merchant: STORE_KEY });\n\n"}
                    <span className={styles.tokKw}>const</span>
                    {" intent = "}
                    <span className={styles.tokKw}>await</span>
                    {" checkout.request({\n"}
                    {"  amount: sol("}
                    <span className={styles.tokStr}>&quot;0.50&quot;</span>
                    {"),\n"}
                    {"  reference: "}
                    <span className={styles.tokStr}>&quot;order-1041&quot;</span>
                    {",\n"}
                    {"});\n\n"}
                    <span className={styles.tokComment}>
                      {"// The buyer settles from the shielded pool.\n"}
                    </span>
                    <span className={styles.tokComment}>
                      {"// You receive a native Solana transfer."}
                    </span>
                  </code>
                </pre>
              </div>
              <p className={styles.codeCaption}>
                Illustrative surface — the SDK runs against devnet today.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      <div className={styles.container}>
        <div className={styles.rule} aria-hidden="true" />
      </div>

      {/* ============================ V. cross ============================= */}
      <section className={cx(styles.section, styles.ctaSection)} id="cross">
        <div className={styles.container}>
          <Reveal className={styles.reveal}>
            <p className={styles.kicker} style={{ justifyContent: "center" }}>
              V · Cross
            </p>
            <p className={styles.ctaLine}>
              Cross when <em>you</em> are ready.
            </p>
            <p className={styles.ctaSub}>
              Styx runs on Solana devnet today. Try it with worthless tokens,
              read every line of code that moves them, and hold us to the oath.
            </p>
            <div className={cx(styles.btnRow, styles.ctaButtons)}>
              <a href="/pay" className={styles.btnPrimary}>
                Open the devnet app
              </a>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.btnGhost}
              >
                GitHub
              </a>
            </div>
            <p className={styles.ctaState}>Devnet · Open source · Not audited</p>
          </Reveal>
        </div>
      </section>

      {/* ============================== footer ============================= */}
      <footer className={styles.footer}>
        <div className={styles.container}>
          <div className={styles.footerGrid}>
            <div>
              <span className={styles.wordmark}>Styx</span>
              <p className={styles.footerBlurb}>
                Private payments on Solana. Named for the river the gods swore
                by — the one oath they could not break.
              </p>
            </div>
            <div>
              <p className={styles.footerHead}>Protocol</p>
              <ul className={styles.footerList}>
                <li>
                  <a href="#ledger" className={styles.footerLink}>
                    The ledger
                  </a>
                </li>
                <li>
                  <a href="#how" className={styles.footerLink}>
                    How it works
                  </a>
                </li>
                <li>
                  <a href="#oath" className={styles.footerLink}>
                    The oath
                  </a>
                </li>
                <li>
                  <a href="#merchants" className={styles.footerLink}>
                    Merchants
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <p className={styles.footerHead}>Resources</p>
              <ul className={styles.footerList}>
                <li>
                  <a
                    href={GITHUB_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.footerLink}
                  >
                    GitHub
                  </a>
                </li>
                <li>
                  <a href="/pay" className={styles.footerLink}>
                    Devnet app
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <p className={styles.footerBottom}>
            © 2026 Styx Protocol. Deployed on Solana devnet · not audited ·
            transaction signatures are Ed25519 because the chain verifies
            nothing else.
          </p>
        </div>
      </footer>
    </div>
  );
}
