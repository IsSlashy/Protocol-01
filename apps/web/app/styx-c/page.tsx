/**
 * STYX C : LE TERMINAL NOIR
 *
 * Direction: trust through verifiability, not through voice. The page is an
 * instrument panel: dense, monospace where data lives, hairline-ruled, no
 * decorative imagery, no glow. Every claim sits next to the thing that lets
 * a stranger check it, and what is not finished is printed in amber, above
 * the fold, in the same type size as everything else.
 *
 * Static server component: this route ships no client JavaScript of its own.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import styles from './styx-c.module.css';
import { CryptoTable, Ext, ProgramTable, SectionHead } from './_components/blocks';
import { LIMITS, PROGRAMS, REPO, explorerUrl, sourceUrl } from './_components/data';
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: 'Styx Protocol: private payments on Solana, built to be checked',
  description:
    'A shielded payment pool on Solana devnet with STARK proofs and hybrid post-quantum stealth addresses. Not audited, not on mainnet, and the page says so. Every program ID links to the explorer and the source.',
};

const NAV = [
  ['#problem', 'Problem'],
  ['#mechanism', 'Mechanism'],
  ['#crypto', 'Crypto'],
  ['#limits', 'Limits'],
  ['#sdk', 'SDK'],
  ['#verify', 'Verify'],
] as const;

/** Illustrative ledger rows: the values are examples, the shape is exact. */
const LEDGER_ROWS = [
  ['sender', 'you.sol'],
  ['recipient', 'your-landlord.sol'],
  ['amount', '1,850.00 USDC'],
  ['time', 'slot height, ~400 ms resolution'],
  ['memo', '"rent, march"'],
] as const;

const STEPS = [
  {
    no: '01',
    name: 'Shield',
    body: 'Deposit a fixed denomination into the pool. What the chain stores is a Poseidon commitment inserted into a Merkle tree: a hash, not an owner.',
    metaName: 'zk_shielded',
    metaHref: sourceUrl('programs/zk_shielded/src/lib.rs'),
  },
  {
    no: '02',
    name: 'Address',
    body: 'The recipient hands out a one-time stealth address, derived through a hybrid X25519 and ML-KEM-768 (FIPS 203) key exchange. Announcements travel on the specter program.',
    metaName: 'specter',
    metaHref: sourceUrl('programs/specter/src/lib.rs'),
  },
  {
    no: '03',
    name: 'Prove',
    body: 'A STARK proof shows the withdrawal spends a real note from the tree, using only hashes: Poseidon constraints over the Goldilocks field, checked by FRI. No elliptic curves anywhere in the proof.',
    metaName: 'p01_stark_verifier',
    metaHref: sourceUrl('programs/p01_stark_verifier/src/lib.rs'),
  },
  {
    no: '04',
    name: 'Settle',
    body: 'The on-chain verifier checks the proof inside the compute budget and releases funds to the stealth address. The outer transaction is signed with Ed25519, because Solana verifies nothing else.',
    metaName: explorerUrl(PROGRAMS[1].id),
    metaHref: explorerUrl(PROGRAMS[1].id),
    metaLabel: 'verifier on explorer',
  },
] as const;

const SDK_POINTS = [
  {
    name: 'Sell',
    body: 'Detect one-shot shielded payments to your wallet by signature plus invoice memo. No webhook infrastructure: your RPC connection is the source of truth.',
  },
  {
    name: 'Subscribe',
    body: 'Read subscription vaults straight from the chain. Entitlement is slot arithmetic on a public account, not a row in our database.',
  },
  {
    name: 'Claim',
    body: 'Revenue claims are permissionless: any keypair can crank the periods a merchant has earned to the merchant wallet. Proven by a third party on devnet.',
  },
  {
    name: 'Gate',
    body: 'License and access-token helpers to gate content on an active vault, without ever holding user funds.',
  },
] as const;

