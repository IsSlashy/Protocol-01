import type { Metadata } from "next";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Open Source Licenses | PROTOCOL-01",
  description:
    "Open source licenses and attributions for Protocol 01 and its dependencies.",
};

const P01_PACKAGES = [
  {
    name: "Protocol 01 — Core Protocol & Applications",
    license: "BSL-1.1",
    description:
      "The wallet application, browser extension, smart contracts, ZK circuits, and SDK packages are licensed under the Business Source License 1.1. Source code is viewable and forkable for non-commercial purposes. Commercial use requires explicit written permission.",
    url: "https://github.com/IsSlashy/Protocol-01-releases",
  },
];

const DEPENDENCIES = [
  {
    category: "Blockchain & Cryptography",
    packages: [
      { name: "@solana/web3.js", license: "MIT", url: "https://github.com/solana-labs/solana-web3.js" },
      { name: "@solana/spl-token", license: "Apache-2.0", url: "https://github.com/solana-labs/solana-program-library" },
      { name: "Anchor Framework", license: "Apache-2.0", url: "https://github.com/coral-xyz/anchor" },
      { name: "circom / snarkjs", license: "GPL-3.0", url: "https://github.com/iden3/circom" },
      { name: "ark-circom", license: "MIT / Apache-2.0", url: "https://github.com/arkworks-rs/circom-compat" },
      { name: "ark-groth16", license: "MIT / Apache-2.0", url: "https://github.com/arkworks-rs/groth16" },
      { name: "poseidon-lite", license: "MIT", url: "https://github.com/vimwitch/poseidon-lite" },
      { name: "tweetnacl", license: "Unlicense", url: "https://github.com/nicola/tweetnacl-js" },
    ],
  },
  {
    category: "Mobile & UI Framework",
    packages: [
      { name: "React Native", license: "MIT", url: "https://github.com/facebook/react-native" },
      { name: "Expo", license: "MIT", url: "https://github.com/expo/expo" },
      { name: "expo-router", license: "MIT", url: "https://github.com/expo/expo" },
      { name: "expo-blur", license: "MIT", url: "https://github.com/expo/expo" },
      { name: "expo-linear-gradient", license: "MIT", url: "https://github.com/expo/expo" },
      { name: "expo-haptics", license: "MIT", url: "https://github.com/expo/expo" },
      { name: "expo-secure-store", license: "MIT", url: "https://github.com/expo/expo" },
      { name: "react-native-reanimated", license: "MIT", url: "https://github.com/software-mansion/react-native-reanimated" },
      { name: "react-native-safe-area-context", license: "MIT", url: "https://github.com/th3rdwave/react-native-safe-area-context" },
    ],
  },
  {
    category: "Authentication & Wallet",
    packages: [
      { name: "@privy-io/expo", license: "MIT", url: "https://github.com/privy-io/privy-js" },
      { name: "@scure/bip39", license: "MIT", url: "https://github.com/nicola/paulmillr-scure-bip39" },
      { name: "bs58", license: "MIT", url: "https://github.com/nicola/bs58" },
    ],
  },
  {
    category: "State Management & Networking",
    packages: [
      { name: "zustand", license: "MIT", url: "https://github.com/pmndrs/zustand" },
      { name: "axios (via fetch)", license: "MIT", url: "https://github.com/axios/axios" },
    ],
  },
  {
    category: "Web & Build Tools",
    packages: [
      { name: "Next.js", license: "MIT", url: "https://github.com/vercel/next.js" },
      { name: "Tailwind CSS", license: "MIT", url: "https://github.com/tailwindlabs/tailwindcss" },
      { name: "TypeScript", license: "Apache-2.0", url: "https://github.com/microsoft/TypeScript" },
      { name: "Vite", license: "MIT", url: "https://github.com/vitejs/vite" },
    ],
  },
  {
    category: "Rust Backend (Prover Service)",
    packages: [
      { name: "axum", license: "MIT", url: "https://github.com/tokio-rs/axum" },
      { name: "tokio", license: "MIT", url: "https://github.com/tokio-rs/tokio" },
      { name: "ark-bn254", license: "MIT / Apache-2.0", url: "https://github.com/arkworks-rs/curves" },
      { name: "wasmer", license: "MIT", url: "https://github.com/nicola/wasmerio-wasmer" },
    ],
  },
];

