/**
 * Discover: the merchants you can subscribe to, privately.
 *
 * 🎯 WHY THIS REPLACED THE AGENT TAB
 * ──────────────────────────────────
 * The fourth tab was an on-device AI assistant. Founder ruling 2026-08-23:
 * nobody was going to use it, and a tab is the most expensive piece of real
 * estate in a 360px popup. What a wallet tab has to earn is a reason to open
 * the extension when you are not already sending money, and a chat box is not
 * that.
 *
 * This is. It reads the on-chain service registry, which is a program that is
 * actually deployed (`p01_registry`, one of the ten live at slot 486 742 009),
 * and turns an empty wallet into a place with something to do. It is also the
 * only screen that answers, without a paragraph of explanation, the question
 * the whole product exists for: what can I pay for without handing over a name?
 *
 * ⛔ WHAT THIS IS NOT. It is not a marketplace and it does not rank, promote or
 * take a cut of placement. It lists what the registry contains, in the order
 * the chain returns it, with `verified` shown as a fact rather than a badge we
 * award. A directory that quietly sorts by who paid is the thing every app
 * store became, and it would be a strange first move for a privacy protocol.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Compass, RefreshCw, Search, ShieldCheck } from 'lucide-react';

import {
  fetchAllServices,
  resolveServiceBranding,
  type OnchainServiceEntry,
} from '@/shared/services/onchainServiceRegistry';
import { useWalletStore } from '@/shared/store/wallet';
import { Button, Eyebrow, EmptyState, Hairline, Panel, Pill, Screen } from '@/popup/ui';

/** Slots to a human interval. The registry stores slots; nobody thinks in slots. */
function intervalLabel(slots: number): string {
  const seconds = (slots * 400) / 1000; // ~400ms per slot on Solana
  const days = seconds / 86_400;
  if (days >= 27 && days <= 32) return 'per month';
  if (days >= 6 && days <= 8) return 'per week';
  if (days >= 360 && days <= 370) return 'per year';
  if (days >= 1) return `every ${Math.round(days)} days`;
  const hours = seconds / 3600;
  if (hours >= 1) return `every ${Math.round(hours)} h`;
  return `every ${Math.round(seconds)} s`;
}

function priceLabel(entry: OnchainServiceEntry): string {
  // Native SOL is nine decimals. Anything else is shown in its own atomic unit
  // rather than guessed at: a wrong decimal on a price is a wrong price.
  if (entry.tokenMint === '11111111111111111111111111111111') {
    return `${(entry.priceAtomic / 1e9).toFixed(3).replace(/\.?0+$/, '')} SOL`;
  }
  return `${entry.priceAtomic} units`;
}

export default function Discover() {
  const navigate = useNavigate();
  // ⚠️ `network` is on the WALLET store, not settings. The registry is
  // devnet-only and fetchAllServices returns [] elsewhere by design.
  const { network } = useWalletStore();

  const [services, setServices] = useState<OnchainServiceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const all = await fetchAllServices(network, { activeOnly: true });
      // Inactive entries are merchants who switched themselves off. Showing
      // them would send someone into a subscribe flow that cannot complete.
      setServices(all.filter((s) => s.active));
    } catch (e) {
      // ⚠️ Named, not swallowed. An empty directory and an unreachable RPC look
      // identical on screen, and they need opposite reactions from the user.
      setError((e as Error).message);
      setServices(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network]);

  const shown = useMemo(() => {
    if (!services) return [];
    const q = query.trim().toLowerCase();
    if (!q) return services;
    return services.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q),
    );
  }, [services, query]);

  return (
    <Screen
      title="Discover"
      action={
        <button
          onClick={() => void load()}
          aria-label="Refresh the merchant list"
          disabled={loading}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-p01-text-muted transition-colors duration-exit hover:text-p01-text disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
        >
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden="true" />
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <Eyebrow>On chain, {network}</Eyebrow>
          <p className="mt-1.5 text-sm text-p01-text-muted">
            Subscribe without an account. The merchant is paid on a schedule and never receives a
            name, an email or a card number.
          </p>
        </div>

        {services && services.length > 3 && (
          <div className="relative flex items-center">
            <Search
              className="pointer-events-none absolute left-3 h-4 w-4 text-p01-text-dim"
              aria-hidden="true"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search merchants"
              aria-label="Search merchants"
              className="min-h-[44px] w-full rounded-lg border border-p01-border bg-p01-dark pl-9 pr-3 text-sm text-p01-text placeholder:text-p01-text-dim outline-none transition-colors duration-exit focus:border-p01-cyan"
            />
          </div>
        )}

        {loading && !services && (
          /* Skeletons, not a spinner. The list has a known shape, so reserving
             it stops the layout jumping when the data lands. */
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading merchants">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[76px] animate-pulse rounded-xl border border-p01-border-soft bg-p01-surface" />
            ))}
          </div>
        )}

        {error && (
          <Panel tone="warn">
            <p className="text-sm text-p01-text">The registry could not be read.</p>
            <p className="mt-1 text-tiny text-p01-text-muted">{error}</p>
            <Button variant="secondary" size="md" className="mt-3" onClick={() => void load()}>
              Try again
            </Button>
          </Panel>
        )}

        {services && shown.length === 0 && !loading && (
          <EmptyState
            icon={Compass}
            title={query ? 'No match' : 'No merchants yet'}
            body={
              query
                ? 'Nothing in the registry matches that.'
                : 'The registry on this network has no active merchant. Anyone can register one.'
            }
            action={
              query ? (
                <Button variant="secondary" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              ) : undefined
            }
          />
        )}

        {shown.length > 0 && (
          <div className="flex flex-col">
            {shown.map((s, i) => {
              const branding = resolveServiceBranding(s);
              return (
                <div key={s.address}>
                  {i > 0 && <Hairline className="bg-p01-border-soft" />}
                  <button
                    onClick={() =>
                      navigate('/subscriptions/new', { state: { service: s.address } })
                    }
                    className="flex w-full items-center gap-3 py-3 text-left transition-colors duration-exit hover:bg-p01-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-p01-border bg-p01-surface font-display text-base">
                      {(branding?.name ?? s.name ?? '?').slice(0, 1).toUpperCase()}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm text-p01-text">{s.name || s.slug}</span>
                        {/* `verified` is a field on the account, so it is
                            reported, not conferred. */}
                        {s.verified && (
                          <ShieldCheck
                            className="h-3.5 w-3.5 shrink-0 text-p01-cyan"
                            aria-label="Verified in the registry"
                          />
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-tiny text-p01-text-dim">
                        <span className="truncate">{s.category || 'uncategorised'}</span>
                        {s.subscriberCount > 0 && (
                          <>
                            <span aria-hidden="true">&middot;</span>
                            <span className="tabular">{s.subscriberCount} subscribed</span>
                          </>
                        )}
                      </span>
                    </span>

                    <span className="shrink-0 text-right">
                      <span className="block text-sm text-p01-text tabular">{priceLabel(s)}</span>
                      <span className="block text-tiny text-p01-text-dim">
                        {intervalLabel(s.intervalSlots)}
                      </span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {shown.length > 0 && (
          <Panel tone="quiet">
            <div className="flex items-start gap-2">
              <Pill tone="good">Private</Pill>
              <p className="flex-1 text-tiny text-p01-text-muted">
                Paying here funds a subscription account derived from a secret, not from your
                wallet. The merchant sees a payment, not a subscriber.
              </p>
            </div>
          </Panel>
        )}
      </div>
    </Screen>
  );
}
