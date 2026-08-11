"use client";

/**
 * Waitlist admin dashboard.
 *
 * Auth: one secret field, sent both as `Authorization: Bearer` and as
 * `x-admin-password`, so either WAITLIST_STATS_TOKEN or ADMIN_PASSWORD works.
 * Data: /api/waitlist/stats + /api/waitlist/export?format=json.
 * Internal tool: English only, no i18n, mirrors /admin conventions.
 *
 * Presentation is Styx (app/_styx/styx.css) with `chrome={false}`: this page
 * supplies its own frame. It must not render the public header or footer — the
 * footer is what links here, and StyxFooter pulls in i18n this English-only tool
 * has no business loading.
 *
 * Careful when editing: below the login gate, `const t = stats?.totals`. That
 * `t` is the totals object, NOT the i18n translate function.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Lock,
  RefreshCw,
  Download,
  LogOut,
  Users,
  MailCheck,
  Hourglass,
  Percent,
  TrendingUp,
  AlertTriangle,
} from "lucide-react";
import StyxShell from "../../_styx/StyxShell";
import Reveal from "../../_styx/Reveal";

// Chart series: two hues only, both from the Styx palette. Paper carries the
// larger series, the cyan seal carries the subset that sits inside it. Both are
// legible and CVD-distinguishable on the #0d0d10 panel, and the legend repeats
// the identity in words so it is never colour-alone.
const CHART_SIGNUPS = "var(--styx-paper)";
const CHART_CONFIRMED = "var(--styx-accent)";

interface WaitlistRecordRow {
  email: string;
  status: "pending" | "confirmed";
  interest: "mobile" | "extension" | "sdk" | null;
  locale: string;
  source: string | null;
  country: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

interface DailyPoint {
  date: string;
  signups: number;
  confirmed: number;
}

interface StatsPayload {
  generatedAt: string;
  config: { kv: boolean; resend: boolean; emailFrom: string | null; siteUrl: string };
  totals: {
    signups: number;
    confirmed: number;
    pending: number;
    unsubscribed: number;
    mailFailures: number;
  };
  rates: { confirmationRate: number };
  last7d: { signups: number; confirmed: number };
  last30d: { signups: number; confirmed: number };
  daily: DailyPoint[];
  breakdown: {
    interest: Record<string, number>;
    locale: Record<string, number>;
    source: Record<string, number>;
    country: Record<string, number>;
  };
}

// FROZEN LITERAL. Renaming this silently logs the founder out and orphans the
// saved credential. The rebrand is visible copy only.
const STORAGE_KEY = "p01-wl-admin-key";

type InterestFilter = "all" | "mobile" | "extension" | "sdk" | "none";
type StatusFilter = "all" | "pending" | "confirmed";

const INTEREST_LABELS: Record<string, string> = {
  mobile: "Mobile app",
  extension: "Extension",
  sdk: "SDK",
};

function authHeaders(secret: string): HeadersInit {
  return { Authorization: `Bearer ${secret}`, "x-admin-password": secret };
}

/**
 * Flag image for an ISO alpha-2 code. Emoji flags do not render on Windows,
 * so this uses flagcdn's tiny PNGs (admin-only page, external fetch is fine).
 */
