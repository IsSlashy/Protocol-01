import type { Metadata } from "next";
import Link from "next/link";
import StyxShell from "../_styx/StyxShell";
import Reveal from "../_styx/Reveal";

export const metadata: Metadata = {
  title: "Open source licenses | Styx Protocol",
  description:
    "Open source licenses and attributions for Styx Protocol, formerly Protocol 01, and its dependencies.",
};

/* Quoted verbatim from LICENSE at the repository root.
 *
 * The page this replaced printed a PARAPHRASE under the heading "MIT License":
 * it dropped "and to permit persons to whom the Software is furnished to do
 * so", rewrote the conditions clause, and abridged the warranty disclaimer.
 * A paraphrase presented as a licence is a misrepresentation, so this constant
 * is a byte-for-byte copy. If /LICENSE changes, change this with it. */
const LICENSE_TEXT = `MIT License

Copyright (c) 2025-2026 Volta Team
Developed by Slashy Fx

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/* Identifier frozen: it contains "P01_". Renaming strings of that shape is how
   this repository loses funds, so the rule is applied without exceptions, even
   to a harmless local constant. */
const P01_PACKAGES = [
  {
    name: "Styx Protocol: core protocol and applications",
    license: "MIT",
    description:
      "The wallet application, browser extension, Solana programs, proof circuits and SDK sources in this repository are released under the MIT License. Use, copy, modify and redistribute freely. The full text lives in LICENSE at the repository root and is reproduced below, unedited.",
    url: "https://github.com/IsSlashy/Protocol-01-releases",
  },
];

/* Every row below was checked against the manifests in this repository, and the
   licence column repeats what each package's own metadata declares.
   Removed on 2026-08-11 because the claim was not true:
     - "axios (via fetch)": axios is a dependency of no workspace package.
     - "@privy-io/expo": no @privy-io package appears in any manifest any more.
     - "wasmer": appears in no Cargo.toml, and the URL 404s.
   Four URLs under a `nicola/` org that owns none of these projects were
   repointed at the repositories the packages themselves declare.
   poseidon-lite is the one row with no live upstream repository. Measured
   2026-08-11: github.com/vimwitch/poseidon-lite 301s to
   github.com/chancehudson/poseidon-lite, and that target is a 404 because the
   chancehudson account itself no longer exists. The package is a real direct
   dependency (the root package.json plus six workspace manifests: zk-sdk,
   zkspl-sdk, privacy-sdk, privacy-toolkit, specter-sdk, apps/mobile), so the row
   stays and points at the npm page, which is live and declares MIT. Do not
   "restore" either GitHub URL without re-measuring it. */
const DEPENDENCIES = [
  {
    category: "Blockchain and cryptography",
    packages: [
      { name: "@solana/web3.js", license: "MIT", url: "https://github.com/solana-labs/solana-web3.js" },
      { name: "@solana/spl-token", license: "Apache-2.0", url: "https://github.com/solana-labs/solana-program-library" },
      { name: "Anchor Framework", license: "Apache-2.0", url: "https://github.com/coral-xyz/anchor" },
      { name: "winterfell", license: "MIT", url: "https://github.com/novifinancial/winterfell" },
      { name: "sha2", license: "MIT / Apache-2.0", url: "https://github.com/RustCrypto/hashes" },
      { name: "poseidon-lite", license: "MIT", url: "https://www.npmjs.com/package/poseidon-lite" },
      { name: "@noble/hashes", license: "MIT", url: "https://github.com/paulmillr/noble-hashes" },
      { name: "@noble/post-quantum", license: "MIT", url: "https://github.com/paulmillr/noble-post-quantum" },
      { name: "tweetnacl", license: "Unlicense", url: "https://github.com/dchest/tweetnacl-js" },
      { name: "circom / snarkjs", license: "GPL-3.0", url: "https://github.com/iden3/circom" },
      { name: "ark-circom", license: "MIT / Apache-2.0", url: "https://github.com/arkworks-rs/circom-compat" },
      { name: "ark-groth16", license: "MIT / Apache-2.0", url: "https://github.com/arkworks-rs/groth16" },
    ],
  },
  {
    category: "Mobile and UI framework",
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
    category: "Keys and encoding",
    packages: [
      { name: "@scure/bip39", license: "MIT", url: "https://github.com/paulmillr/scure-bip39" },
      { name: "bs58", license: "MIT", url: "https://github.com/cryptocoinjs/bs58" },
    ],
  },
  {
    category: "State management",
    packages: [
      { name: "zustand", license: "MIT", url: "https://github.com/pmndrs/zustand" },
    ],
  },
  {
    category: "Web and build tools",
    packages: [
      { name: "Next.js", license: "MIT", url: "https://github.com/vercel/next.js" },
      { name: "Tailwind CSS", license: "MIT", url: "https://github.com/tailwindlabs/tailwindcss" },
      { name: "TypeScript", license: "Apache-2.0", url: "https://github.com/microsoft/TypeScript" },
      { name: "Vite", license: "MIT", url: "https://github.com/vitejs/vite" },
    ],
  },
  {
    category: "Rust backend, prover service",
    packages: [
      { name: "axum", license: "MIT", url: "https://github.com/tokio-rs/axum" },
      { name: "tokio", license: "MIT", url: "https://github.com/tokio-rs/tokio" },
      { name: "ark-bn254", license: "MIT / Apache-2.0", url: "https://github.com/arkworks-rs/curves" },
    ],
  },
];

/* Counted, never typed. A hand-written total on a licences page is a claim that
   silently rots the next time a row is added or removed. */
const DEPENDENCY_COUNT = DEPENDENCIES.reduce(
  (total, group) => total + group.packages.length,
  0,
);

export default function OpenSourceLicenses() {
  return (
    <StyxShell>
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="styx-container styx-hero">
        <p className="styx-overline">
          Styx Protocol &middot; Legal &middot; Open source
        </p>
        <h1 className="styx-h1">
          Licenses and <em className="styx-em">attributions</em>.
        </h1>
        <div className="styx-hero-rule" aria-hidden="true" />
        <div className="styx-hero-body">
          <p className="styx-lede">
            Styx Protocol, formerly Protocol 01, is assembled out of other
            people&apos;s work. This page names that work, states the licence it
            arrives under, and links to the project itself. Rows that named a
            package this repository does not use were deleted rather than
            reworded. Upstream repositories still get renamed, transferred and
            deleted, so a link here can go stale between edits; where a
            project&apos;s own repository has disappeared, the row points at the
            registry the dependency is installed from.
          </p>
          <div className="styx-btn-row" style={{ alignItems: "center" }}>
            <span className="styx-chip">
              <span className="styx-dot" aria-hidden="true" />
              This repository: MIT
            </span>
            <span className="styx-chip">
              {DEPENDENCY_COUNT} packages listed
            </span>
          </div>
        </div>
      </section>

      {/* ── 01 · Our license ───────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              01
            </span>
            <p className="styx-index">Our license</p>
            <h2 className="styx-h2">
              This repository is <span className="styx-gleam">MIT</span>.
            </h2>
          </div>
          <div className="styx-stack-lg">
            {P01_PACKAGES.map((pkg) => (
              <Reveal
                key={pkg.name}
                className="styx-panel styx-sweep styx-reveal"
              >
                <div className="styx-panel-head">
                  <h3 className="styx-h3">{pkg.name}</h3>
                  <div
                    className="styx-btn-row"
                    style={{ alignItems: "center", gap: "1.25rem" }}
                  >
                    <span className="styx-chip">{pkg.license}</span>
                    <a
                      className="styx-link styx-mono"
                      href={pkg.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View source
                    </a>
                  </div>
                </div>
                <div className="styx-panel-body">
                  <div className="styx-prose">
                    <p>{pkg.description}</p>
                  </div>
                </div>
              </Reveal>
            ))}

            <Reveal className="styx-code-panel styx-reveal" delay={80}>
              <div className="styx-code-head">
                <span>MIT License &middot; /LICENSE</span>
                <span>Verbatim</span>
              </div>
              <pre className="styx-code">
                <code>{LICENSE_TEXT}</code>
              </pre>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── 02 · Third party ───────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              02
            </span>
            <p className="styx-index">Third party</p>
            <h2 className="styx-h2">
              {DEPENDENCY_COUNT} packages we did not write.
            </h2>
          </div>
          <div className="styx-stack-lg">
            <div className="styx-prose">
              <p>
                These are the direct dependencies of the wallet, the extension,
                the web app, the Solana programs and the prover service. Each
                row repeats the licence that project declares in its own package
                metadata, and links to the project&apos;s repository, or to its
                registry page where that repository no longer exists.
              </p>
              <p>
                Two proof stacks appear below and they are not the same thing.
                The on-chain verifier is hash-based: winterfell, SHA-256 and
                Poseidon, with no elliptic curve anywhere in the proof. The
                older native Groth16 prover kept in <code>services/prover</code>{" "}
                does use a curve, BN254, which is why ark-bn254, ark-groth16 and
                ark-circom are listed here.
              </p>
            </div>

            {DEPENDENCIES.map((group, i) => (
              <Reveal
                as="div"
                key={group.category}
                className="styx-reveal"
                delay={i * 60}
              >
                <h3
                  className="styx-h3"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.65rem",
                  }}
                >
                  <span className="styx-dot" aria-hidden="true" />
                  {group.category}
                </h3>
                <div className="styx-table-wrap">
                  <table className="styx-table">
                    <thead>
                      <tr>
                        <th>Package</th>
                        <th>License</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.packages.map((pkg) => (
                        <tr key={pkg.name}>
                          <td>
                            <a
                              className="styx-link"
                              href={pkg.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {pkg.name}
                            </a>
                          </td>
                          <td>
                            <span className="styx-mono">{pkg.license}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── 03 · Notice ────────────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              03
            </span>
            <p className="styx-index">Notice</p>
            <h2 className="styx-h2">This list is not exhaustive.</h2>
          </div>
          <div className="styx-stack-lg">
            <div className="styx-prose">
              <p>
                Only direct dependencies are named. A build resolves far more
                than this, and the count changes with every lockfile. Read the
                tables as an honest map of what the project chose, not as a
                complete bill of materials.
              </p>
              <p>
                The authoritative licence for any package is the text in that
                package&apos;s own repository, not the identifier in our table.
                If an attribution here is missing or wrong, write to{" "}
                <a className="styx-link" href="mailto:legal@protocol-01.com">
                  legal@protocol-01.com
                </a>
                .
              </p>
            </div>

            <div className="styx-admission">
              <p className="styx-admission-title">
                Read this before you rely on it
              </p>
              <p className="styx-admission-body">
                Two things a reader must not miss. Every package above carries
                transitive dependencies under their own terms, which this page
                does not enumerate, so a legal review cannot stop here. And the
                warranty disclaimer in the licence above is meant literally:
                this is unaudited devnet software, with no mainnet deployment.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Close ──────────────────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container">
          <div className="styx-gleam-rule" aria-hidden="true" />
          <div className="styx-btn-row" style={{ marginTop: "2rem" }}>
            <Link className="styx-link styx-mono" href="/privacy">
              Privacy policy
            </Link>
            <Link className="styx-link styx-mono" href="/terms">
              Terms of service
            </Link>
            <Link className="styx-link styx-mono" href="/">
              Home
            </Link>
          </div>
        </div>
      </section>
    </StyxShell>
  );
}
