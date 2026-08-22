"use client";

/**
 * Connect: a site is asking to talk to this wallet.
 *
 * 🎯 WHAT THIS SCREEN GAVE UP, AND WHY
 * ────────────────────────────────────
 * It used to present three permission checkboxes, all pre-ticked, with codes
 * like `[STRM]` beside them. They were a decision in name only: every one was
 * already on, unticking one silently produced a connection the site would then
 * fail against, and nothing downstream ever re-asked. A control that is
 * pre-answered and cannot usefully be changed is decoration on a security
 * surface, which is the worst place to put decoration. The grant is now stated
 * in one sentence and the button does what the button says.
 *
 * ⚠️ THE APPROVAL ARGUMENT IS UNCHANGED. `approveRequest` still receives the
 * same three permissions it received when all three boxes were ticked, which
 * was the state every real connection was approved in.
 *
 * The two stacked full-width buttons are one row. Cancel and Connect are a
 * single either/or, and stacking them made Cancel look like a second step.
 */

import { useState, useEffect } from 'react';
import { Globe } from 'lucide-react';
import { truncateAddress } from '@/shared/utils';
import { useWalletStore } from '@/shared/store/wallet';
import { approveRequest, rejectRequest } from '@/shared/messaging';
import type { DappPermission, ApprovalRequest } from '@/shared/types';
import { Button, Eyebrow, Panel, Screen } from '@/popup/ui';

/**
 * What a connected site may ask for. Not a menu: this is the whole grant, and
 * the sentence below the wallet row describes exactly these three.
 */
const defaultPermissions: DappPermission[] = ['viewBalance', 'requestTransaction', 'requestSubscription'];

export default function ConnectDapp() {
  const { publicKey } = useWalletStore();
  const [isConnecting, setIsConnecting] = useState(false);
  const [request, setRequest] = useState<ApprovalRequest | null>(null);

  const displayAddress = publicKey || '7xKX...m4Pq';

  // Load connection request from storage
  useEffect(() => {
    const loadRequest = async () => {
      try {
        const result = await chrome.storage.session.get('currentApproval');
        if (result.currentApproval) {
          setRequest(result.currentApproval);
        } else {
        }
      } catch (error) {
        console.error('[ConnectDapp] Failed to load approval request:', error);
      }
    };
    loadRequest();
  }, []);

  const handleConnect = async () => {
    if (!request) return;

    setIsConnecting(true);
    try {
      await approveRequest(request.id, { permissions: defaultPermissions });

      // Clear the request from storage
      await chrome.storage.session.remove('currentApproval');
      window.close();
    } catch (error) {
      console.error('Failed to approve:', error);
      setIsConnecting(false);
    }
  };

  const handleReject = async () => {
    if (!request) {
      window.close();
      return;
    }

    try {
      await rejectRequest(request.id, 'User rejected');
      await chrome.storage.session.remove('currentApproval');
    } catch (error) {
      console.error('Failed to reject:', error);
    }
    window.close();
  };

  const origin = request?.origin || 'Unknown dApp';
  const originName = request?.originName || (origin !== 'Unknown dApp' ? new URL(origin).hostname : 'Unknown');
  const originIcon = request?.originIcon;

  // Show loading state while fetching request
  if (!request) {
    return (
      <Screen>
        <p className="mt-6 text-center text-sm text-p01-text-muted">Loading request</p>
      </Screen>
    );
  }

  return (
    <Screen
      title="Connect"
      footer={
        /* One row. Cancel is the other half of this choice, not a step after it. */
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" size="lg" disabled={isConnecting} onClick={handleReject}>
            Cancel
          </Button>
          <Button size="lg" loading={isConnecting} onClick={handleConnect}>
            Connect
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {/* ── Who is asking ── */}
        <div className="flex flex-col items-center gap-3 pt-2 text-center">
          <span className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border border-p01-border bg-p01-surface">
            {originIcon ? (
              <img
                src={originIcon}
                alt=""
                className="h-9 w-9"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Globe className="h-6 w-6 text-p01-cyan" aria-hidden="true" />
            )}
          </span>
          <div>
            <p className="font-display text-xl font-normal tracking-tight">{originName}</p>
            <p className="mt-1 break-all font-mono text-tiny text-p01-text-dim">{origin}</p>
          </div>
        </div>

        {/* ── Which wallet it would be connected to ── */}
        <Panel>
          <Eyebrow>Wallet</Eyebrow>
          <p className="mt-1.5 font-mono text-sm text-p01-text">
            {truncateAddress(displayAddress, 6)}
          </p>
        </Panel>

        {/* The grant, said once. This is what the three checkboxes used to
            claim to control. */}
        <p className="text-sm text-p01-text-muted">
          This site will be able to see your balance and ask you to approve transactions and
          subscriptions. It can never move funds without you approving each one. You can
          disconnect at any time from Settings.
        </p>
      </div>
    </Screen>
  );
}