function Flag({ cc }: { cc: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://flagcdn.com/w20/${cc.toLowerCase()}.png`}
      alt={cc}
      title={cc}
      width={20}
      height={14}
      style={{
        display: "inline-block",
        border: "1px solid var(--styx-rule)",
        verticalAlign: "-2px",
      }}
    />
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Shared inline geometry (spacing only, never colour or type) ───────────

/** The action bar sits in a header row, so the buttons run tighter than a CTA. */
const ACTION_BTN: CSSProperties = { padding: "0.6rem 1.15rem" };

const MONO_CELL: CSSProperties = { fontFamily: "var(--styx-mono)" };

/**
 * Restores the serif voice on a REAL heading element.
 *
 * Measured 2026-08-11 in the browser: `.styx :is(h1, h2, h3, h4, h5, h6)` in
 * styx.css resets font-family/font-weight/letter-spacing, and because `:is()`
 * carries the specificity of its most specific argument, that selector scores
 * (0,1,1) while `.styx-h2` and `.styx-h3` score (0,1,0). The reset therefore
 * wins on any actual <h1>-<h6>, and `font-family: inherit` lands on Inter. The
 * kit only looks right because it demos the type scale on <p> elements.
 *
 * styx.css is a shared file and off limits here, so these headings re-assert the
 * very same tokens the classes already ask for. No new colour, no new font.
 * Reported upward: styx.css should lower that reset to `:where(...)`, which
 * scores (0,1,0) and would let every heading class win on its own.
 */
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

/** styx.css has no active/pressed chip variant. Composed from tokens only. */
function chipStyle(active: boolean): CSSProperties {
  return active
    ? {
        background: "transparent",
        cursor: "pointer",
        borderColor: "var(--styx-accent)",
        color: "var(--styx-paper)",
      }
    : { background: "transparent", cursor: "pointer" };
}

// ── KPI tile ─────────────────────────────────────────────────────────────

function Tile({
  icon: Icon,
  label,
  value,
  delay = 0,
}: {
  icon: typeof Users;
  label: string;
  value: string | number;
  delay?: number;
}) {
  return (
    <Reveal className="styx-card styx-reveal" delay={delay}>
      <p
        className="styx-card-label"
        style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
      >
        <Icon size={12} style={{ color: "var(--styx-faint)" }} aria-hidden />
        {label}
      </p>
      <p className="styx-card-value" style={{ margin: 0, fontSize: "2rem" }}>
        {value}
      </p>
    </Reveal>
  );
}

// ── Daily bar chart (30d, grouped: signups + confirmed) ──────────────────

function DailyChart({ daily }: { daily: DailyPoint[] }) {
  const [hover, setHover] = useState<{ i: number; px: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const W = 900;
  const H = 200;
  const PAD_L = 34;
  const PAD_R = 8;
  const PAD_T = 10;
  const PAD_B = 24;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const maxY = Math.max(1, ...daily.map((d) => d.signups));
  const slot = innerW / daily.length;
  const barW = Math.max(2, (slot - 5) / 2); // 2px gap inside the pair, ≥3px between groups

  const y = (v: number) => PAD_T + innerH - (v / maxY) * innerH;
  const gridSteps = [0.25, 0.5, 0.75, 1];

  return (
    <div className="styx-panel" style={{ position: "relative" }} ref={wrapRef}>
      <div
        className="styx-panel-head"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "0.75rem",
        }}
      >
        <p className="styx-overline">Signups per day &middot; last 30 days</p>
        {/* legend: 2 series, colour + text token (identity never colour-alone) */}
        <div style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
          <span
            className="styx-mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.45rem",
              fontSize: "0.6875rem",
            }}
          >
            <span
              style={{ width: "9px", height: "9px", background: CHART_SIGNUPS }}
              aria-hidden
            />
            Signups
          </span>
          <span
            className="styx-mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.45rem",
              fontSize: "0.6875rem",
            }}
          >
            <span
              style={{ width: "9px", height: "9px", background: CHART_CONFIRMED }}
              aria-hidden
            />
            Confirmed
          </span>
        </div>
      </div>

      <div className="styx-panel-body">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: "100%", height: "auto", display: "block" }}
          role="img"
          aria-label="Daily waitlist signups and confirmations, last 30 days"
          onMouseLeave={() => setHover(null)}
        >
          {/* recessive grid + y labels */}
          {gridSteps.map((s) => (
            <g key={s}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y(maxY * s)}
                y2={y(maxY * s)}
                strokeWidth={1}
                style={{ stroke: "var(--styx-rule-soft)" }}
              />
              <text
                x={PAD_L - 6}
                y={y(maxY * s) + 3}
                textAnchor="end"
                fontSize={9}
                style={{ fill: "var(--styx-faint)", fontFamily: "var(--styx-mono)" }}
              >
                {Math.round(maxY * s)}
              </text>
            </g>
          ))}
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={PAD_T + innerH}
            y2={PAD_T + innerH}
            strokeWidth={1}
            style={{ stroke: "var(--styx-rule)" }}
          />

          {daily.map((d, i) => {
            const gx = PAD_L + i * slot;
            const active = hover?.i === i;
            return (
              <g
                key={d.date}
                onMouseEnter={() => setHover({ i, px: ((gx + slot / 2) / W) * 100 })}
              >
                {/* hit target bigger than the marks */}
                <rect
                  x={gx}
                  y={PAD_T}
                  width={slot}
                  height={innerH}
                  style={{ fill: active ? "var(--styx-rule-soft)" : "transparent" }}
                />
                <rect
                  x={gx + (slot - (barW * 2 + 2)) / 2}
                  y={y(d.signups)}
                  width={barW}
                  height={Math.max(d.signups > 0 ? 1.5 : 0, PAD_T + innerH - y(d.signups))}
                  style={{ fill: CHART_SIGNUPS }}
                />
                <rect
                  x={gx + (slot - (barW * 2 + 2)) / 2 + barW + 2}
                  y={y(d.confirmed)}
                  width={barW}
                  height={Math.max(d.confirmed > 0 ? 1.5 : 0, PAD_T + innerH - y(d.confirmed))}
                  style={{ fill: CHART_CONFIRMED }}
                />
                {/* sparse x labels: every 7th day + last */}
                {(i % 7 === 0 || i === daily.length - 1) && (
                  <text
                    x={gx + slot / 2}
                    y={H - 8}
                    textAnchor="middle"
                    fontSize={9}
                    style={{ fill: "var(--styx-faint)", fontFamily: "var(--styx-mono)" }}
                  >
                    {d.date.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {hover && daily[hover.i] && (
        <div
          className="styx-panel styx-mono"
          style={{
            position: "absolute",
            left: `clamp(4px, ${hover.px}%, calc(100% - 140px))`,
            bottom: "3.2rem",
            zIndex: 10,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            padding: "0.5rem 0.8rem",
            background: "var(--styx-panel-2)",
            fontSize: "0.6875rem",
            lineHeight: 1.6,
          }}
        >
          <div style={{ color: "var(--styx-faint)", marginBottom: "0.15rem" }}>
            {daily[hover.i].date}
          </div>
          <div style={{ color: "var(--styx-paper)" }}>
            <span style={{ color: CHART_SIGNUPS }}>■</span> signups{" "}
            {daily[hover.i].signups}
          </div>
          <div style={{ color: "var(--styx-paper)" }}>
            <span style={{ color: CHART_CONFIRMED }}>■</span> confirmed{" "}
            {daily[hover.i].confirmed}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Band heading: the marginal numeral, sized for a dashboard ─────────────

function BandHead({
  numeral,
  index,
  title,
}: {
  numeral: string;
  index: string;
  title: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "1.25rem",
        marginBottom: "2rem",
      }}
    >
      <span
        className="styx-numeral"
        aria-hidden="true"
        style={{ fontSize: "2.75rem", margin: 0, flex: "none" }}
      >
        {numeral}
      </span>
      <div>
        <p className="styx-index">{index}</p>
        <h2 className="styx-h3" style={{ ...SERIF_H3, margin: "0.4rem 0 0" }}>
          {title}
        </h2>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function WaitlistAdminPage() {
  const [secret, setSecret] = useState("");
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [records, setRecords] = useState<WaitlistRecordRow[]>([]);

  const [interestFilter, setInterestFilter] = useState<InterestFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [sortAsc, setSortAsc] = useState(false);

  const fetchAll = useCallback(async (key: string) => {
    setLoading(true);
    setError("");
    try {
      const [statsRes, recordsRes] = await Promise.all([
        fetch("/api/waitlist/stats", { headers: authHeaders(key) }),
        fetch("/api/waitlist/export?format=json", { headers: authHeaders(key) }),
      ]);
      if (statsRes.status === 401 || recordsRes.status === 401) {
        setConnected(false);
        localStorage.removeItem(STORAGE_KEY);
        setError("Invalid key");
        return;
      }
      if (!statsRes.ok || !recordsRes.ok) {
        // Covers a real outage AND the API's 503 "not_configured", which is a
        // missing server secret rather than an outage. One branch, honest words.
        setError(
          "No answer from the stats API: it may be unreachable, or the server may have no stats token or admin password set.",
        );
        return;
      }
      const s = (await statsRes.json()) as StatsPayload;
      const r = (await recordsRes.json()) as { records: WaitlistRecordRow[] };
      setStats(s);
      setRecords(r.records);
      setConnected(true);
      localStorage.setItem(STORAGE_KEY, key);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-reconnect with a stored key
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setSecret(saved);
      fetchAll(saved);
    }
  }, [fetchAll]);

  const downloadCsv = useCallback(async () => {
    const res = await fetch("/api/waitlist/export", { headers: authHeaders(secret) });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `waitlist-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [secret]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setConnected(false);
    setSecret("");
    setStats(null);
    setRecords([]);
  }, []);

  const interestCounts = useMemo(() => {
    const c: Record<InterestFilter, number> = { all: records.length, mobile: 0, extension: 0, sdk: 0, none: 0 };
    for (const r of records) {
      if (r.interest === "mobile") c.mobile++;
      else if (r.interest === "extension") c.extension++;
      else if (r.interest === "sdk") c.sdk++;
      else c.none++;
    }
    return c;
  }, [records]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = records.filter((r) => {
      if (interestFilter === "none" && r.interest !== null) return false;
      if (interestFilter !== "all" && interestFilter !== "none" && r.interest !== interestFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (
        q &&
        !r.email.includes(q) &&
        !(r.source ?? "").includes(q) &&
        !(r.country ?? "").toLowerCase().includes(q)
      )
        return false;
      return true;
    });
    rows.sort((a, b) =>
      sortAsc
        ? a.createdAt.localeCompare(b.createdAt)
        : b.createdAt.localeCompare(a.createdAt),
    );
    return rows;
  }, [records, interestFilter, statusFilter, search, sortAsc]);

  // ── Login gate ──────────────────────────────────────────────────────────
  if (!connected) {
    return (
      <StyxShell chrome={false}>
        <section className="styx-container-narrow styx-hero">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (secret.trim()) fetchAll(secret.trim());
            }}
            className="styx-panel styx-sweep"
            style={{ maxWidth: "27rem", marginInline: "auto" }}
          >
            <div className="styx-panel-head">
              <p className="styx-overline">Styx Protocol &middot; Admin</p>
              <h1
                className="styx-h3"
                style={{
                  ...SERIF_H3,
                  display: "flex",
                  alignItems: "center",
                  gap: "0.55rem",
                  margin: "0.55rem 0 0",
                }}
              >
                <Lock size={16} style={{ color: "var(--styx-faint)" }} aria-hidden />
                Waitlist admin
              </h1>
            </div>
            <div className="styx-panel-body styx-stack">
              <div className="styx-field">
                <label className="styx-label" htmlFor="wl-admin-key">
                  Stats token or admin password
                </label>
                <input
                  id="wl-admin-key"
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="current-password"
                  className="styx-input styx-input-mono"
                />
              </div>
              {error && <p className="styx-form-error">{error}</p>}
              <button
                type="submit"
                disabled={loading || !secret.trim()}
                className="styx-btn"
              >
                {loading ? "Connecting" : "Connect"}
              </button>
            </div>
          </form>
        </section>
      </StyxShell>
    );
  }

  const t = stats?.totals;
  const rate = stats ? Math.round(stats.rates.confirmationRate * 1000) / 10 : 0;

  // ── Dashboard ───────────────────────────────────────────────────────────
  return (
    <StyxShell chrome={false}>
      {/* header */}
      <section
        className="styx-container"
        style={{ paddingBlock: "clamp(2.5rem, 6vw, 4rem) clamp(1.75rem, 4vw, 2.5rem)" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "1.5rem",
          }}
        >
          <div>
            <p className="styx-overline">Styx Protocol &middot; Admin</p>
            <h1 className="styx-h2" style={{ ...SERIF_H2, margin: "0.5rem 0 0" }}>
              <span className="styx-gleam">Waitlist</span>
            </h1>
          </div>
          <div className="styx-btn-row">
            <button
              type="button"
              onClick={() => fetchAll(secret)}
              className="styx-btn-ghost"
              style={ACTION_BTN}
              title="Refresh"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} aria-hidden />
              Refresh
            </button>
            <button
              type="button"
              onClick={downloadCsv}
              className="styx-btn"
              style={ACTION_BTN}
              title="Download CSV"
            >
              <Download size={12} aria-hidden />
              CSV
            </button>
            <button
              type="button"
              onClick={disconnect}
              className="styx-btn-ghost"
              style={ACTION_BTN}
              title="Disconnect"
            >
              <LogOut size={12} aria-hidden />
              Exit
            </button>
          </div>
        </div>

        <div className="styx-gleam-rule" aria-hidden="true" style={{ marginTop: "2rem" }} />

        {/* config warnings */}
        {stats && (!stats.config.kv || !stats.config.resend || (t && t.mailFailures > 0)) && (
          <div className="styx-admission" style={{ marginTop: "2rem" }}>
            <p className="styx-admission-title">
              <AlertTriangle
                size={12}
                aria-hidden
                style={{ verticalAlign: "-2px", marginRight: "0.45rem" }}
              />
              Configuration
            </p>
            <p
              className="styx-admission-body"
              style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem 1rem" }}
            >
              {!stats.config.kv && <span>KV not configured.</span>}
              {!stats.config.resend && <span>Resend not configured.</span>}
              {t && t.mailFailures > 0 && <span>{t.mailFailures} mail send failure(s).</span>}
            </p>
          </div>
        )}
      </section>

      {/* totals + chart */}
      <section
        className="styx-section"
        style={{ paddingBlock: "clamp(2.5rem, 5vw, 3.5rem)" }}
      >
        <div className="styx-container">
          <BandHead numeral="01" index="Totals" title="Signups and confirmations." />

          <div className="styx-grid styx-grid-3">
            <Tile icon={Users} label="Signups" value={t?.signups ?? 0} />
            <Tile icon={MailCheck} label="Confirmed" value={t?.confirmed ?? 0} delay={60} />
            <Tile icon={Hourglass} label="Pending" value={t?.pending ?? 0} delay={120} />
            <Tile
              icon={Percent}
              label="Confirmation rate"
              value={`${rate}%`}
              delay={180}
            />
            <Tile
              icon={TrendingUp}
              label="Last 7 days"
              value={stats?.last7d.signups ?? 0}
              delay={240}
            />
            <Tile
              icon={Users}
              label="Unsubscribed"
              value={t?.unsubscribed ?? 0}
              delay={300}
            />
          </div>

          {/* chart */}
          {stats && (
            <div style={{ marginTop: "2rem" }}>
              <DailyChart daily={stats.daily} />
            </div>
          )}
        </div>
      </section>

      {/* entries */}
      <section
        className="styx-section styx-section-alt"
        style={{ paddingBlock: "clamp(2.5rem, 5vw, 3.5rem)" }}
      >
        <div className="styx-container">
          <BandHead numeral="02" index="Entries" title="Every row the export returns." />

          {/* filters */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "0.6rem",
              marginBottom: "1.25rem",
            }}
          >
            {(
              [
                ["all", `All ${interestCounts.all}`],
                ["mobile", `Mobile ${interestCounts.mobile}`],
                ["extension", `Extension ${interestCounts.extension}`],
                ["sdk", `SDK ${interestCounts.sdk}`],
                ["none", `No pick ${interestCounts.none}`],
              ] as [InterestFilter, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className="styx-chip"
                aria-pressed={interestFilter === k}
                style={chipStyle(interestFilter === k)}
                onClick={() => setInterestFilter(k)}
              >
                {label}
              </button>
            ))}
            <span
              aria-hidden
              style={{
                width: "1px",
                height: "1.25rem",
                background: "var(--styx-rule)",
                marginInline: "0.3rem",
              }}
            />
            {(
              [
                ["all", "Any status"],
                ["pending", "Pending"],
                ["confirmed", "Confirmed"],
              ] as [StatusFilter, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className="styx-chip"
                aria-pressed={statusFilter === k}
                style={chipStyle(statusFilter === k)}
                onClick={() => setStatusFilter(k)}
              >
                {label}
              </button>
            ))}
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search email, source or country"
              aria-label="Search email, source or country"
              className="styx-input styx-input-mono"
              style={{
                marginLeft: "auto",
                width: "15rem",
                padding: "0.5rem 0.8rem",
              }}
            />
          </div>

          {/* table */}
          <div className="styx-table-wrap">
            <table className="styx-table" style={{ minWidth: "800px" }}>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Interest</th>
                  <th>Locale</th>
                  <th>Country</th>
                  <th>Source</th>
                  <th
                    onClick={() => setSortAsc((v) => !v)}
                    title="Toggle sort"
                    aria-sort={sortAsc ? "ascending" : "descending"}
                    style={{ cursor: "pointer", userSelect: "none" }}
                  >
                    Signed up {sortAsc ? "(oldest)" : "(newest)"}
                  </th>
                  <th>Confirmed at</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.email}>
                    <td style={{ ...MONO_CELL, color: "var(--styx-paper)" }}>{r.email}</td>
                    <td>
                      {r.status === "confirmed" ? (
                        <span className="styx-chip">
                          <span className="styx-dot" aria-hidden />
                          confirmed
                        </span>
                      ) : (
                        <span className="styx-chip">pending</span>
                      )}
                    </td>
                    <td>
                      {r.interest ? (
                        INTEREST_LABELS[r.interest]
                      ) : (
                        <span style={{ color: "var(--styx-faint)" }}>–</span>
                      )}
                    </td>
                    <td style={{ ...MONO_CELL, textTransform: "uppercase" }}>{r.locale}</td>
                    <td style={MONO_CELL}>
                      {r.country ? (
                        <Flag cc={r.country} />
                      ) : (
                        <span style={{ color: "var(--styx-faint)" }}>–</span>
                      )}
                    </td>
                    <td style={MONO_CELL}>{r.source ?? ""}</td>
                    <td style={{ ...MONO_CELL, whiteSpace: "nowrap" }}>
                      {fmtDate(r.createdAt)}
                    </td>
                    <td style={{ ...MONO_CELL, whiteSpace: "nowrap" }}>
                      {fmtDate(r.confirmedAt)}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={8}
                      className="styx-note styx-center"
                      style={{ paddingBlock: "2.75rem" }}
                    >
                      No entries match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <p className="styx-note" style={{ ...MONO_CELL, marginTop: "1.25rem" }}>
            {stats ? `Generated ${fmtDate(stats.generatedAt)} · ${filtered.length}/${records.length} rows shown` : ""}
          </p>
        </div>
      </section>
    </StyxShell>
  );
}
