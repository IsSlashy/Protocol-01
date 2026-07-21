/**
 * Bi-weekly waitlist digest.
 *
 * Everything is derived from the stats payload (30 days of daily points) and
 * the live record set, so the report needs no extra storage beyond the
 * "last sent" anchor. The period is compared against the one before it, which
 * is the whole point of a recurring digest: direction, not just a number.
 */
import type { WaitlistRecord, WaitlistStats } from './store';

const MONO = "'Courier New', Courier, monospace";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const CYAN = '#2aa89e';
const PINK = '#ff2d7a';

const INTEREST_LABELS: Record<string, string> = {
  mobile: 'Mobile app',
  extension: 'Chrome extension',
  sdk: 'SDK',
};

export interface ReportPeriod {
  days: number;
  signups: number;
  confirmed: number;
  prevSignups: number;
  prevConfirmed: number;
}

function sum(points: { signups: number; confirmed: number }[], key: 'signups' | 'confirmed'): number {
  return points.reduce((acc, p) => acc + p[key], 0);
}

/** Count occurrences of a field over the live records, sorted desc. */
function tally(records: WaitlistRecord[], pick: (r: WaitlistRecord) => string | undefined): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const key = pick(r);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** "+3 (+150%)" / "-2 (-40%)" / "no change". Percentages need a non-zero base. */
function deltaLabel(current: number, previous: number): string {
  const diff = current - previous;
  if (diff === 0) return 'no change vs previous period';
  const sign = diff > 0 ? '+' : '';
  if (previous === 0) return `${sign}${diff} vs previous period`;
  const pct = Math.round((diff / previous) * 100);
  return `${sign}${diff} (${sign}${pct}%) vs previous period`;
}

function statCell(label: string, value: string | number, color: string): string {
  return `
    <td width="33%" style="padding: 14px 10px; background: #0f0f12; border: 1px solid #2a2a30;" align="center">
      <div style="font-family: ${MONO}; font-size: 9px; letter-spacing: 2px; color: #555560; text-transform: uppercase;">${label}</div>
      <div style="font-family: ${SANS}; font-size: 24px; font-weight: 800; color: ${color}; padding-top: 6px;">${value}</div>
    </td>`;
}

