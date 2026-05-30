import type { Metadata } from "next";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Terms of Service | PROTOCOL-01",
  description:
    "Terms of Service for Protocol 01 — conditions governing use of our privacy-first Solana wallet and protocol.",
};

export default function TermsOfService() {
  return (
    <div className="min-h-screen bg-p01-void">
      <SiteHeader />

      {/* Content */}
      <article className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-24">
        <header className="mb-16 text-center">
          <div className="inline-block px-4 py-1.5 rounded-full bg-p01-cyan/10 border border-p01-cyan/20 mb-6">
            <span className="text-p01-cyan text-xs font-mono tracking-widest uppercase">
              Legal
            </span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-display font-bold text-white mb-4">
            Terms of Service
          </h1>
          <p className="text-p01-text-muted text-lg">
            Last updated: February 23, 2026
          </p>
        </header>

        <div className="prose prose-invert max-w-none space-y-10 text-p01-text-muted leading-relaxed">
          {/* 1 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              1. Acceptance of Terms
            </h2>
            <p>
              By accessing or using Protocol 01 (&quot;P-01&quot;), including the mobile
              application, browser extension, SDK packages, smart contracts, and
              any related services (collectively, the &quot;Services&quot;), you agree to
              be bound by these Terms of Service (&quot;Terms&quot;). If you do not agree
              to these Terms, do not use the Services.
            </p>
            <p>
              These Terms constitute a legally binding agreement between you and
              the Protocol 01 team (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;).
            </p>
          </section>

          {/* 2 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              2. Description of Services
            </h2>
            <p>
              Protocol 01 is a privacy-focused Solana wallet and protocol that
              provides:
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>Non-custodial wallet creation and management on Solana.</li>
              <li>
                Privacy-preserving transactions using zero-knowledge proofs,
                shielded pools, and stealth addresses.
              </li>
              <li>Token transfers, swaps, payment streams, and subscriptions.</li>
              <li>
                An AI-powered assistant for market analysis and portfolio
                management.
              </li>
              <li>
                SDK packages for developers to integrate Protocol 01 privacy
                features into their applications.
              </li>
            </ul>
          </section>

          {/* 3 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              3. Eligibility
            </h2>
            <p>
              You must be at least 18 years old (or the age of majority in your
              jurisdiction) to use the Services. By using the Services, you
              represent and warrant that you meet this requirement and that you
              are not subject to sanctions or located in a jurisdiction where
              use of cryptocurrency services is prohibited.
            </p>
          </section>

          {/* 4 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              4. Non-Custodial Nature
            </h2>
            <p>
              Protocol 01 is a <strong className="text-white">non-custodial</strong>{" "}
              service. This means:
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>
                <strong className="text-white">You control your keys.</strong>{" "}
                Your private keys and seed phrases are generated and stored
                exclusively on your device. We never have access to them.
              </li>
              <li>
                <strong className="text-white">You are responsible for security.</strong>{" "}
                If you lose your seed phrase, we cannot recover your wallet or
                funds. There is no &quot;forgot password&quot; mechanism for
                locally-generated wallets.
              </li>
              <li>
                <strong className="text-white">Transactions are irreversible.</strong>{" "}
                Once a transaction is confirmed on the Solana blockchain, it
                cannot be reversed, cancelled, or refunded by us.
              </li>
            </ul>
          </section>

          {/* 5 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              5. Acceptable Use
            </h2>
            <p>You agree to use the Services only for lawful purposes. You shall not:</p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>
                Use the Services to launder money, finance terrorism, or engage
                in any activity that violates applicable laws or regulations.
              </li>
              <li>
                Attempt to exploit, reverse-engineer, or compromise the security
                of the smart contracts, relayer, or any component of the
                protocol outside of authorized security research.
              </li>
              <li>
                Use the Services to harass, defraud, or harm other users.
              </li>
              <li>
                Misrepresent your identity or affiliation with Protocol 01.
              </li>
              <li>
                Use automated systems (bots, scrapers) to interact with the
                Services in a manner that degrades performance for other users.
              </li>
            </ul>
          </section>

          {/* 6 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              6. Intellectual Property
            </h2>
            <h3 className="text-lg font-semibold text-white mt-6 mb-2">
              6.1 Protocol 01 Rights
            </h3>
            <p>
              All intellectual property rights in the Services — including but
              not limited to the source code, smart contracts, zero-knowledge
              circuits, SDK, user interface designs, branding, trademarks, and
              documentation — are owned by or licensed to the Protocol 01 team.
            </p>
            <h3 className="text-lg font-semibold text-white mt-6 mb-2">
              6.2 Current Open-Source License
            </h3>
            <p>
              Portions of Protocol 01 are currently available under the{" "}
              <strong className="text-white">
                Business Source License 1.1 (BSL-1.1)
              </strong>
              . This license permits viewing, forking, and non-commercial use of
              the source code. Commercial use, redistribution for production
              purposes, and derivative works intended for competing products
              require explicit written permission from the Protocol 01 team.
            </p>
            <h3 className="text-lg font-semibold text-white mt-6 mb-2">
              6.3 License Transition
            </h3>
            <p>
              We reserve the right to change the licensing terms of the protocol
              at any time, including transitioning to a closed-source or
              proprietary license. Existing grants made under previous license
              versions will be honored according to their terms, but no future
              rights are guaranteed.
            </p>
            <h3 className="text-lg font-semibold text-white mt-6 mb-2">
              6.4 User Content
            </h3>
            <p>
              You retain all rights to any content you create or transmit
              through the Services (e.g., transaction data, messages). We do
              not claim ownership of your on-chain data.
            </p>
          </section>

          {/* 7 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              7. Disclaimers
            </h2>
            <div className="bg-p01-surface rounded-xl p-6 border border-p01-border">
              <p className="text-sm">
                THE SERVICES ARE PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT
                WARRANTIES OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING BUT
                NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
                PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
              </p>
              <p className="text-sm mt-4">
                WE DO NOT WARRANT THAT THE SERVICES WILL BE UNINTERRUPTED,
                ERROR-FREE, SECURE, OR FREE FROM VIRUSES OR OTHER HARMFUL
                COMPONENTS. YOU USE THE SERVICES AT YOUR OWN RISK.
              </p>
            </div>
            <ul className="list-disc pl-6 space-y-2 mt-6">
              <li>
                <strong className="text-white">No financial advice.</strong>{" "}
                Nothing in the Services constitutes financial, investment, legal,
                or tax advice. The AI assistant provides market data for
                informational purposes only.
              </li>
              <li>
                <strong className="text-white">Blockchain risks.</strong>{" "}
                Cryptocurrency and DeFi protocols carry inherent risks including
                but not limited to smart contract vulnerabilities, network
                congestion, validator downtime, and market volatility.
              </li>
              <li>
                <strong className="text-white">Privacy limitations.</strong>{" "}
                While we employ state-of-the-art cryptographic privacy
                techniques, no system can guarantee absolute anonymity.
                On-chain metadata, timing analysis, and future advances in
                cryptanalysis may reduce privacy guarantees.
              </li>
            </ul>
          </section>

          {/* 8 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              8. Limitation of Liability
            </h2>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT
              SHALL THE PROTOCOL 01 TEAM, ITS CONTRIBUTORS, OR AFFILIATES BE
              LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR
              PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO:
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>Loss of funds due to smart contract vulnerabilities.</li>
              <li>Loss of access to your wallet due to lost seed phrases.</li>
              <li>Unauthorized access to your device or wallet.</li>
              <li>Losses arising from blockchain network issues.</li>
              <li>
                Losses arising from reliance on information provided by the AI
                assistant.
              </li>
              <li>Any damages arising from third-party service failures.</li>
            </ul>
          </section>

          {/* 9 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              9. Indemnification
            </h2>
            <p>
              You agree to indemnify, defend, and hold harmless the Protocol 01
              team and its contributors from any claims, losses, damages,
              liabilities, and expenses (including reasonable legal fees)
              arising from your use of the Services, your violation of these
              Terms, or your violation of any applicable law.
            </p>
          </section>

          {/* 10 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              10. Modifications
            </h2>
            <p>
              We reserve the right to modify these Terms at any time. Material
              changes will be communicated through the application or on our
              website with at least 14 days&apos; notice. Your continued use of the
              Services after the effective date of any changes constitutes
              acceptance of the revised Terms.
            </p>
          </section>

          {/* 11 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              11. Termination
            </h2>
            <p>
              You may stop using the Services at any time by uninstalling the
              application and ceasing all use. We may restrict access to certain
              features or services at our discretion. Because Protocol 01 is
              non-custodial, you will always retain access to your funds via
              your seed phrase through any compatible Solana wallet.
            </p>
          </section>

          {/* 12 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              12. Governing Law
            </h2>
            <p>
              These Terms shall be governed by and construed in accordance with
              the laws of France, without regard to its conflict of law
              provisions. Any disputes arising under these Terms shall be
              resolved in the courts of Paris, France.
            </p>
          </section>

          {/* 13 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              13. Contact
            </h2>
            <p>
              For questions about these Terms, contact us at:{" "}
              <a
                href="mailto:legal@protocol-01.com"
                className="text-p01-cyan hover:underline"
              >
                legal@protocol-01.com
              </a>
            </p>
          </section>
        </div>

        {/* Footer links */}
        <div className="mt-16 pt-8 border-t border-p01-border flex flex-wrap gap-6 justify-center text-sm text-p01-text-muted">
          <Link href="/privacy" className="hover:text-white transition-colors">
            Privacy Policy
          </Link>
          <Link href="/licenses" className="hover:text-white transition-colors">
            Open Source Licenses
          </Link>
          <Link href="/" className="hover:text-white transition-colors">
            Home
          </Link>
        </div>
      </article>

      <Footer />
    </div>
  );
}
