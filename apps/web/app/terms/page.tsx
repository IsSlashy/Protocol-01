import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import StyxShell from "../_styx/StyxShell";

/* Server component on purpose: this page exports `metadata`, which a
   "use client" file cannot do. There are no t() calls here today and i18n has
   no `terms` namespace, so the page stays English-only and the shell's header
   and footer keep their own keys. Adding useT() would force "use client" and
   kill the export below. */

export const metadata: Metadata = {
  title: "Terms of Service | Styx Protocol",
  description:
    "Terms of Service for Styx Protocol, formerly Protocol 01: the conditions governing use of the devnet wallet, browser extension, SDK packages and on-chain programs.",
};

/**
 * One clause band: an oversized marginal numeral, a mono index that keeps the
 * clause number addressable, and the heading. The leading digit moved out of the
 * heading text into the numeral; no clause body cross-references a number, so
 * nothing breaks.
 */
function Clause({
  id,
  numeral,
  title,
  alt = false,
  children,
}: {
  id: string;
  numeral: string;
  title: string;
  alt?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={alt ? "styx-section styx-section-alt" : "styx-section"}
    >
      <div className="styx-container styx-section-grid">
        <div className="styx-section-label">
          <span className="styx-numeral" aria-hidden="true">
            {numeral}
          </span>
          <p className="styx-index">Clause {numeral}</p>
          <h2 className="styx-h2">{title}</h2>
        </div>
        <div>{children}</div>
      </div>
    </section>
  );
}

