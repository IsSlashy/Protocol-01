import type { Metadata } from "next";
import StyxShell from "../_styx/StyxShell";
import Reveal from "../_styx/Reveal";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Styx kit — the shared design system",
  description:
    "Every class in styx.css, rendered once, so pages are ported against something real instead of a description.",
};

/**
 * The living style guide.
 *
 * This page exists so that whoever ports a page can see the vocabulary rather
 * than infer it, and so the foundation gets verified in a browser before twenty
 * pages inherit it. It is a working document, not a public page.
 */
export default function StyxKitPage() {
  /* Internal design-exploration route. These six pages exist to compare
     directions and to document the shared vocabulary; they are not part of the
     public site, so production answers 404 exactly as /void used to. Delete the
     guard, or the route, when a direction is settled. */
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  return (
    <StyxShell>
      <section className="styx-container styx-hero">
        <p className="styx-overline">Styx Protocol &middot; Design system</p>
        <h1 className="styx-h1">
          One vocabulary, <em className="styx-em">shared</em> by every page.
        </h1>
        <div className="styx-hero-rule" aria-hidden="true" />
        <div className="styx-hero-body">
          <p className="styx-lede">
            Everything below is a class in <code>app/_styx/styx.css</code>. A page
            author composes these and writes no colours, no font stacks and no
            spacing of their own. <strong>If something is missing, add it here</strong>{" "}
            rather than forking it into a page-local module.
          </p>
          <div className="styx-btn-row">
            <a className="styx-btn" href="#gleam">
              See the gleam
            </a>
            <a className="styx-btn-ghost" href="/styx-a">
              Direction A
            </a>
          </div>
        </div>
      </section>

      {/* ── The gleam ─────────────────────────────────────────────────── */}
      <section id="gleam" className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              01
            </span>
            <p className="styx-index">The gleam</p>
            <h2 className="styx-h2">The one gesture carried over.</h2>
          </div>
          <div>
            <div className="styx-prose">
              <p>
                Protocol 01 swept a sharp white streak across the FOUNDER nav
                word: a tilted gradient band driven by{" "}
                <code>background-position</code>, travelling left to right and,
                because the band sits past vertical, appearing to slide downward
                as it went. Same mechanism here, different manners — paper-white
                over the muted body colour, cyan reduced to one thin trailing
                edge, no halo, and slower.
              </p>
            </div>

            <div className="styx-stack-lg" style={{ marginTop: "2.5rem" }}>
              <div>
                <p className="styx-card-label">
                  styx-gleam &middot; on muted body text
                </p>
                <p
                  className="styx-gleam"
                  style={{
                    fontFamily: "var(--styx-mono)",
                    fontSize: "0.9rem",
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    margin: 0,
                  }}
                >
                  Payments that hold their oath
                </p>
              </div>

              <div>
                <p className="styx-card-label">
                  styx-gleam-strong &middot; for a hero word or a nav item
                </p>
                <p
                  className="styx-gleam-strong"
                  style={{
                    fontFamily: "var(--styx-serif)",
                    fontWeight: 300,
                    fontSize: "clamp(2rem, 5vw, 3.25rem)",
                    lineHeight: 1.1,
                    margin: 0,
                  }}
                >
                  Founder
                </p>
              </div>

              <div>
                <p className="styx-card-label">
                  styx-gleam-rule &middot; a highlight travelling along a hairline
                </p>
                <div className="styx-gleam-rule" aria-hidden="true" />
              </div>

              <div>
                <p className="styx-card-label">
                  styx-sweep &middot; crosses a panel on hover
                </p>
                <div className="styx-grid styx-grid-3">
                  {["Shield", "Pay in private", "Unshield"].map((title, i) => (
                    <div className="styx-card styx-sweep" key={title}>
                      <p className="styx-card-label">0{i + 1}</p>
                      <p className="styx-card-value">{title}</p>
                      <p className="styx-card-note">
                        Hover this panel: the gleam crosses it on the same
                        downward diagonal.
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Type ──────────────────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              02
            </span>
            <p className="styx-index">Type</p>
            <h2 className="styx-h2">Newsreader, three weights.</h2>
          </div>
          <div>
            <div className="styx-stack-lg">
              <div>
                <p className="styx-card-label">styx-h1 &middot; weight 300</p>
                <p className="styx-h1" style={{ margin: 0 }}>
                  Private payments, <em className="styx-em">provable</em> to
                  anyone.
                </p>
              </div>
              <div>
                <p className="styx-card-label">styx-h2 &middot; weight 400</p>
                <p className="styx-h2" style={{ margin: 0 }}>
                  A public ledger is a public record.
                </p>
              </div>
              <div>
                <p className="styx-card-label">styx-h3 &middot; weight 500</p>
                <p className="styx-h3" style={{ margin: 0 }}>
                  Three moves, one pool.
                </p>
              </div>
              <div>
                <p className="styx-card-label">styx-lede</p>
                <p className="styx-lede">
                  Styx shields value in a common pool on Solana.{" "}
                  <strong>It runs on devnet today. It has not been audited.</strong>
                </p>
              </div>
              <div>
                <p className="styx-card-label">styx-prose</p>
                <div className="styx-prose">
                  <p>
                    Body copy stays on Inter, evidence on JetBrains Mono. A{" "}
                    <a href="#gleam">link</a> underlines in cyan at a 4px offset.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Surfaces ──────────────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              03
            </span>
            <p className="styx-index">Surfaces</p>
            <h2 className="styx-h2">Hairlines, never shadows.</h2>
          </div>
          <div className="styx-stack-lg">
            <div className="styx-grid styx-grid-4">
              <Reveal className="styx-card styx-reveal">
                <p className="styx-card-label">Proof system</p>
                <p className="styx-card-value">Hash-based STARK</p>
                <p className="styx-card-note">Poseidon and Merkle trees only.</p>
              </Reveal>
              <Reveal className="styx-card styx-reveal" delay={80}>
                <p className="styx-card-label">Key encapsulation</p>
                <p className="styx-card-value">X25519 + ML-KEM-768</p>
                <p className="styx-card-note">The lattice half follows FIPS 203.</p>
              </Reveal>
              <Reveal className="styx-card styx-reveal" delay={160}>
                <p className="styx-card-label">Status</p>
                <p className="styx-card-value">Devnet</p>
                <p className="styx-card-note">There is no mainnet deployment.</p>
              </Reveal>
              <Reveal className="styx-card styx-reveal" delay={240}>
                <p className="styx-card-label">Audits</p>
                <p className="styx-card-value">None yet</p>
                <p className="styx-card-note">Said here until it changes.</p>
              </Reveal>
            </div>

            <div className="styx-admission">
              <p className="styx-admission-title">Current state, read first</p>
              <p className="styx-admission-body">
                The one place amber is allowed: an admission the reader must not
                miss. Never decorative.
              </p>
            </div>

            <div className="styx-panel">
              <div className="styx-panel-head">
                <p className="styx-overline">styx-panel</p>
                <p className="styx-h3" style={{ margin: "0.5rem 0 0" }}>
                  With a head and a body.
                </p>
              </div>
              <div className="styx-panel-body">
                <div className="styx-row">
                  <span className="styx-row-key">from</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">7xKQ…3fUw</span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">to</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value styx-redacted">
                    one-time address
                  </span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">proof</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">STARK, verified on-chain</span>
                </div>
              </div>
            </div>

            <div className="styx-table-wrap">
              <table className="styx-table">
                <thead>
                  <tr>
                    <th>Program</th>
                    <th>Role</th>
                    <th>Verify</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>zk_shielded</td>
                    <td>Shielded pool, STARK-gated unshield</td>
                    <td>
                      <a className="styx-link" href="/explorer">
                        explorer
                      </a>
                    </td>
                  </tr>
                  <tr>
                    <td>p01_stark_verifier</td>
                    <td>On-chain STARK verifier over Goldilocks</td>
                    <td>
                      <a className="styx-link" href="/explorer">
                        explorer
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      {/* ── Controls ──────────────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              04
            </span>
            <p className="styx-index">Controls</p>
            <h2 className="styx-h2">Buttons, fields, marks.</h2>
          </div>
          <div className="styx-stack-lg">
            <div>
              <p className="styx-card-label">Buttons</p>
              <div className="styx-btn-row">
                <button className="styx-btn" type="button">
                  Primary
                </button>
                <button className="styx-btn-ghost" type="button">
                  Ghost
                </button>
                <button className="styx-btn" type="button" disabled>
                  Disabled
                </button>
              </div>
            </div>

            <div>
              <p className="styx-card-label">Fields</p>
              <div className="styx-stack" style={{ maxWidth: "28rem" }}>
                <div className="styx-field">
                  <label className="styx-label" htmlFor="kit-email">
                    Email
                  </label>
                  <input
                    id="kit-email"
                    className="styx-input"
                    type="email"
                    placeholder="you@example.com"
                  />
                </div>
                <div className="styx-field">
                  <label className="styx-label" htmlFor="kit-key">
                    Admin key
                  </label>
                  <input
                    id="kit-key"
                    className="styx-input styx-input-mono"
                    type="password"
                    placeholder="••••••••"
                  />
                </div>
                <p className="styx-form-ok">Saved.</p>
                <p className="styx-form-error">That address is already listed.</p>
              </div>
            </div>

            <div>
              <p className="styx-card-label">Marks</p>
              <div className="styx-btn-row" style={{ alignItems: "center" }}>
                <span className="styx-chip">
                  <span className="styx-dot" aria-hidden="true" />
                  Devnet
                </span>
                <span className="styx-chip">Not audited</span>
                <span className="styx-mono">
                  <span className="styx-check" aria-hidden="true">
                    &#10003;
                  </span>
                  A checked claim
                </span>
              </div>
            </div>

            <div>
              <p className="styx-card-label">Steps</p>
              <ul className="styx-steps">
                <li className="styx-step">
                  <span className="styx-step-index">01</span>
                  <div>
                    <h3 className="styx-h3">Shield</h3>
                    <p className="styx-step-body">
                      Deposit into the pool. The chain records a Poseidon
                      commitment.
                    </p>
                  </div>
                </li>
                <li className="styx-step">
                  <span className="styx-step-index">02</span>
                  <div>
                    <h3 className="styx-h3">Pay in private</h3>
                    <p className="styx-step-body">
                      Prove a note of yours sits in the tree without pointing at
                      it.
                    </p>
                  </div>
                </li>
              </ul>
            </div>

            <div className="styx-code-panel">
              <div className="styx-code-head">
                <span>@protocol-01/merchant-sdk &middot; MIT</span>
                <span>devnet</span>
              </div>
              <pre className="styx-code">
                <code>
                  <span className="styx-code-comment">
                    {"// Entitlement is a read, not a webhook."}
                  </span>
                  {"\n"}
                  {"const active = "}
                  <span className="styx-code-name">subscriptionIsCurrent</span>
                  {"(vault, service);"}
                </code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* Tall filler so the sticky header can be judged while scrolling. */}
      <section className="styx-section">
        <div className="styx-container">
          <p className="styx-overline">Scroll check</p>
          <h2 className="styx-h2">Does the bar stay put?</h2>
          <p className="styx-lede" style={{ marginTop: "1.5rem" }}>
            The root layout wraps every page in a container with{" "}
            <code>overflow-hidden</code>, which is very likely why the Protocol 01
            header used <code>position: fixed</code>. This block exists to prove
            whether <code>sticky</code> survives that.
          </p>
          <div style={{ height: "120vh" }} aria-hidden="true" />
          <p className="styx-note">
            If the bar is still at the top of the viewport here, sticky works.
          </p>
        </div>
      </section>
    </StyxShell>
  );
}