/** One horizontal bar per day, table-based so every mail client renders it. */
function dailyBars(points: { date: string; signups: number }[]): string {
  const max = Math.max(1, ...points.map((p) => p.signups));
  const rows = points
    .map((p) => {
      const pct = Math.round((p.signups / max) * 100);
      const bar =
        p.signups > 0
          ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
               <td width="${pct}%" style="background: ${CYAN}; font-size: 0; line-height: 0;" height="8">&nbsp;</td>
               <td style="font-size: 0; line-height: 0;">&nbsp;</td>
             </tr></table>`
          : `<div style="height: 8px; border-bottom: 1px solid #1c1c22;"></div>`;
      return `
        <tr>
          <td width="52" style="font-family: ${MONO}; font-size: 10px; color: #555560; padding: 3px 0;">${p.date.slice(5)}</td>
          <td style="padding: 3px 8px;">${bar}</td>
          <td width="26" align="right" style="font-family: ${MONO}; font-size: 10px; color: #888892; padding: 3px 0;">${p.signups}</td>
        </tr>`;
    })
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows}</table>`;
}

function breakdownRows(entries: [string, number][], total: number, label: (k: string) => string): string {
  if (entries.length === 0) {
    return `<tr><td style="font-family: ${SANS}; font-size: 13px; color: #555560; padding: 4px 0;">No data yet</td></tr>`;
  }
  return entries
    .map(([key, n]) => {
      const pct = total > 0 ? Math.round((n / total) * 100) : 0;
      return `
        <tr>
          <td style="font-family: ${SANS}; font-size: 13px; color: #b8b8c0; padding: 5px 0;">${label(key)}</td>
          <td align="right" style="font-family: ${MONO}; font-size: 12px; color: #888892; padding: 5px 0;">${n} · ${pct}%</td>
        </tr>`;
    })
    .join('');
}

export interface BuiltReport {
  subject: string;
  html: string;
  text: string;
  period: ReportPeriod;
}

export function buildReport(
  stats: WaitlistStats,
  records: WaitlistRecord[],
  opts: { days?: number; dashboardUrl: string },
): BuiltReport {
  const days = opts.days ?? 14;
  const daily = stats.daily;
  const current = daily.slice(-days);
  const previous = daily.slice(-days * 2, -days);

  const period: ReportPeriod = {
    days,
    signups: sum(current, 'signups'),
    confirmed: sum(current, 'confirmed'),
    prevSignups: sum(previous, 'signups'),
    prevConfirmed: sum(previous, 'confirmed'),
  };

  const live = records.length;
  const confirmedLive = records.filter((r) => r.status === 'confirmed').length;
  const periodRate =
    period.signups > 0 ? Math.round((period.confirmed / period.signups) * 100) : 0;

  const interests = tally(records, (r) => r.interest);
  const countries = tally(records, (r) => r.country).slice(0, 5);
  const sources = tally(records, (r) => r.source).slice(0, 5);

  const from = current[0]?.date ?? '';
  const to = current[current.length - 1]?.date ?? '';
  const subject = `Protocol 01 waitlist: ${period.signups} new signup${period.signups === 1 ? '' : 's'} in ${days} days`;

  const html = `
  <div style="background: #060608; padding: 32px 12px; font-family: ${SANS};">
    <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">${period.signups} new signups, ${period.confirmed} confirmed. ${deltaLabel(period.signups, period.prevSignups)}.</div>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0 auto;">
      <tr>
        <td style="padding: 8px 4px 20px 4px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td style="font-family: ${MONO}; font-size: 11px; letter-spacing: 4px; color: ${CYAN}; text-transform: uppercase;">PROTOCOL::01</td>
              <td align="right" style="font-family: ${MONO}; font-size: 11px; letter-spacing: 2px; color: #555560;">SYS//DIGEST</td>
            </tr>
          </table>
        </td>
      </tr>

      <tr>
        <td style="background: #0a0a0c; border: 1px solid #2a2a30; border-top: 2px solid ${CYAN}; padding: 28px;">
          <h1 style="margin: 0 0 4px 0; font-family: ${SANS}; font-size: 22px; font-weight: 800; color: #ffffff;">Waitlist digest</h1>
          <p style="margin: 0 0 24px 0; font-family: ${MONO}; font-size: 11px; color: #555560; letter-spacing: 1px;">${from} to ${to} · ${days} days</p>

          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: separate; border-spacing: 6px 0;">
            <tr>
              ${statCell('New signups', period.signups, '#ffffff')}
              ${statCell('Confirmed', period.confirmed, CYAN)}
              ${statCell('Conversion', `${periodRate}%`, periodRate >= 50 ? CYAN : '#ffcc00')}
            </tr>
          </table>

          <p style="margin: 18px 0 28px 0; font-family: ${SANS}; font-size: 13px; color: #888892;">
            Signups: ${deltaLabel(period.signups, period.prevSignups)}.<br>
            Confirmations: ${deltaLabel(period.confirmed, period.prevConfirmed)}.
          </p>

          <h2 style="margin: 0 0 12px 0; font-family: ${MONO}; font-size: 11px; letter-spacing: 2px; color: ${CYAN}; text-transform: uppercase;">Daily signups</h2>
          ${dailyBars(current)}

          <h2 style="margin: 28px 0 8px 0; font-family: ${MONO}; font-size: 11px; letter-spacing: 2px; color: ${CYAN}; text-transform: uppercase;">What they want</h2>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${breakdownRows(interests, live, (k) => INTEREST_LABELS[k] ?? k)}
          </table>

          <h2 style="margin: 24px 0 8px 0; font-family: ${MONO}; font-size: 11px; letter-spacing: 2px; color: ${CYAN}; text-transform: uppercase;">Top countries</h2>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${breakdownRows(countries, live, (k) => k)}
          </table>

          <h2 style="margin: 24px 0 8px 0; font-family: ${MONO}; font-size: 11px; letter-spacing: 2px; color: ${CYAN}; text-transform: uppercase;">Where they came from</h2>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${breakdownRows(sources, live, (k) => k)}
          </table>

          <div style="margin-top: 28px; padding-top: 20px; border-top: 1px solid #1c1c22;">
            <p style="margin: 0 0 16px 0; font-family: ${SANS}; font-size: 13px; color: #888892;">
              All time: <strong style="color: #ffffff;">${live}</strong> on the list, ${confirmedLive} confirmed,
              ${stats.totals.pending} pending, ${stats.totals.unsubscribed} removed.
              ${stats.totals.mailFailures > 0 ? `<span style="color: ${PINK};">${stats.totals.mailFailures} mail failures.</span>` : ''}
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td bgcolor="${CYAN}" style="border: 1px solid ${CYAN};">
                  <a href="${opts.dashboardUrl}" style="display: inline-block; padding: 12px 28px; font-family: ${SANS}; font-size: 13px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; color: #0a0a0c; text-decoration: none;">Open dashboard</a>
                </td>
              </tr>
            </table>
          </div>
        </td>
      </tr>

      <tr>
        <td style="padding: 24px 8px 8px 8px; text-align: center;">
          <p style="margin: 0; font-family: ${MONO}; font-size: 10px; letter-spacing: 2px; color: #3a3a42;">
            PROTOCOL 01 // © 2026 VOLTA TEAM<br>Automated digest, every ${days} days.
          </p>
        </td>
      </tr>
    </table>
  </div>`;

  const text = [
    `PROTOCOL::01 // WAITLIST DIGEST`,
    `${from} to ${to} (${days} days)`,
    '',
    `New signups: ${period.signups} (${deltaLabel(period.signups, period.prevSignups)})`,
    `Confirmed: ${period.confirmed} (${deltaLabel(period.confirmed, period.prevConfirmed)})`,
    `Conversion: ${periodRate}%`,
    '',
    `On the list: ${live} total, ${confirmedLive} confirmed, ${stats.totals.pending} pending, ${stats.totals.unsubscribed} removed.`,
    '',
    'Interest: ' + (interests.map(([k, n]) => `${INTEREST_LABELS[k] ?? k} ${n}`).join(', ') || 'none'),
    'Countries: ' + (countries.map(([k, n]) => `${k} ${n}`).join(', ') || 'none'),
    'Sources: ' + (sources.map(([k, n]) => `${k} ${n}`).join(', ') || 'none'),
    '',
    `Dashboard: ${opts.dashboardUrl}`,
    '',
  ].join('\n');

  return { subject, html, text, period };
}