export default function StyxTerminalNoir() {
  /* Internal design-exploration route. These six pages exist to compare
     directions and to document the shared vocabulary; they are not part of the
     public site, so production answers 404 exactly as /void used to. Delete the
     guard, or the route, when a direction is settled. */
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  return (
    <div className={styles.root}>
      <a href="#main" className={styles.skip}>
        Skip to content
      </a>

      {/* ── status line ─────────────────────────────────────────────── */}
      <header className={styles.hdr}>
        <div className={styles.hdrIn}>
          <Link href="/styx-c" className={styles.brand}>
            STYX<span>/PROTOCOL</span>
          </Link>
          <span className={`${styles.tag} ${styles.tagWarn}`}>devnet</span>
          <span className={`${styles.tag} ${styles.tagWarn}`}>not audited</span>
          <nav className={styles.nav} aria-label="Sections">
            {NAV.map(([href, label]) => (
              <a key={href} href={href} className={styles.navAnchor}>
                {label}
              </a>
            ))}
            <Ext href={REPO}>GitHub</Ext>
          </nav>
        </div>
      </header>

      <main id="main" className={styles.frame}>
        {/* ── hero ─────────────────────────────────────────────────── */}
        <section className={styles.hero}>
          <p className={`${styles.kicker} ${styles.rise}`}>
            <b>styx@devnet</b>:~ $ cat MANIFEST
            <span className={styles.cursor} aria-hidden="true" />
          </p>
          <h1 className={`${styles.h1} ${styles.rise}`}>
            Private payments on Solana. Built to be <em>checked</em>, not
            believed.
          </h1>
          <p className={`${styles.lead} ${styles.rise2}`}>
            Styx is a shielded payment pool with STARK proofs and hybrid
            post-quantum stealth addresses. It runs on Solana devnet. It has
            not been audited. Below is what exists, where it runs, and what is
            still missing. Every row links to the chain or to the source.
          </p>
          <p className={`${styles.oath} ${styles.rise2}`}>
            Styx: the river the Greek gods swore their only unbreakable oath
            on. A commitment you cannot take back. That is the product, so
            this page holds itself to the same standard.
          </p>

          <div className={`${styles.warnBox} ${styles.rise3}`} role="note">
            <p className={styles.warnTitle}>Current state, read first</p>
            <p className={styles.warnBody}>
              Devnet only. Not audited. The deposit-to-withdrawal link is not
              yet hidden: the spend circuit that closes it is in development.
              The full register is in <a href="#limits">[04] Limitations</a>,
              in the same type size as the claims.
            </p>
          </div>

          <div className={styles.rise3}>
            <ProgramTable />
          </div>
        </section>

        {/* ── 01 problem ───────────────────────────────────────────── */}
        <section id="problem" className={styles.sec}>
          <SectionHead
            id="problem"
            idx="01"
            title="The problem"
            dek="A Solana transfer is a public record. Here is everything an ordinary one discloses, to anyone, forever."
          />
          <div className={styles.tblWrap}>
            <table className={`${styles.tbl} ${styles.tblMid}`}>
              <caption className="sr-only">
                Fields disclosed by an ordinary Solana transfer
              </caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Value (illustrative)</th>
                  <th scope="col">Who can read it</th>
                </tr>
              </thead>
              <tbody>
                {LEDGER_ROWS.map(([field, value]) => (
                  <tr key={field}>
                    <td className={styles.cellName}>{field}</td>
                    <td className={styles.mono}>{value}</td>
                    <td>Anyone. Forever.</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.tblCap}>
            The values are examples. The shape is exact: sender, recipient,
            amount, time and memo are indexed by every explorer and archive
            node.
          </p>
          <div className={styles.prose} style={{ marginTop: 24 }}>
            <p>
              Payroll, rent, invoices, supplier payments, subscriptions:
              anything settled on a public chain is disclosed to competitors,
              counterparties and future observers. &quot;Future&quot; includes
              quantum ones. Records harvested today can be attacked decades
              from now, which is why the proof and encryption layers below
              avoid elliptic curves entirely.
            </p>
          </div>
        </section>

        {/* ── 02 mechanism ─────────────────────────────────────────── */}
        <section id="mechanism" className={styles.sec}>
          <SectionHead
            id="mechanism"
            idx="02"
            title="Mechanism"
            dek="Four moves. Each one names the program that executes it."
          />
          <div className={styles.steps}>
            {STEPS.map((s) => (
              <div key={s.no} className={styles.step}>
                <p className={styles.stepNo}>{s.no}</p>
                <h3 className={styles.stepName}>{s.name}</h3>
                <p className={styles.stepBody}>{s.body}</p>
                <p className={styles.stepMeta}>
                  <Ext href={s.metaHref}>
                    {'metaLabel' in s ? s.metaLabel : `${s.metaName} [source]`}
                  </Ext>
                </p>
              </div>
            ))}
          </div>
          <p className={styles.tblCap}>
            Step 03 has a known gap in the deployed version: the spent
            commitment is still a public input. It is listed in{' '}
            <a href="#limits">[04] Limitations</a>, not hidden in a footnote.
          </p>
        </section>

        {/* ── 03 crypto ────────────────────────────────────────────── */}
        <section id="crypto" className={styles.sec}>
          <SectionHead
            id="crypto"
            idx="03"
            title="Cryptography register"
            dek={
              <>
                Layer by layer, with the quantum status stated plainly. One
                row is classical and stays classical: the chain, not this
                protocol, decides how transactions are signed.
              </>
            }
          />
          <CryptoTable />
        </section>

        {/* ── 04 limits ────────────────────────────────────────────── */}
        <section id="limits" className={styles.sec}>
          <SectionHead
            id="limits"
            idx="04"
            title="Limitations"
            dek="The register of what is not done. It is maintained with the same care as the feature list, because it is the feature list's other half."
          />
          <div className={styles.limits}>
            {LIMITS.map((l) => (
              <div key={l.label} className={styles.lim}>
                <div className={styles.limLabel}>{l.label}</div>
                <p className={styles.limBody}>
                  {l.body}
                  {l.linkHref ? (
                    <>
                      {' '}
                      <Ext href={sourceUrl(l.linkHref)}>
                        <code>{l.linkText}</code>
                      </Ext>
                    </>
                  ) : null}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── 05 sdk ───────────────────────────────────────────────── */}
        <section id="sdk" className={styles.sec}>
          <SectionHead
            id="sdk"
            idx="05"
            title="Merchant SDK"
            dek={
              <>
                One MIT-licensed package for the merchant side: verify a
                payment or a subscription server-side against your own RPC
                connection. Framework-agnostic, no wallet adapter, no network
                side effects at import.
              </>
            }
          />
          <div className={styles.sdkGrid}>
            <div>
              <div className={styles.code}>
                <div className={styles.codeHead}>
                  <span>server.ts</span>
                  <span>typescript</span>
                </div>
                <pre className={styles.codeBody}>
                  <code>
                    <span className={styles.cCom}>
                      $ npm install @protocol-01/merchant-sdk
                    </span>
                    {'\n\n'}
                    <span className={styles.cKw}>import</span>
                    {' { Connection } '}
                    <span className={styles.cKw}>from</span>{' '}
                    <span className={styles.cStr}>
                      &apos;@solana/web3.js&apos;
                    </span>
                    ;{'\n'}
                    <span className={styles.cKw}>import</span> {'{'}
                    {'\n  '}
                    <span className={styles.cFn}>verifyOneShotPayment</span>,
                    {'\n  '}
                    <span className={styles.cFn}>
                      hasActiveVaultAccessForVault
                    </span>
                    ,{'\n'}
                    {'}'} <span className={styles.cKw}>from</span>{' '}
                    <span className={styles.cStr}>
                      &apos;@protocol-01/merchant-sdk&apos;
                    </span>
                    ;{'\n\n'}
                    <span className={styles.cKw}>const</span> conn ={' '}
                    <span className={styles.cKw}>new</span> Connection(
                    <span className={styles.cStr}>
                      &apos;https://api.devnet.solana.com&apos;
                    </span>
                    );{'\n\n'}
                    <span className={styles.cCom}>
                      {'// One-shot checkout: assert this signature paid you.'}
                    </span>
                    {'\n'}
                    <span className={styles.cKw}>const</span> receipt ={' '}
                    <span className={styles.cKw}>await</span>{' '}
                    <span className={styles.cFn}>verifyOneShotPayment</span>
                    (conn, signature, retailer, {'{'}
                    {'\n  minLamports: 100_000_000n,  '}
                    <span className={styles.cCom}>{'// 0.1 SOL'}</span>
                    {'\n  expectedSlug: '}
                    <span className={styles.cStr}>&apos;my-store&apos;</span>,
                    {'   '}
                    <span className={styles.cCom}>
                      {'// invoice memo scope'}
                    </span>
                    {'\n'}
                    {'}'});{'\n\n'}
                    <span className={styles.cCom}>
                      {
                        '// Subscription: is this vault active for this subscriber?'
                      }
                    </span>
                    {'\n'}
                    <span className={styles.cKw}>const</span> vault ={' '}
                    <span className={styles.cKw}>await</span>{' '}
                    <span className={styles.cFn}>
                      hasActiveVaultAccessForVault
                    </span>
                    ({'\n  conn, vaultPda, retailer, subscriberId,\n'});
                  </code>
                </pre>
              </div>
              <p className={styles.sdkNote}>
                Real function names from the published package. On npm this is
                still{' '}
                <Ext href="https://www.npmjs.com/package/@protocol-01/merchant-sdk">
                  @protocol-01/merchant-sdk
                </Ext>
                : the Styx rename has not reached npm yet, and pretending
                otherwise would defeat the point of this page.
              </p>
            </div>
            <div className={styles.sdkList}>
              {SDK_POINTS.map((p) => (
                <div key={p.name} className={styles.sdkItem}>
                  <h3 className={styles.sdkItemName}>{p.name}</h3>
                  <p className={styles.sdkItemBody}>{p.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── 06 verify ────────────────────────────────────────────── */}
        <section id="verify" className={styles.sec}>
          <SectionHead
            id="verify"
            idx="06"
            title="Verify it yourself"
            dek="Do not take this page's word for any of it. The checks below need nothing but a terminal and an RPC endpoint."
          />
          <ol className={styles.vlist}>
            <li className={styles.vitem}>
              <div>
                <h3 className={styles.vTitle}>The programs exist</h3>
                <p className={styles.vBody}>
                  Four devnet programs, four explorer links, in the registry at
                  the top of this page. The explorer&apos;s word, not ours.
                </p>
              </div>
            </li>
            <li className={styles.vitem}>
              <div>
                <h3 className={styles.vTitle}>The IDs match the source</h3>
                <p className={styles.vBody}>
                  Every ID in the table is a <code>declare_id!</code> in public
                  Rust source. Diff them yourself:
                </p>
                <span className={styles.cmd}>
                  <b>$</b> git clone {REPO}
                  {'\n'}
                  <b>$</b> grep -rn &quot;declare_id&quot;
                  programs/*/src/lib.rs
                </span>
              </div>
            </li>
            <li className={styles.vitem}>
              <div>
                <h3 className={styles.vTitle}>The pool state is public math</h3>
                <p className={styles.vBody}>
                  Any RPC can enumerate the pool:{' '}
                  <code>getProgramAccounts</code> on{' '}
                  <Ext href={explorerUrl(PROGRAMS[0].id)}>zk_shielded</Ext>{' '}
                  returns denominated pool accounts holding a Merkle root and a
                  note count. Hashes, not owners.
                </p>
              </div>
            </li>
            <li className={styles.vitem}>
              <div>
                <h3 className={styles.vTitle}>The gaps are written down</h3>
                <p className={styles.vBody}>
                  The linkability limitation in [04] is documented in the same
                  repository that ships the code:{' '}
                  <Ext href={sourceUrl('docs/C7_SPEND_CIRCUIT_PLAN.md')}>
                    <code>docs/C7_SPEND_CIRCUIT_PLAN.md</code>
                  </Ext>
                  . A project that hides its open problems in private channels
                  is asking to be believed. This one is asking to be checked.
                </p>
              </div>
            </li>
          </ol>

          <div className={styles.ctas}>
            <Link href="/pay" className={styles.btnP}>
              Open the devnet app
            </Link>
            <Ext href={REPO} className={styles.btnG}>
              Read the source
            </Ext>
          </div>
        </section>

        {/* ── footer ───────────────────────────────────────────────── */}
        <footer className={styles.foot}>
          <div className={styles.footGrid}>
            <div>
              <p className={styles.footBrand}>STYX/PROTOCOL</p>
              <p className={styles.footText}>
                Formerly Protocol 01. Named for the river the gods swore by:
                the one oath they could not break. A cryptographic commitment
                is the same object, and this page treats it that way.
              </p>
            </div>
            <div>
              <p className={styles.footColTitle}>Index</p>
              <ul className={styles.footLinks}>
                {NAV.map(([href, label]) => (
                  <li key={href}>
                    <a href={href}>{label}</a>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className={styles.footColTitle}>External</p>
              <ul className={styles.footLinks}>
                <li>
                  <Ext href={REPO}>GitHub</Ext>
                </li>
                <li>
                  <Ext href="https://www.npmjs.com/package/@protocol-01/merchant-sdk">
                    npm: merchant-sdk
                  </Ext>
                </li>
                <li>
                  <Ext href={explorerUrl(PROGRAMS[1].id)}>
                    Verifier on explorer
                  </Ext>
                </li>
              </ul>
            </div>
          </div>
          <div className={styles.footLine}>
            <span>
              Devnet software. Not audited. Signature layer classical by chain
              requirement.
            </span>
            <span>No metrics shown: none would be honest yet.</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
