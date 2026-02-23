import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy | PROTOCOL-01",
  description:
    "Privacy Policy for Protocol 01 — how we handle your data with zero-knowledge principles.",
};

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-p01-void">
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-p01-void/80 backdrop-blur-lg border-b border-p01-border">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link href="/" className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center">
                <span className="text-p01-cyan font-mono font-bold text-xs">
                  P01
                </span>
              </div>
              <span className="text-lg font-bold font-display text-white tracking-wider">
                PROTOCOL 01
              </span>
            </Link>
            <Link
              href="/"
              className="text-sm text-p01-text-muted hover:text-white transition-colors"
            >
              Back to Home
            </Link>
          </div>
        </div>
      </nav>

      {/* Content */}
      <article className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-24">
        <header className="mb-16 text-center">
          <div className="inline-block px-4 py-1.5 rounded-full bg-p01-cyan/10 border border-p01-cyan/20 mb-6">
            <span className="text-p01-cyan text-xs font-mono tracking-widest uppercase">
              Legal
            </span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-display font-bold text-white mb-4">
            Privacy Policy
          </h1>
          <p className="text-p01-text-muted text-lg">
            Last updated: February 23, 2026
          </p>
        </header>

        <div className="prose prose-invert max-w-none space-y-10 text-p01-text-muted leading-relaxed">
          {/* 1 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              1. Our Commitment to Privacy
            </h2>
            <p>
              Protocol 01 (&quot;P-01&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) is a privacy-first
              Solana wallet and protocol. Privacy is not a feature we added — it
              is the foundation upon which every component of Protocol 01 is
              built. This Privacy Policy explains what data we collect, what we
              do not collect, and how we protect your information.
            </p>
            <p>
              By using our mobile application, browser extension, SDK, or any
              Protocol 01 service (collectively, the &quot;Services&quot;), you agree to
              the practices described in this policy.
            </p>
          </section>

          {/* 2 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              2. Information We Do NOT Collect
            </h2>
            <p>
              We have designed Protocol 01 to minimize data collection. We do
              <strong className="text-white"> not</strong> collect, store, or
              have access to:
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>
                <strong className="text-white">Private keys or seed phrases</strong> —
                your wallet keys are generated and encrypted locally on your
                device. We never transmit or store them on any server.
              </li>
              <li>
                <strong className="text-white">Transaction history</strong> — we
                do not maintain logs of your transactions. On-chain data is
                publicly available on the Solana blockchain, but we do not
                aggregate, index, or link it to your identity.
              </li>
              <li>
                <strong className="text-white">Personal identity information</strong> —
                we do not require your name, email address, phone number, or any
                government-issued identification to use the wallet.
              </li>
              <li>
                <strong className="text-white">IP addresses or geolocation</strong> —
                Protocol 01 does not log IP addresses or track your physical
                location.
              </li>
              <li>
                <strong className="text-white">Browsing activity</strong> — our
                browser extension does not monitor, record, or transmit your
                browsing history.
              </li>
            </ul>
          </section>

          {/* 3 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              3. Information We Collect
            </h2>
            <h3 className="text-lg font-semibold text-white mt-6 mb-2">
              3.1 Authentication Data (Optional)
            </h3>
            <p>
              If you choose to authenticate via Privy (Google, Apple, email, or
              SMS), Privy Inc. processes your authentication credentials. We
              receive a pseudonymous user identifier and, if applicable, an
              embedded wallet address. We do not receive or store your OAuth
              tokens, passwords, or full email/phone number.
            </p>
            <h3 className="text-lg font-semibold text-white mt-6 mb-2">
              3.2 On-Chain Data
            </h3>
            <p>
              When you perform transactions, they are recorded on the Solana
              blockchain. While Protocol 01 employs zero-knowledge proofs,
              shielded pools, stealth addresses, and decoy mechanisms to obscure
              transaction details, certain metadata (e.g., transaction
              signatures, timestamps) is inherently public on the blockchain.
            </p>
            <h3 className="text-lg font-semibold text-white mt-6 mb-2">
              3.3 Relayer Data
            </h3>
            <p>
              Our relayer service processes shielded transactions and
              zero-knowledge proofs. The relayer temporarily handles proof data
              required to submit transactions on-chain. This data is:
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>Processed in memory only — never persisted to disk or database.</li>
              <li>Discarded immediately after the transaction is confirmed.</li>
              <li>
                Not linked to any personal identifier — the relayer processes
                cryptographic proofs, not identity data.
              </li>
            </ul>
            <h3 className="text-lg font-semibold text-white mt-6 mb-2">
              3.4 Crash Reports &amp; Diagnostics (Optional)
            </h3>
            <p>
              If you opt in to crash reporting, anonymized diagnostic data may
              be sent to help us improve the application. This data does not
              include wallet addresses, balances, transaction details, or any
              personally identifiable information.
            </p>
          </section>

          {/* 4 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              4. Zero-Knowledge Privacy Architecture
            </h2>
            <p>
              Protocol 01 uses advanced cryptographic techniques to protect your
              financial privacy:
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>
                <strong className="text-white">Shielded Pools</strong> — funds
                are deposited into on-chain pools using Groth16 zero-knowledge
                proofs. The link between depositor and withdrawer is
                cryptographically broken.
              </li>
              <li>
                <strong className="text-white">Stealth Addresses</strong> —
                recipients can generate one-time addresses, preventing observers
                from linking payments to a single wallet.
              </li>
              <li>
                <strong className="text-white">Merkle Tree Commitments</strong> —
                deposits are stored as hashed commitments in an on-chain Merkle
                tree, making it computationally infeasible to determine which
                commitment belongs to which user.
              </li>
              <li>
                <strong className="text-white">Client-Side Proof Generation</strong> —
                zero-knowledge proofs are generated on your device or via our
                Rust-native prover service. In both cases, your secret data
                (nullifiers, note secrets) never leaves your control unencrypted.
              </li>
            </ul>
          </section>

          {/* 5 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              5. Third-Party Services
            </h2>
            <p>Protocol 01 integrates with the following third-party services:</p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>
                <strong className="text-white">Privy</strong> — authentication
                provider. Subject to{" "}
                <a
                  href="https://privy.io/privacy"
                  className="text-p01-cyan hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Privy&apos;s Privacy Policy
                </a>
                .
              </li>
              <li>
                <strong className="text-white">Helius / Solana RPC Providers</strong> —
                blockchain data access. RPC requests contain your wallet address
                when querying balances or submitting transactions.
              </li>
              <li>
                <strong className="text-white">Jupiter</strong> — token price
                data and swap aggregation. Price queries do not include personal
                data.
              </li>
            </ul>
            <p className="mt-4">
              We encourage you to review the privacy policies of these
              third-party services.
            </p>
          </section>

          {/* 6 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              6. Data Storage &amp; Security
            </h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>
                All sensitive data (private keys, seed phrases) is encrypted
                using device-level secure storage (Android Keystore / iOS
                Keychain) and never transmitted externally.
              </li>
              <li>
                Cached data (balances, transaction history) is stored locally on
                your device and can be cleared at any time.
              </li>
              <li>
                We do not operate user databases. There are no accounts to
                breach because we do not store account data.
              </li>
            </ul>
          </section>

          {/* 7 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              7. Your Rights
            </h2>
            <p>Because we collect minimal data, your rights are straightforward:</p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>
                <strong className="text-white">Right to deletion</strong> —
                uninstalling the application removes all locally stored data. If
                you authenticated via Privy, you may request account deletion
                through Privy&apos;s interface.
              </li>
              <li>
                <strong className="text-white">Right to portability</strong> —
                you can export your seed phrase at any time and import it into
                any compatible Solana wallet.
              </li>
              <li>
                <strong className="text-white">Right to transparency</strong> —
                our smart contract source code is publicly verifiable on-chain
                and on GitHub during the open-source phase of the project.
              </li>
            </ul>
          </section>

          {/* 8 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              8. Children&apos;s Privacy
            </h2>
            <p>
              Protocol 01 is not directed at individuals under the age of 18. We
              do not knowingly collect data from minors. If you believe a minor
              has used our Services, please contact us so we can take
              appropriate action.
            </p>
          </section>

          {/* 9 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              9. Changes to This Policy
            </h2>
            <p>
              We may update this Privacy Policy from time to time. Material
              changes will be communicated through the application or on our
              website. Continued use of the Services after changes constitutes
              acceptance of the revised policy.
            </p>
          </section>

          {/* 10 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              10. Contact
            </h2>
            <p>
              For privacy-related inquiries, contact us at:{" "}
              <a
                href="mailto:privacy@protocol-01.com"
                className="text-p01-cyan hover:underline"
              >
                privacy@protocol-01.com
              </a>
            </p>
            <p className="mt-2">
              You may also reach us through our{" "}
              <a
                href="https://x.com/Protocol01_"
                className="text-p01-cyan hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Twitter
              </a>{" "}
              or{" "}
              <a
                href="https://discord.gg/protocol01"
                className="text-p01-cyan hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Discord
              </a>
              .
            </p>
          </section>
        </div>

        {/* Footer links */}
        <div className="mt-16 pt-8 border-t border-p01-border flex flex-wrap gap-6 justify-center text-sm text-p01-text-muted">
          <Link href="/terms" className="hover:text-white transition-colors">
            Terms of Service
          </Link>
          <Link href="/licenses" className="hover:text-white transition-colors">
            Open Source Licenses
          </Link>
          <Link href="/" className="hover:text-white transition-colors">
            Home
          </Link>
        </div>
      </article>
    </div>
  );
}
