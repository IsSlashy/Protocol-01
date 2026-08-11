"use client";

/**
 * Whitelist admin dashboard, in the Styx voice.
 *
 * Presentation only: every fetch, header, hook and handler below is the same
 * one the Protocol 01 version shipped.
 *
 *  - Auth: one secret field, sent as `x-admin-password` on all four calls. The
 *    server compares it to ADMIN_PASSWORD in app/api/whitelist/route.ts. The
 *    password lives in React state and nowhere else, on purpose.
 *  - Data: GET /api/whitelist?admin=true, POST /api/whitelist (approve, reject),
 *    DELETE /api/whitelist?wallet=...
 *  - Internal tool: English only, no i18n, mirrors /admin/waitlist conventions.
 *    There are no admin keys in i18n/{en,fr} and adding them would mean editing
 *    shared files. The Protocol 01 version had no t() call either, so nothing
 *    was translated away here.
 *
 * Frame: StyxShell with chrome={false}. This page never had the site nav, and
 * the shared header/footer are public-facing. The browser tab title comes from
 * app/admin/layout.tsx, since a client component cannot export metadata.
 */

import { useState, useEffect, useCallback, type CSSProperties } from "react";
import {
  Check,
  X,
  Plus,
  Trash2,
  RefreshCw,
  Lock,
  AlertTriangle,
  Copy,
  ExternalLink,
} from "lucide-react";
import StyxShell from "../_styx/StyxShell";
import Reveal from "../_styx/Reveal";
/* Page-local stylesheet, one rule set: Chrome's autofill colours. See the file
   header for the measurement. A React-rendered <style precedence> was tried
   first and did not survive hydration in dev, the SSR tag was dropped and the
   rules left document.styleSheets, so this is a real route stylesheet. */
import "./admin.css";

interface WhitelistEntry {
  wallet: string;
  email?: string;
  projectName?: string;
  approvedAt: string;
  approvedBy: string;
}

interface WhitelistData {
  approved: WhitelistEntry[];
  pending: WhitelistEntry[];
}

/* styx.css has one button size and no icon-button. Until it gains them, the
   compact variants are inline, which is the idiom styx-kit already uses for
   one-off metrics on a shared class. */
const BTN_SMALL: CSSProperties = { padding: "0.5rem 0.95rem", gap: "0.45rem" };
const BTN_ICON: CSSProperties = { padding: "0.4rem 0.5rem", gap: 0 };
const NOWRAP: CSSProperties = { whiteSpace: "nowrap" };
const ACTIONS: CSSProperties = { textAlign: "right", whiteSpace: "nowrap" };
const WALLET: CSSProperties = { color: "var(--styx-paper)" };

/**
 * Restores the serif voice on a REAL heading element.
 *
 * Measured in the browser on 2026-08-11: `.styx :is(h1, h2, h3, h4, h5, h6)` in
 * styx.css resets font-family, font-weight and letter-spacing, and because
 * `:is()` takes the specificity of its most specific argument that selector
 * scores (0,1,1) against (0,1,0) for `.styx-h1` / `.styx-h2` / `.styx-h3`. The
 * reset wins on any real <h1> to <h6>, so `font-family: inherit` lands on Inter
 * and the headings on this page came out sans while a `<p className="styx-h3">`
 * came out serif, two voices inside one page.
 *
 * styx.css is shared and off limits from here, so each heading re-asserts the
 * exact tokens its own class already asks for. No new colour, no new font, no
 * new size. Same remedy the sibling /admin/waitlist page uses.
 * Reported upward: styx.css should lower that reset to `:where(...)`, which
 * scores (0,1,0) and lets the heading classes win unaided.
 */
const SERIF_H1: CSSProperties = {
  fontFamily: "var(--styx-serif)",
  fontWeight: "var(--styx-serif-display)" as CSSProperties["fontWeight"],
  letterSpacing: "-0.022em",
};

const SERIF_H2: CSSProperties = {
  fontFamily: "var(--styx-serif)",
  fontWeight: "var(--styx-serif-title)" as CSSProperties["fontWeight"],
  letterSpacing: "-0.01em",
};

