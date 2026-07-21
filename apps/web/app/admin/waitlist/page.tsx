"use client";

/**
 * Waitlist admin dashboard.
 *
 * Auth: one secret field, sent both as `Authorization: Bearer` and as
 * `x-admin-password`, so either WAITLIST_STATS_TOKEN or ADMIN_PASSWORD works.
 * Data: /api/waitlist/stats + /api/waitlist/export?format=json.
 * Internal tool: English only, no i18n, mirrors /admin conventions.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// Chart series colors validated for CVD + contrast on the dark surface
// (dataviz check: brand cyan #39c5bb is too light for bars; #2aa89e is the
// nearest passing step; #ff2d7a passes as-is).
const CHART_CYAN = "#2aa89e";
const CHART_PINK = "#ff2d7a";

interface WaitlistRecordRow {
  email: string;
  status: "pending" | "confirmed";
  interest: "mobile" | "extension" | "sdk" | null;
  locale: string;
  source: string | null;
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
  };
}

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

// ── KPI tile ─────────────────────────────────────────────────────────────

function Tile({
  icon: Icon,
  label,
  value,
  accent = "#ffffff",
}: {
  icon: typeof Users;
  label: string;
  value: string | number;
  accent?: string;
}) {
  return (
    <div className="bg-[#0f0f12] border border-[#2a2a30] p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={13} style={{ color: accent }} aria-hidden />
        <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[#555560]">
          {label}
        </span>
      </div>
      <div className="text-2xl font-bold" style={{ color: accent }}>
        {value}
      </div>
    </div>
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
    <div className="bg-[#0f0f12] border border-[#2a2a30] p-4 relative" ref={wrapRef}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[#555560]">
          Signups per day · last 30 days
        </span>
        {/* legend: 2 series, color + text token (identity never color-alone) */}
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-[11px] text-[#888892]">
            <span className="w-2.5 h-2.5" style={{ background: CHART_CYAN }} aria-hidden />
            Signups
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-[#888892]">
            <span className="w-2.5 h-2.5" style={{ background: CHART_PINK }} aria-hidden />
            Confirmed
          </span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto block"
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
              stroke="#1c1c22"
              strokeWidth={1}
            />
            <text
              x={PAD_L - 6}
              y={y(maxY * s) + 3}
              textAnchor="end"
              fontSize={9}
              fontFamily="monospace"
              fill="#555560"
            >
              {Math.round(maxY * s)}
            </text>
          </g>
        ))}
        <line x1={PAD_L} x2={W - PAD_R} y1={PAD_T + innerH} y2={PAD_T + innerH} stroke="#2a2a30" strokeWidth={1} />

        {daily.map((d, i) => {
          const gx = PAD_L + i * slot;
          const active = hover?.i === i;
          return (
            <g
              key={d.date}
              onMouseEnter={() => setHover({ i, px: ((gx + slot / 2) / W) * 100 })}
            >
              {/* hit target bigger than the marks */}
              <rect x={gx} y={PAD_T} width={slot} height={innerH} fill={active ? "#ffffff08" : "transparent"} />
              <rect
                x={gx + (slot - (barW * 2 + 2)) / 2}
                y={y(d.signups)}
                width={barW}
                height={Math.max(d.signups > 0 ? 1.5 : 0, PAD_T + innerH - y(d.signups))}
                fill={CHART_CYAN}
              />
              <rect
                x={gx + (slot - (barW * 2 + 2)) / 2 + barW + 2}
                y={y(d.confirmed)}
                width={barW}
                height={Math.max(d.confirmed > 0 ? 1.5 : 0, PAD_T + innerH - y(d.confirmed))}
                fill={CHART_PINK}
              />
              {/* sparse x labels: every 7th day + last */}
              {(i % 7 === 0 || i === daily.length - 1) && (
                <text
                  x={gx + slot / 2}
                  y={H - 8}
                  textAnchor="middle"
                  fontSize={9}
                  fontFamily="monospace"
                  fill="#555560"
                >
                  {d.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {hover && daily[hover.i] && (
        <div
          className="absolute pointer-events-none bg-[#151518] border border-[#2a2a30] px-3 py-2 text-[11px] font-mono z-10 whitespace-nowrap"
          style={{
            left: `clamp(4px, ${hover.px}%, calc(100% - 140px))`,
            bottom: "3.2rem",
          }}
        >
          <div className="text-[#888892] mb-1">{daily[hover.i].date}</div>
          <div className="text-white">
            <span style={{ color: CHART_CYAN }}>■</span> signups {daily[hover.i].signups}
          </div>
          <div className="text-white">
            <span style={{ color: CHART_PINK }}>■</span> confirmed {daily[hover.i].confirmed}
          </div>
        </div>
      )}
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
        setError("Backend unavailable");
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
      if (q && !r.email.includes(q) && !(r.source ?? "").includes(q)) return false;
      return true;
    });
    rows.sort((a, b) =>
      sortAsc
        ? a.createdAt.localeCompare(b.createdAt)
        : b.createdAt.localeCompare(a.createdAt),
    );
    return rows;
  }, [records, interestFilter, statusFilter, search, sortAsc]);

  const chip = (active: boolean) =>
    `px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider border transition-colors cursor-pointer ${
      active
        ? "border-[#39c5bb] text-[#39c5bb] bg-[#39c5bb]/10"
        : "border-[#2a2a30] text-[#555560] hover:text-[#888892] hover:border-[#3a3a42]"
    }`;

  // ── Login gate ──────────────────────────────────────────────────────────
  if (!connected) {
    return (
      <main className="min-h-screen bg-[#0a0a0c] text-white flex items-center justify-center px-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (secret.trim()) fetchAll(secret.trim());
          }}
          className="w-full max-w-sm bg-[#0f0f12] border border-[#2a2a30] p-8"
        >
          <div className="flex items-center gap-2 mb-6">
            <Lock size={16} className="text-[#39c5bb]" aria-hidden />
            <h1 className="text-sm font-mono uppercase tracking-[0.2em] text-[#888892]">
              Waitlist admin
            </h1>
          </div>
          <label htmlFor="wl-admin-key" className="block text-[10px] font-mono uppercase tracking-[0.18em] text-[#555560] mb-2">
            Stats token or admin password
          </label>
          <input
            id="wl-admin-key"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="current-password"
            className="w-full bg-[#0a0a0c] border border-[#2a2a30] focus:border-[#39c5bb] focus:outline-none text-white font-mono text-sm px-4 py-3 mb-3"
          />
          {error && <p className="text-xs font-mono text-[#ff2d7a] mb-3">{error}</p>}
          <button
            type="submit"
            disabled={loading || !secret.trim()}
            className="w-full px-6 py-3 bg-[#39c5bb] text-[#0a0a0c] font-bold uppercase tracking-wider text-sm hover:bg-[#2a9d95] transition-colors disabled:opacity-60"
          >
            {loading ? "Connecting" : "Connect"}
          </button>
        </form>
      </main>
    );
  }

  const t = stats?.totals;
  const rate = stats ? Math.round(stats.rates.confirmationRate * 1000) / 10 : 0;

  // ── Dashboard ───────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-[#0a0a0c] text-white px-4 sm:px-8 py-8">
      <div className="max-w-6xl mx-auto">
        {/* header */}
        <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[#39c5bb]">
              PROTOCOL::01 // ADMIN
            </p>
            <h1 className="text-xl font-bold mt-1">Waitlist</h1>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => fetchAll(secret)} className={chip(false)} title="Refresh">
              <span className="inline-flex items-center gap-1.5">
                <RefreshCw size={12} className={loading ? "animate-spin" : ""} aria-hidden /> Refresh
              </span>
            </button>
            <button onClick={downloadCsv} className={chip(false)} title="Download CSV">
              <span className="inline-flex items-center gap-1.5">
                <Download size={12} aria-hidden /> CSV
              </span>
            </button>
            <button onClick={disconnect} className={chip(false)} title="Disconnect">
              <span className="inline-flex items-center gap-1.5">
                <LogOut size={12} aria-hidden /> Exit
              </span>
            </button>
          </div>
        </div>

        {/* config warnings */}
        {stats && (!stats.config.kv || !stats.config.resend || (t && t.mailFailures > 0)) && (
          <div className="flex items-center gap-2 border border-[#ffcc00]/40 bg-[#ffcc00]/5 px-4 py-3 mb-6 text-xs font-mono text-[#ffcc00]">
            <AlertTriangle size={14} aria-hidden />
            {!stats.config.kv && <span>KV not configured.</span>}
            {!stats.config.resend && <span>Resend not configured.</span>}
            {t && t.mailFailures > 0 && <span>{t.mailFailures} mail send failure(s).</span>}
          </div>
        )}

        {/* KPI tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          <Tile icon={Users} label="Signups" value={t?.signups ?? 0} />
          <Tile icon={MailCheck} label="Confirmed" value={t?.confirmed ?? 0} accent="#39c5bb" />
          <Tile icon={Hourglass} label="Pending" value={t?.pending ?? 0} accent="#ffcc00" />
          <Tile icon={Percent} label="Conversion" value={`${rate}%`} accent="#39c5bb" />
          <Tile icon={TrendingUp} label="Last 7 days" value={stats?.last7d.signups ?? 0} />
          <Tile icon={Users} label="Unsubscribed" value={t?.unsubscribed ?? 0} accent="#888892" />
        </div>

        {/* chart */}
        {stats && <DailyChart daily={stats.daily} />}

        {/* filters */}
        <div className="flex items-center gap-2 flex-wrap mt-6 mb-3">
          {(
            [
              ["all", `All ${interestCounts.all}`],
              ["mobile", `Mobile ${interestCounts.mobile}`],
              ["extension", `Extension ${interestCounts.extension}`],
              ["sdk", `SDK ${interestCounts.sdk}`],
              ["none", `No pick ${interestCounts.none}`],
            ] as [InterestFilter, string][]
          ).map(([k, label]) => (
            <button key={k} className={chip(interestFilter === k)} onClick={() => setInterestFilter(k)}>
              {label}
            </button>
          ))}
          <span className="w-px h-5 bg-[#2a2a30] mx-1" aria-hidden />
          {(
            [
              ["all", "Any status"],
              ["pending", "Pending"],
              ["confirmed", "Confirmed"],
            ] as [StatusFilter, string][]
          ).map(([k, label]) => (
            <button key={k} className={chip(statusFilter === k)} onClick={() => setStatusFilter(k)}>
              {label}
            </button>
          ))}
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search email or source"
            aria-label="Search email or source"
            className="ml-auto bg-[#0f0f12] border border-[#2a2a30] focus:border-[#39c5bb] focus:outline-none text-white font-mono text-xs px-3 py-2 w-56"
          />
        </div>

        {/* table */}
        <div className="overflow-x-auto border border-[#2a2a30]">
          <table className="w-full text-left text-sm min-w-[720px]">
            <thead>
              <tr className="bg-[#0f0f12] text-[10px] font-mono uppercase tracking-[0.18em] text-[#555560]">
                <th className="px-4 py-3 font-normal">Email</th>
                <th className="px-4 py-3 font-normal">Status</th>
                <th className="px-4 py-3 font-normal">Interest</th>
                <th className="px-4 py-3 font-normal">Locale</th>
                <th className="px-4 py-3 font-normal">Source</th>
                <th
                  className="px-4 py-3 font-normal cursor-pointer select-none hover:text-[#888892]"
                  onClick={() => setSortAsc((v) => !v)}
                  title="Toggle sort"
                >
                  Signed up {sortAsc ? "(oldest)" : "(newest)"}
                </th>
                <th className="px-4 py-3 font-normal">Confirmed at</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.email} className="border-t border-[#1c1c22] hover:bg-[#0f0f12]">
                  <td className="px-4 py-3 font-mono text-xs text-white">{r.email}</td>
                  <td className="px-4 py-3">
                    {r.status === "confirmed" ? (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[#39c5bb]">
                        <span className="w-1.5 h-1.5 bg-[#39c5bb]" aria-hidden /> confirmed
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[#ffcc00]">
                        <span className="w-1.5 h-1.5 bg-[#ffcc00]" aria-hidden /> pending
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-[#b8b8c0]">
                    {r.interest ? INTEREST_LABELS[r.interest] : <span className="text-[#555560]">–</span>}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-[#888892] uppercase">{r.locale}</td>
                  <td className="px-4 py-3 text-xs font-mono text-[#888892]">{r.source ?? ""}</td>
                  <td className="px-4 py-3 text-xs font-mono text-[#888892]">{fmtDate(r.createdAt)}</td>
                  <td className="px-4 py-3 text-xs font-mono text-[#888892]">{fmtDate(r.confirmedAt)}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-xs font-mono text-[#555560]">
                    No entries match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[10px] font-mono text-[#3a3a42] mt-4">
          {stats ? `Generated ${fmtDate(stats.generatedAt)} · ${filtered.length}/${records.length} rows shown` : ""}
        </p>
      </div>
    </main>
  );
}