export default function TermsOfService() {
  return (
    <StyxShell>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="styx-container styx-hero">
        <p className="styx-overline">Styx Protocol &middot; Legal</p>
        <h1 className="styx-h1">Terms of Service</h1>
        <div className="styx-hero-rule" aria-hidden="true" />
        <div className="styx-hero-body">
          <p className="styx-lede">
            These Terms govern use of Styx Protocol, formerly Protocol 01: the
            wallet application, the browser extension, the SDK packages
            published to npm, and the programs deployed on Solana devnet.{" "}
            <strong>
              The software runs on devnet and has not been audited.
            </strong>
          </p>
          <div className="styx-stack">
            <p className="styx-mono">Last updated: August 11, 2026</p>
            <div className="styx-btn-row" style={{ alignItems: "center" }}>
              <span className="styx-chip">
                <span className="styx-dot" aria-hidden="true" />
                Devnet
              </span>
              <span className="styx-chip">Not audited</span>
            </div>
            <p className="styx-note">
              First published February 23, 2026. Revised on the date above:
              renamed from Protocol 01 to Styx Protocol, and in the same pass
              the clauses that described the software more generously than it
              behaves were corrected. Clauses 2, 4, 6.2, 7, 10 and 11 changed.
              This note is the record of that revision.
            </p>
          </div>
        </div>

        <div className="styx-admission" style={{ marginTop: "3rem" }}>
          <p className="styx-admission-title">Read this first</p>
          <p className="styx-admission-body">
            Styx Protocol is experimental software deployed on Solana devnet. It
            has not been audited, there is no mainnet deployment, and a
            transaction confirmed on Solana cannot be reversed by us or by
            anyone else. You hold your own keys, which means nobody can restore
            them for you.
          </p>
        </div>

        <div
          className="styx-gleam-rule"
          aria-hidden="true"
          style={{ marginTop: "3.5rem" }}
        />
      </section>

      {/* ── 1 ────────────────────────────────────────────────────────────── */}
      <Clause id="clause-01" numeral="01" title="Acceptance of Terms">
        <div className="styx-prose">
          <p>
            By accessing or using Styx Protocol (&quot;Styx&quot;, formerly
            Protocol 01), including the mobile application, browser extension,
            SDK packages, smart contracts, and any related services
            (collectively, the &quot;Services&quot;), you agree to be bound by
            these Terms of Service (&quot;Terms&quot;). If you do not agree to
            these Terms, do not use the Services.
          </p>
          <p>
            These Terms constitute a legally binding agreement between you and
            the Styx Protocol team (&quot;we&quot;, &quot;us&quot;, or
            &quot;our&quot;).
          </p>
        </div>
      </Clause>

      {/* ── 2 ────────────────────────────────────────────────────────────── */}
      <Clause id="clause-02" numeral="02" title="Description of Services" alt>
        <div className="styx-prose">
          <p>
            Styx Protocol is a non-custodial Solana wallet and privacy protocol.
            Everything listed below is deployed on Solana devnet only. The
            Services provide:
          </p>
        </div>
        <ul className="styx-steps">
          <li className="styx-step">
            <span className="styx-step-index">01</span>
            <p className="styx-step-body">
              Non-custodial wallet creation and management on Solana.
            </p>
          </li>
          <li className="styx-step">
            <span className="styx-step-index">02</span>
            <p className="styx-step-body">
              Shielded transfers through one shielded pool on Solana devnet.
              Movements are authorized by hash-based STARK proofs built from
              Poseidon hashes and Merkle trees, with no elliptic curves in the
              proof. Recipients can be paid at one-time stealth addresses sealed
              with hybrid X25519 and ML-KEM-768 key encapsulation, the lattice
              half standardized in FIPS 203. Transaction signatures are Ed25519
              and remain classical.
            </p>
          </li>
          <li className="styx-step">
            <span className="styx-step-index">03</span>
            <p className="styx-step-body">
              Token transfers, swaps, payment streams, and subscriptions. These
              run on devnet, and any individual feature may be incomplete,
              disabled, or withdrawn.
            </p>
          </li>
          <li className="styx-step">
            <span className="styx-step-index">04</span>
            <p className="styx-step-body">
              An AI assistant that presents market data for analysis and
              portfolio review. It is informational only.
            </p>
          </li>
          <li className="styx-step">
            <span className="styx-step-index">05</span>
            <p className="styx-step-body">
              SDK packages for developers to integrate Styx privacy features
              into their applications, published to npm under the @protocol-01
              scope.
            </p>
          </li>
        </ul>
        <p className="styx-note" style={{ marginTop: "1.5rem" }}>
          This clause describes the Services. It is not a warranty that a
          feature exists, works, or keeps working; Clause 7 governs that.
        </p>
      </Clause>

      {/* ── 3 ────────────────────────────────────────────────────────────── */}
      <Clause id="clause-03" numeral="03" title="Eligibility">
        <div className="styx-prose">
          <p>
            You must be at least 18 years old (or the age of majority in your
            jurisdiction) to use the Services. By using the Services, you
            represent and warrant that you meet this requirement and that you
            are not subject to sanctions or located in a jurisdiction where use
            of cryptocurrency services is prohibited.
          </p>
        </div>
      </Clause>

      {/* ── 4 ────────────────────────────────────────────────────────────── */}
      <Clause id="clause-04" numeral="04" title="Non-Custodial Nature" alt>
        <div className="styx-prose" style={{ marginBottom: "2rem" }}>
          <p>
            Styx Protocol is a <strong>non-custodial</strong> service. This
            means:
          </p>
        </div>
        {/* Static on purpose, no styx-reveal: the reveal classes start at
            opacity 0 and only clear once the client observer runs, which would
            hide these custody terms whenever JavaScript does not. */}
        <div className="styx-grid styx-grid-3">
          <div className="styx-card">
            <p className="styx-card-value">You control your keys.</p>
            <p className="styx-card-note">
              Your private keys and seed phrases are generated and stored
              exclusively on your device. We never have access to them.
            </p>
          </div>
          <div className="styx-card">
            <p className="styx-card-value">
              You are responsible for security.
            </p>
            <p className="styx-card-note">
              If you lose your seed phrase, we cannot recover your wallet or
              your funds. There is no password reset and no account recovery of
              any kind: every wallet is generated locally, and we hold nothing
              that could restore one.
            </p>
          </div>
          <div className="styx-card">
            <p className="styx-card-value">Transactions are irreversible.</p>
            <p className="styx-card-note">
              Once a transaction is confirmed on the Solana blockchain, it
              cannot be reversed, cancelled, or refunded by us.
            </p>
          </div>
        </div>
      </Clause>

      {/* ── 5 ────────────────────────────────────────────────────────────── */}
      <Clause id="clause-05" numeral="05" title="Acceptable Use">
        <div className="styx-prose">
          <p>
            You agree to use the Services only for lawful purposes. You shall
            not:
          </p>
        </div>
        <ul className="styx-steps">
          <li className="styx-step">
            <span className="styx-step-index">01</span>
            <p className="styx-step-body">
              Use the Services to launder money, finance terrorism, or engage in
              any activity that violates applicable laws or regulations.
            </p>
          </li>
          <li className="styx-step">
            <span className="styx-step-index">02</span>
            <p className="styx-step-body">
              Attempt to exploit, reverse-engineer, or compromise the security
              of the smart contracts, relayer, or any component of the protocol
              outside of authorized security research.
            </p>
          </li>
          <li className="styx-step">
            <span className="styx-step-index">03</span>
            <p className="styx-step-body">
              Use the Services to harass, defraud, or harm other users.
            </p>
          </li>
          <li className="styx-step">
            <span className="styx-step-index">04</span>
            <p className="styx-step-body">
              Misrepresent your identity or affiliation with Styx Protocol.
            </p>
          </li>
          <li className="styx-step">
            <span className="styx-step-index">05</span>
            <p className="styx-step-body">
              Use automated systems (bots, scrapers) to interact with the
              Services in a manner that degrades performance for other users.
            </p>
          </li>
        </ul>
      </Clause>

      {/* ── 6 ────────────────────────────────────────────────────────────── */}
      <Clause id="clause-06" numeral="06" title="Intellectual Property" alt>
        <div className="styx-prose">
          <h3 className="styx-h3">6.1 Styx Protocol Rights</h3>
          <p>
            All intellectual property rights in the Services, including but not
            limited to the source code, smart contracts, zero-knowledge
            circuits, SDK, user interface designs, branding, trademarks, and
            documentation, are owned by or licensed to the Styx Protocol team.
          </p>

          <h3 className="styx-h3" style={{ marginTop: "2.25rem" }}>
            6.2 Current Open-Source License
          </h3>
          <p>
            Styx Protocol is released under the <strong>MIT License</strong>.
            You may use, copy, modify, merge, publish, distribute, sublicense,
            and sell copies of the software, subject to the license&apos;s
            copyright and permission notice.
          </p>
          <p>
            The SDK packages are published to npm under the @protocol-01 scope,
            and the MIT grant stated above is the grant that covers them. Where
            a published package omits a license field in its metadata, that
            omission is a packaging defect and not a license withheld: the MIT
            terms stated in this clause govern that package too.
          </p>

          <h3 className="styx-h3" style={{ marginTop: "2.25rem" }}>
            6.3 License Transition
          </h3>
          <p>
            We reserve the right to change the licensing terms of future
            releases. Code already released under the MIT License keeps the
            rights that license grants (an MIT grant on distributed code is not
            revocable), but no particular license is guaranteed for versions not
            yet published.
          </p>

          <h3 className="styx-h3" style={{ marginTop: "2.25rem" }}>
            6.4 User Content
          </h3>
          <p>
            You retain all rights to any content you create or transmit through
            the Services (e.g., transaction data, messages). We do not claim
            ownership of your on-chain data.
          </p>
        </div>
      </Clause>

      {/* ── 7 ────────────────────────────────────────────────────────────── */}
      <Clause id="clause-07" numeral="07" title="Disclaimers">
        <div className="styx-panel" style={{ marginBottom: "2rem" }}>
          <div className="styx-panel-body styx-stack">
            <p className="styx-mono">
              THE SERVICES ARE PROVIDED &quot;AS IS&quot; AND &quot;AS
              AVAILABLE&quot; WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR
              IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF
              MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
              NON-INFRINGEMENT.
            </p>
            <p className="styx-mono">
              WE DO NOT WARRANT THAT THE SERVICES WILL BE UNINTERRUPTED,
              ERROR-FREE, SECURE, OR FREE FROM VIRUSES OR OTHER HARMFUL
              COMPONENTS. YOU USE THE SERVICES AT YOUR OWN RISK.
            </p>
          </div>
        </div>

        {/* Static for the same reason as Clause 4: a disclaimer that renders
            invisible without JavaScript is a disclaimer that was not given. */}
        <div className="styx-grid styx-grid-3">
          <div className="styx-card">
            <p className="styx-card-value">No financial advice.</p>
            <p className="styx-card-note">
              Nothing in the Services constitutes financial, investment, legal,
              or tax advice. The AI assistant provides market data for
              informational purposes only.
            </p>
          </div>
          <div className="styx-card">
            <p className="styx-card-value">Blockchain risks.</p>
            <p className="styx-card-note">
              Cryptocurrency and DeFi protocols carry inherent risks including
              but not limited to smart contract vulnerabilities, network
              congestion, validator downtime, and market volatility. The
              programs behind the Services have not been audited.
            </p>
          </div>
          <div className="styx-card">
            <p className="styx-card-value">Privacy limitations.</p>
            <p className="styx-card-note">
              Styx uses hash-based STARK proofs and stealth addresses. Neither
              makes you anonymous. In the build deployed to devnet today, a
              withdrawal republishes the commitment recorded by its deposit, so a
              deposit and the withdrawal that spends it can be linked by anyone
              reading the chain, and the pool holds too few participants to hide
              a payment in a crowd. On-chain metadata, amounts, transaction
              timing, and future advances in cryptanalysis reduce what is
              concealed further. Do not rely on the Services to keep an activity
              secret.
            </p>
          </div>
        </div>
      </Clause>

      {/* ── 8 ────────────────────────────────────────────────────────────── */}
      <Clause id="clause-08" numeral="08" title="Limitation of Liability" alt>
        <div className="styx-prose">
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL
            THE STYX PROTOCOL TEAM, ITS CONTRIBUTORS, OR AFFILIATES BE LIABLE
            FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
            DAMAGES, INCLUDING BUT NOT LIMITED TO:
          </p>
        </div>
        <ul className="styx-steps">
          <li className="styx-step">
            <span className="styx-step-index">01</span>
            <p className="styx-step-body">
              Loss of funds due to smart contract vulnerabilities.
            </p>
          </li>
          <li className="styx-step">
            <span className="styx-step-index">02</span>
            <p className="styx-step-body">
              Loss of access to your wallet due to lost seed phrases.
            </p>
          </li>
          <li className="styx-step">
            <span className="styx-step-index">03</span>
            <p className="styx-step-body">
              Unauthorized access to your device or wallet.
            </p>
          </li>
          <li className="styx-step">
            <span className="styx-step-index">04</span>
            <p className="styx-step-body">
              Losses arising from blockchain network issues.
            </p>
          </li>
          <li className="styx-step">
            <span className="styx-step-index">05</span>
            <p className="styx-step-body">
              Losses arising from reliance on information provided by the AI
              assistant.
            </p>
          </li>
          <li className="styx-step">
            <span className="styx-step-index">06</span>
            <p className="styx-step-body">
              Any damages arising from third-party service failures.
            </p>
          </li>
        </ul>
      </Clause>

      {/* ── 9 ────────────────────────────────────────────────────────────── */}
      <Clause id="clause-09" numeral="09" title="Indemnification">
        <div className="styx-prose">
          <p>
            You agree to indemnify, defend, and hold harmless the Styx Protocol
            team and its contributors from any claims, losses, damages,
            liabilities, and expenses (including reasonable legal fees) arising
            from your use of the Services, your violation of these Terms, or
            your violation of any applicable law.
          </p>
        </div>
      </Clause>

      {/* ── 10 ───────────────────────────────────────────────────────────── */}
      <Clause id="clause-10" numeral="10" title="Modifications" alt>
        <div className="styx-prose">
          <p>
            We reserve the right to modify these Terms at any time. Material
            changes will be communicated through the application or on this site
            with at least 14 days&apos; notice. Your continued use of the
            Services after the effective date of any changes constitutes
            acceptance of the revised Terms.
          </p>
          <p>
            The record of a change lives at the top of this page: the &quot;Last
            updated&quot; date states when this document last changed, and the
            note beside it states which clauses changed. The August 2026
            revision recorded there corrected how this document described the
            software, and it was published without 14 days&apos; advance notice.
          </p>
        </div>
      </Clause>

      {/* ── 11 ───────────────────────────────────────────────────────────── */}
      <Clause id="clause-11" numeral="11" title="Termination">
        <div className="styx-prose">
          <p>
            You may stop using the Services at any time by uninstalling the
            application and ceasing all use. We may restrict access to certain
            features or services at our discretion.
          </p>
          <p>
            Because Styx Protocol is non-custodial, your seed phrase keeps
            control of unshielded SOL and SPL token balances held at your own
            addresses, and those balances remain reachable through any
            compatible Solana wallet. Value inside the shielded pool is
            different. Spending a pool note requires the note records the Styx
            client keeps on your device as well as your seed phrase, and a note
            another user sent you exists only in that local store.{" "}
            <strong>
              No third-party Solana wallet can spend a pool note, and losing the
              local store can mean losing access to shielded value even when the
              seed phrase survives.
            </strong>{" "}
            Withdraw anything you need to keep portable before you stop using
            the Services.
          </p>
        </div>
      </Clause>

      {/* ── 12 ───────────────────────────────────────────────────────────── */}
      <Clause id="clause-12" numeral="12" title="Governing Law" alt>
        <div className="styx-prose">
          <p>
            These Terms shall be governed by and construed in accordance with
            the laws of France, without regard to its conflict of law
            provisions. Any disputes arising under these Terms shall be resolved
            in the courts of Paris, France.
          </p>
        </div>
      </Clause>

      {/* ── 13 ───────────────────────────────────────────────────────────── */}
      <Clause id="clause-13" numeral="13" title="Contact">
        <div className="styx-prose" style={{ marginBottom: "2rem" }}>
          <p>For questions about these Terms, contact us at:</p>
        </div>
        <div className="styx-panel">
          <div className="styx-panel-body">
            <div className="styx-row">
              <span className="styx-row-key">email</span>
              <span className="styx-row-leader" />
              <span className="styx-row-value">
                <a href="mailto:legal@protocol-01.com" className="styx-link">
                  legal@protocol-01.com
                </a>
              </span>
            </div>
          </div>
        </div>

        <div className="styx-btn-row" style={{ marginTop: "3rem" }}>
          <Link href="/privacy" className="styx-btn-ghost">
            Privacy Policy
          </Link>
          <Link href="/licenses" className="styx-btn-ghost">
            Open Source Licenses
          </Link>
          <Link href="/" className="styx-btn-ghost">
            Home
          </Link>
        </div>
      </Clause>
    </StyxShell>
  );
}