const SERIF_H3: CSSProperties = {
  fontFamily: "var(--styx-serif)",
  fontWeight: "var(--styx-serif-small)" as CSSProperties["fontWeight"],
  letterSpacing: "-0.005em",
};

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [whitelist, setWhitelist] = useState<WhitelistData>({ approved: [], pending: [] });

  // Form for adding new wallet
  const [newWallet, setNewWallet] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newProject, setNewProject] = useState("");

  const fetchWhitelist = useCallback(async () => {
    if (!password) return;

    setIsLoading(true);
    try {
      const res = await fetch("/api/whitelist?admin=true", {
        headers: { "x-admin-password": password },
      });

      if (res.status === 401) {
        setIsAuthenticated(false);
        setError("Invalid password");
        return;
      }

      const data = await res.json();
      setWhitelist(data);
      setIsAuthenticated(true);
      setError("");
    } catch (err) {
      setError("Failed to fetch whitelist");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, [password]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetchWhitelist();
  };

  const handleApprove = async (wallet: string, email?: string, projectName?: string) => {
    try {
      const res = await fetch("/api/whitelist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": password,
        },
        body: JSON.stringify({ wallet, email, projectName, action: "approve" }),
      });

      if (res.ok) {
        await fetchWhitelist();
      }
    } catch (err) {
      console.error("Failed to approve:", err);
    }
  };

  const handleReject = async (wallet: string) => {
    try {
      const res = await fetch("/api/whitelist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": password,
        },
        body: JSON.stringify({ wallet, action: "reject" }),
      });

      if (res.ok) {
        await fetchWhitelist();
      }
    } catch (err) {
      console.error("Failed to reject:", err);
    }
  };

  const handleRevoke = async (wallet: string) => {
    if (!confirm(`Revoke access for ${wallet.slice(0, 8)}...?`)) return;

    try {
      const res = await fetch(`/api/whitelist?wallet=${wallet}`, {
        method: "DELETE",
        headers: { "x-admin-password": password },
      });

      if (res.ok) {
        await fetchWhitelist();
      }
    } catch (err) {
      console.error("Failed to revoke:", err);
    }
  };

  const handleAddManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWallet.trim()) return;

    await handleApprove(newWallet.trim(), newEmail.trim(), newProject.trim());
    setNewWallet("");
    setNewEmail("");
    setNewProject("");
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!isAuthenticated) return;

    const interval = setInterval(fetchWhitelist, 30000);
    return () => clearInterval(interval);
  }, [isAuthenticated, fetchWhitelist]);

  // ── Locked ──────────────────────────────────────────────────────────────
  if (!isAuthenticated) {
    return (
      <StyxShell chrome={false}>
          <section className="styx-container-narrow styx-hero">
          <p
            className="styx-overline"
            style={{ display: "flex", alignItems: "center", gap: "0.55rem" }}
          >
            <Lock size={13} aria-hidden="true" />
            Styx Protocol &middot; Internal tool
          </p>
          <h1 className="styx-h1" style={SERIF_H1}>
            The <span className="styx-gleam">whitelist</span> is locked.
          </h1>
          <div className="styx-hero-rule" aria-hidden="true" />

          <form onSubmit={handleLogin} className="styx-stack" style={{ maxWidth: "26rem" }}>
            <div className="styx-field">
              <label className="styx-label" htmlFor="admin-password">
                Admin password
              </label>
              <input
                id="admin-password"
                className="styx-input styx-input-mono"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter admin password"
                autoComplete="current-password"
              />
            </div>

            {error && (
              <p
                className="styx-form-error"
                style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              >
                <AlertTriangle size={14} aria-hidden="true" />
                {error}
              </p>
            )}

            <div className="styx-btn-row">
              <button type="submit" className="styx-btn" disabled={isLoading || !password}>
                {isLoading ? "Authenticating..." : "Login"}
              </button>
            </div>
          </form>

          <p className="styx-note" style={{ marginTop: "2.5rem", maxWidth: "52ch" }}>
            What you type is sent to <code>/api/whitelist</code> as a header and compared
            there against <code>ADMIN_PASSWORD</code>. It is held in this tab only, never
            written to storage or a cookie, so closing the tab ends the session.
          </p>
        </section>
      </StyxShell>
    );
  }

  // ── Dashboard ───────────────────────────────────────────────────────────
  return (
    <StyxShell chrome={false}>
      {/* Local bar. chrome={false} means there is no shared header to inherit. */}
      <div className="styx-container" style={{ paddingTop: "2.75rem" }}>
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <span className="styx-wordmark">
              <span className="styx-wordmark-name">Styx</span>
              <span className="styx-wordmark-suffix">Protocol</span>
            </span>
            <h1 className="styx-h3" style={{ ...SERIF_H3, margin: "0.85rem 0 0" }}>
              Whitelist admin
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="styx-chip">Internal tool</span>
            <button
              type="button"
              className="styx-btn-ghost"
              style={BTN_SMALL}
              onClick={fetchWhitelist}
              disabled={isLoading}
            >
              <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} aria-hidden="true" />
              Refresh
            </button>
          </div>
        </div>

        <p className="styx-note" style={{ marginTop: "1.5rem" }}>
          Reloads itself every 30 seconds while this tab is open, and re-sends the password
          each time.
        </p>
        <div className="styx-gleam-rule" aria-hidden="true" style={{ marginTop: "1.25rem" }} />
      </div>

      {/* ── 01 · Ledger ──────────────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              01
            </span>
            <p className="styx-index">Ledger</p>
            <h2 className="styx-h2" style={SERIF_H2}>
              What is on the list.
            </h2>
          </div>
          <div>
            <p className="styx-lede">
              Approving a wallet unlocks the developer view on{" "}
              <a className="styx-link" href="/sdk-demo">
                /sdk-demo
              </a>
              . It is a list held server-side, not an on-chain permission, and nothing here
              checks who controls the address.
            </p>

            <div className="styx-grid styx-grid-4" style={{ marginTop: "2.5rem" }}>
              <Reveal className="styx-card styx-reveal">
                <p className="styx-card-label">Approved</p>
                <p className="styx-card-value">{whitelist.approved.length}</p>
                <p className="styx-card-note">Wallets that currently see the developer view.</p>
              </Reveal>
              <Reveal className="styx-card styx-reveal" delay={80}>
                <p className="styx-card-label">Pending</p>
                <p className="styx-card-value">{whitelist.pending.length}</p>
                <p className="styx-card-note">Requests waiting on a decision.</p>
              </Reveal>
              <Reveal className="styx-card styx-reveal" delay={160}>
                <p className="styx-card-label">Currently listed</p>
                <p className="styx-card-value">
                  {whitelist.approved.length + whitelist.pending.length}
                </p>
                <p className="styx-card-note">
                  Approved plus pending, as stored right now. Not requests ever received.
                </p>
              </Reveal>
              <Reveal className="styx-card styx-reveal" delay={240}>
                <p className="styx-card-label">Approved share of listed</p>
                <p className="styx-card-value">
                  {whitelist.approved.length + whitelist.pending.length > 0
                    ? Math.round(
                        (whitelist.approved.length /
                          (whitelist.approved.length + whitelist.pending.length)) *
                          100
                      )
                    : 0}
                  %
                </p>
                <p className="styx-card-note">
                  Rejecting and revoking delete the row, so this is not an approval rate.
                </p>
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      {/* ── 02 · Add by hand ─────────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              02
            </span>
            <p className="styx-index">Entry</p>
            <h2 className="styx-h2" style={SERIF_H2}>
              Add a wallet by hand.
            </h2>
          </div>
          <div>
            <div className="styx-panel styx-sweep">
              <div className="styx-panel-head">
                <p className="styx-overline">No request needed</p>
                {/* A real <h3>: it sits under the section's <h2>, and as a
                    heading it takes SERIF_H3 like every other heading here
                    instead of getting the serif by accident. */}
                <h3 className="styx-h3" style={{ ...SERIF_H3, margin: "0.5rem 0 0" }}>
                  Approve an address directly.
                </h3>
              </div>
              <div className="styx-panel-body">
                <form onSubmit={handleAddManual}>
                  <div className="grid gap-5 sm:grid-cols-3">
                    <div className="styx-field">
                      <label className="styx-label" htmlFor="new-wallet">
                        Wallet address, required
                      </label>
                      <input
                        id="new-wallet"
                        className="styx-input styx-input-mono"
                        type="text"
                        value={newWallet}
                        onChange={(e) => setNewWallet(e.target.value)}
                        placeholder="7xK9f...8c2e"
                      />
                    </div>
                    <div className="styx-field">
                      <label className="styx-label" htmlFor="new-email">
                        Email
                      </label>
                      <input
                        id="new-email"
                        className="styx-input"
                        type="email"
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        placeholder="dev@example.com"
                      />
                    </div>
                    <div className="styx-field">
                      <label className="styx-label" htmlFor="new-project">
                        Project
                      </label>
                      <input
                        id="new-project"
                        className="styx-input"
                        type="text"
                        value={newProject}
                        onChange={(e) => setNewProject(e.target.value)}
                        placeholder="Project name"
                      />
                    </div>
                  </div>

                  <div className="styx-btn-row" style={{ marginTop: "1.75rem" }}>
                    <button type="submit" className="styx-btn" disabled={!newWallet.trim()}>
                      <Plus size={14} aria-hidden="true" />
                      Add and approve
                    </button>
                  </div>
                </form>

                <p className="styx-note" style={{ marginTop: "1.5rem" }}>
                  Approving writes the wallet to the server list. It also emails the address
                  and posts to Discord, but only if the server has Resend or a Discord webhook
                  configured.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 03 · Pending ─────────────────────────────────────────────────── */}
      {whitelist.pending.length > 0 && (
        <section className="styx-section">
          <div className="styx-container styx-section-grid">
            <div className="styx-section-label">
              <span className="styx-numeral" aria-hidden="true">
                03
              </span>
              <p className="styx-index">Pending</p>
              <h2 className="styx-h2" style={SERIF_H2}>
                {whitelist.pending.length} waiting on a decision.
              </h2>
            </div>
            <div className="styx-table-wrap">
              <table className="styx-table">
                <thead>
                  <tr>
                    <th>Wallet</th>
                    <th>Email</th>
                    <th>Project</th>
                    <th style={{ textAlign: "right" }}>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {whitelist.pending.map((entry) => (
                    <tr key={entry.wallet}>
                      <td style={NOWRAP}>
                        <div className="flex items-center gap-2">
                          <span className="styx-mono" style={WALLET}>
                            {entry.wallet}
                          </span>
                          <button
                            type="button"
                            className="styx-btn-ghost"
                            style={BTN_ICON}
                            onClick={() => copyToClipboard(entry.wallet)}
                            title="Copy wallet address"
                            aria-label="Copy wallet address"
                          >
                            <Copy size={13} aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                      <td>{entry.email && <span className="styx-mono">{entry.email}</span>}</td>
                      <td>{entry.projectName && <span>{entry.projectName}</span>}</td>
                      <td style={ACTIONS}>
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            className="styx-btn-ghost"
                            style={BTN_SMALL}
                            onClick={() =>
                              handleApprove(entry.wallet, entry.email, entry.projectName)
                            }
                          >
                            <Check
                              size={13}
                              aria-hidden="true"
                              style={{ color: "var(--styx-accent)" }}
                            />
                            Approve
                          </button>
                          <button
                            type="button"
                            className="styx-btn-ghost"
                            style={BTN_SMALL}
                            onClick={() => handleReject(entry.wallet)}
                          >
                            <X size={13} aria-hidden="true" />
                            Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ── 04 · Approved ────────────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              04
            </span>
            <p className="styx-index">Approved</p>
            <h2 className="styx-h2" style={SERIF_H2}>
              Approved wallets.
            </h2>
            <p className="styx-note" style={{ marginTop: "1.1rem" }}>
              {whitelist.approved.length} on the list. Revoking deletes the row.
            </p>
          </div>
          <div>
            {whitelist.approved.length === 0 ? (
              <p className="styx-note">No approved wallets yet.</p>
            ) : (
              <div className="styx-table-wrap">
                <table className="styx-table">
                  <thead>
                    <tr>
                      <th>Wallet</th>
                      <th>Email</th>
                      <th>Project</th>
                      <th>Approved</th>
                      <th style={{ textAlign: "right" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {whitelist.approved.map((entry) => (
                      <tr key={entry.wallet}>
                        <td style={NOWRAP}>
                          <div className="flex items-center gap-2">
                            <span className="styx-mono" style={WALLET}>
                              {entry.wallet}
                            </span>
                            <button
                              type="button"
                              className="styx-btn-ghost"
                              style={BTN_ICON}
                              onClick={() => copyToClipboard(entry.wallet)}
                              title="Copy wallet address"
                              aria-label="Copy wallet address"
                            >
                              <Copy size={13} aria-hidden="true" />
                            </button>
                            <a
                              href={`https://solscan.io/account/${entry.wallet}?cluster=devnet`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="styx-btn-ghost"
                              style={BTN_ICON}
                              title="Open on Solscan, cluster devnet"
                              aria-label="Open on Solscan, cluster devnet"
                            >
                              <ExternalLink size={13} aria-hidden="true" />
                            </a>
                          </div>
                        </td>
                        <td>{entry.email && <span className="styx-mono">{entry.email}</span>}</td>
                        <td>{entry.projectName && <span>{entry.projectName}</span>}</td>
                        <td style={NOWRAP}>
                          <span className="styx-mono">
                            {new Date(entry.approvedAt).toLocaleDateString()}
                          </span>
                        </td>
                        <td style={ACTIONS}>
                          <button
                            type="button"
                            className="styx-btn-ghost"
                            style={BTN_SMALL}
                            onClick={() => handleRevoke(entry.wallet)}
                          >
                            <Trash2 size={13} aria-hidden="true" />
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── Foot ─────────────────────────────────────────────────────────── */}
      <div className="styx-container" style={{ paddingBottom: "3.5rem" }}>
        <div className="styx-footer-legal">
          <span>Styx Protocol &middot; internal tool, not a public page</span>
          <span>The list lives on the server. This tab holds only the password.</span>
        </div>
      </div>
    </StyxShell>
  );
}
