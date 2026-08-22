"use client";

/**
 * Connected sites.
 *
 * 🎯 WHAT CHANGED
 * ──────────────
 * This screen was written in a different house style from everything around
 * it: a mono-capitals headline "CONNECTED SITES" over a mono-capitals empty
 * state "NO CONNECTED SITES", square unrounded panels, and six raw hex greys
 * (`#555560`, `#888892`, `#444450`, …) that exist nowhere in the token file. It
 * is now the same screen shape as everything else: `Screen`, `Panel`, `Pill`,
 * `EmptyState`, and the palette by name.
 *
 * ⚠️ THE HEADER USED TO COUNT THE SITES AND SO DID THE LIST. "3 sites
 * connected" sat above three visible cards. The count is gone; the list is the
 * count.
 *
 * ⛔ THE FOOTER CARD IS GONE. A permanent bar at the bottom explained what a
 * connected site can do, on a 600px popup, below a list that scrolls. The one
 * sentence worth keeping now sits once, above the list, where it is read before
 * the decision rather than after it.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Globe, Trash2, Loader2, ExternalLink } from 'lucide-react';
import { sendToBackground } from '@/shared/messaging';
import type { ConnectedDapp, DappPermission } from '@/shared/types';
import { EmptyState, Panel, Pill, Screen } from '@/popup/ui';

const permissionLabels: Record<DappPermission, string> = {
  viewBalance: 'View balance',
  requestTransaction: 'Transactions',
  requestSubscription: 'Subscriptions',
  viewStealthAddress: 'Stealth address',
};

export default function ConnectedSites() {
  const navigate = useNavigate();
  const [sites, setSites] = useState<ConnectedDapp[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  // Load connected sites
  useEffect(() => {
    const loadSites = async () => {
      try {
        const connectedDapps = await sendToBackground<ConnectedDapp[]>('GET_CONNECTED_DAPPS');
        setSites(connectedDapps || []);
      } catch (error) {
        console.error('Failed to load connected sites:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSites();
  }, []);

  const handleDisconnect = async (origin: string) => {
    setDisconnecting(origin);
    try {
      await sendToBackground('DISCONNECT_DAPP', { origin });
      setSites((prev) => prev.filter((site) => site.origin !== origin));
    } catch (error) {
      console.error('Failed to disconnect:', error);
    } finally {
      setDisconnecting(null);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <Screen title="Connected sites" onBack={() => navigate(-1)}>
      {isLoading ? (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-p01-text-dim" aria-hidden="true" />
          <span className="sr-only">Loading connected sites</span>
        </div>
      ) : sites.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="Nothing connected"
          body="A site you approve appears here, and this is where you cut it off."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {/* Said once, before the decision rather than under it. */}
          <p className="text-tiny text-p01-text-dim">
            Each of these can read your balance and ask you to sign. Disconnect anything you do not
            recognise.
          </p>

          {sites.map((site) => (
            <Panel key={site.origin}>
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-p01-border-soft bg-p01-dark">
                  {site.icon ? (
                    <img
                      src={site.icon}
                      alt=""
                      className="h-5 w-5"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <Globe className="h-4 w-4 text-p01-cyan" aria-hidden="true" />
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <h2 className="truncate font-display text-base font-normal text-p01-text">
                      {site.name}
                    </h2>
                    <a
                      href={site.origin}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-p01-text-dim outline-none transition-colors duration-exit hover:text-p01-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
                      aria-label={`Open ${site.name} in a new tab`}
                    >
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                  </div>
                  <p className="truncate font-mono text-tiny text-p01-text-muted">{site.origin}</p>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {site.permissions.map((permission) => (
                      <Pill key={permission}>{permissionLabels[permission]}</Pill>
                    ))}
                  </div>

                  <p className="mt-2 text-tiny text-p01-text-dim">
                    Connected {formatDate(site.connectedAt)}
                  </p>
                </div>

                <button
                  onClick={() => handleDisconnect(site.origin)}
                  disabled={disconnecting === site.origin}
                  aria-label={`Disconnect ${site.name}`}
                  className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-p01-text-dim outline-none transition-colors duration-exit hover:text-p01-red focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-p01-text-dim"
                >
                  {disconnecting === site.origin ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </Screen>
  );
}