export default function OpenSourceLicenses() {
  return (
    <div className="min-h-screen bg-p01-void">
      <SiteHeader />

      {/* Content */}
      <article className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-24">
        <header className="mb-16 text-center">
          <div className="inline-block px-4 py-1.5 rounded-full bg-p01-cyan/10 border border-p01-cyan/20 mb-6">
            <span className="text-p01-cyan text-xs font-mono tracking-widest uppercase">
              Open Source
            </span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-display font-bold text-white mb-4">
            Licenses &amp; Attributions
          </h1>
          <p className="text-p01-text-muted text-lg max-w-2xl mx-auto">
            Protocol 01 is built on the shoulders of exceptional open-source
            projects. We are grateful to the communities that make this
            possible.
          </p>
        </header>

        <div className="space-y-12">
          {/* Protocol 01 License */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-6">
              Protocol 01 License
            </h2>
            {P01_PACKAGES.map((pkg) => (
              <div
                key={pkg.name}
                className="bg-p01-surface rounded-xl p-6 border border-p01-cyan/20"
              >
                <div className="flex items-start justify-between flex-wrap gap-4">
                  <div>
                    <h3 className="text-lg font-semibold text-white">
                      {pkg.name}
                    </h3>
                    <span className="inline-block mt-2 px-3 py-1 rounded-full bg-p01-cyan/10 text-p01-cyan text-xs font-mono">
                      {pkg.license}
                    </span>
                  </div>
                  <a
                    href={pkg.url}
                    className="text-p01-cyan text-sm hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View Source
                  </a>
                </div>
                <p className="mt-4 text-p01-text-muted text-sm leading-relaxed">
                  {pkg.description}
                </p>
                <div className="mt-4 bg-p01-void rounded-lg p-4 text-xs font-mono text-p01-text-dim leading-relaxed">
                  <p>
                    Business Source License 1.1 — Copyright (c) 2024-2026 Protocol 01
                    Team. All rights reserved.
                  </p>
                  <p className="mt-2">
                    Licensed under the Business Source License 1.1 (the
                    &quot;License&quot;); you may not use this software except in
                    compliance with the License. You may obtain a copy of the
                    License at{" "}
                    <a
                      href="https://mariadb.com/bsl11/"
                      className="text-p01-cyan hover:underline"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      mariadb.com/bsl11
                    </a>
                    .
                  </p>
                  <p className="mt-2">
                    Additional Use Grant: You may use the Licensed Work for
                    non-commercial and evaluation purposes. Production commercial
                    use requires a separate commercial license from the Protocol 01
                    team.
                  </p>
                  <p className="mt-2">
                    Change Date: Four years from each release date.
                    <br />
                    Change License: Apache License, Version 2.0.
                  </p>
                  <p className="mt-2">
                    THE SOFTWARE IS PROVIDED &quot;AS IS&quot;, WITHOUT WARRANTY OF ANY
                    KIND, EXPRESS OR IMPLIED. IN NO EVENT SHALL THE AUTHORS BE
                    LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY.
                  </p>
                </div>
              </div>
            ))}
          </section>

          {/* Third-party dependencies */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-6">
              Third-Party Dependencies
            </h2>
            <p className="text-p01-text-muted mb-8">
              The following open-source packages are used in Protocol 01. We
              thank their maintainers and contributors.
            </p>

            {DEPENDENCIES.map((group) => (
              <div key={group.category} className="mb-8">
                <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-p01-cyan" />
                  {group.category}
                </h3>
                <div className="bg-p01-surface rounded-xl overflow-hidden border border-p01-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-p01-border">
                        <th className="text-left py-3 px-4 text-p01-text-dim font-medium text-xs uppercase tracking-wider">
                          Package
                        </th>
                        <th className="text-left py-3 px-4 text-p01-text-dim font-medium text-xs uppercase tracking-wider">
                          License
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.packages.map((pkg, i) => (
                        <tr
                          key={pkg.name}
                          className={
                            i < group.packages.length - 1
                              ? "border-b border-p01-border/50"
                              : ""
                          }
                        >
                          <td className="py-3 px-4">
                            <a
                              href={pkg.url}
                              className="text-white hover:text-p01-cyan transition-colors"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {pkg.name}
                            </a>
                          </td>
                          <td className="py-3 px-4">
                            <span className="px-2 py-0.5 rounded bg-p01-void text-p01-text-muted text-xs font-mono">
                              {pkg.license}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>

          {/* Notice */}
          <section className="bg-p01-surface rounded-xl p-6 border border-p01-border">
            <h3 className="text-lg font-semibold text-white mb-3">
              Notice
            </h3>
            <p className="text-p01-text-muted text-sm leading-relaxed">
              This list represents the major dependencies used in Protocol 01
              and is not exhaustive. Each package may have its own transitive
              dependencies with their own licenses. The full license text for
              each dependency can be found in the respective package&apos;s
              repository. If you believe an attribution is missing or
              incorrect, please contact us at{" "}
              <a
                href="mailto:legal@protocol-01.com"
                className="text-p01-cyan hover:underline"
              >
                legal@protocol-01.com
              </a>
              .
            </p>
          </section>
        </div>

        {/* Footer links */}
        <div className="mt-16 pt-8 border-t border-p01-border flex flex-wrap gap-6 justify-center text-sm text-p01-text-muted">
          <Link href="/privacy" className="hover:text-white transition-colors">
            Privacy Policy
          </Link>
          <Link href="/terms" className="hover:text-white transition-colors">
            Terms of Service
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
