"use client";

/**
 * Approve: sign a transaction, or sign a message, for a site.
 *
 * 🎯 THE FACTS COME FIRST AND THEY DO NOT MOVE.
 * ─────────────────────────────────────────────
 * This is a signing surface, so everything the signature commits to is in one
 * always-open panel: who is asking, which account signs, which network, what
 * it costs, and whether it will be broadcast. Nothing here is behind a
 * disclosure control.
 *
 * ⚠️ WHAT WAS REMOVED. A badge under the header that repeated the header
 * ("SIGN TRANSACTION" then "TRANSACTION"), and a card at the bottom that
 * repeated the origin already printed at the top. Both were pure restatement
 * on a screen whose whole job is to make a small number of facts legible.
 * Stealth was announced twice, as a row and as a card; it is now one row with
 * its consequence written under it.
 *
 * ⛔ WHAT THIS SCREEN STILL CANNOT TELL YOU: the recipient and the amount. The
 * payload carries a serialised transaction and nothing else, and it is only
 * deserialised inside `handleApprove`, after the press. That is a real gap on
 * a signing surface and it is left alone here because closing it means new
 * decode logic, not new layout.
 */

import { useState, useEffect } from 'react';
import {
  AlertTriangle,
  Globe,
  Loader2,
} from 'lucide-react';
import { truncateAddress } from '@/shared/utils';
import { useWalletStore } from '@/shared/store/wallet';
import { approveRequest, rejectRequest } from '@/shared/messaging';
import type { ApprovalRequest } from '@/shared/types';
import nacl from 'tweetnacl';
import {
  Transaction,
  VersionedTransaction,
  Keypair,
} from '@solana/web3.js';
import { RpcConnectionManager } from '@protocol-01/rpc-config';
import { Button, Eyebrow, Hairline, Panel, Screen } from '@/popup/ui';

interface TransactionPayload {
  transaction?: string;
  transactions?: string[];
  message?: string;
  displayText?: string;
  isPrivate?: boolean;
  sendAfterSign?: boolean;
  isMultiple?: boolean;
}

// Helper to convert base64 to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Helper to convert Uint8Array to base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** One fact of the signature, label left, value right. Values are mono. */
function Detail({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="shrink-0 text-tiny text-p01-text-muted">{label}</span>
        <span className="min-w-0 truncate text-right font-mono text-sm text-p01-text tabular">
          {value}
        </span>
      </div>
      {sub && <p className="mt-0.5 text-tiny text-p01-text-dim">{sub}</p>}
    </div>
  );
}

export default function ApproveTransaction() {
  const { publicKey, _keypair } = useWalletStore();
  const [isApproving, setIsApproving] = useState(false);
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load approval request from storage
  useEffect(() => {
    const loadRequest = async () => {
      try {
        const result = await chrome.storage.session.get('currentApproval');
        if (result.currentApproval) {
          setRequest(result.currentApproval);
        }
      } catch (err) {
        console.error('Failed to load approval request:', err);
        setError('Failed to load request');
      }
    };
    loadRequest();
  }, []);

  const handleApprove = async () => {
    if (!request) return;

    setIsApproving(true);
    setError(null);

    try {
      const isMessageSign = request.type === 'signMessage';
      const payload = request.payload as TransactionPayload;

      // Handle message signing
      if (isMessageSign && payload.message) {
        if (!_keypair) {
          throw new Error('Wallet is locked. Please unlock your wallet first.');
        }

        // Decode the message from base64
        const messageBytes = base64ToUint8Array(payload.message);

        // Sign the message using nacl detached signature
        const signature = nacl.sign.detached(messageBytes, _keypair.secretKey);

        // Convert signature to base64 for transport
        const signatureBase64 = uint8ArrayToBase64(signature);


        // Return the signature
        await approveRequest(request.id, {
          signature: signatureBase64,
        });
      } else if (payload.transaction) {
        // Handle transaction signing
        if (!_keypair) {
          throw new Error('Wallet is locked. Please unlock your wallet first.');
        }

        // Decode the transaction from base64
        const transactionBytes = base64ToUint8Array(payload.transaction);

        // Try to deserialize as VersionedTransaction first, then legacy Transaction
        let transaction: Transaction | VersionedTransaction;
        let isVersioned = false;

        try {
          // Check if it's a versioned transaction (first byte indicates version)
          if (transactionBytes[0] === 0x80 || transactionBytes[0] & 0x80) {
            transaction = VersionedTransaction.deserialize(transactionBytes);
            isVersioned = true;
          } else {
            transaction = Transaction.from(transactionBytes);
          }
        } catch {
          // Fallback to legacy transaction
          transaction = Transaction.from(transactionBytes);
        }

        // Create Keypair from secretKey
        const keypair = Keypair.fromSecretKey(_keypair.secretKey);

        // Sign the transaction
        if (isVersioned) {
          (transaction as VersionedTransaction).sign([keypair]);
        } else {
          (transaction as Transaction).sign(keypair);
        }

        // If sendAfterSign, send the transaction to the network
        if (payload.sendAfterSign) {
          const heliusApiKey = typeof import.meta !== 'undefined'
            ? (import.meta as any).env?.VITE_HELIUS_API_KEY
            : undefined;
          const rpcManager = new RpcConnectionManager({
            cluster: 'devnet',
            commitment: 'confirmed',
            heliusApiKey,
          });
          const connection = rpcManager.getConnection();

          const serializedTx = transaction.serialize();
          const signature = await connection.sendRawTransaction(serializedTx, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
          });


          // Wait for confirmation
          await connection.confirmTransaction(signature, 'confirmed');


          await approveRequest(request.id, {
            signature,
          });
        } else {
          // Just sign, don't send
          const signedTxBase64 = uint8ArrayToBase64(transaction.serialize());
          await approveRequest(request.id, {
            signedTransaction: signedTxBase64,
          });
        }
      } else {
        throw new Error('No transaction data provided');
      }

      await chrome.storage.session.remove('currentApproval');
      window.close();
    } catch (err) {
      console.error('Failed to approve:', err);
      setError(err instanceof Error ? err.message : 'Failed to approve');
      setIsApproving(false);
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
    } catch (err) {
      console.error('Failed to reject:', err);
    }
    window.close();
  };

  // Show loading state
  if (!request) {
    return (
      <Screen>
        <p className="mt-6 flex items-center justify-center gap-2 text-sm text-p01-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading request
        </p>
      </Screen>
    );
  }

  const payload = request.payload as TransactionPayload;
  const isMessageSign = request.type === 'signMessage';
  const isMultiple = payload.isMultiple && payload.transactions;
  const transactionCount = isMultiple ? payload.transactions?.length || 0 : 1;

  const origin = request.origin || 'Unknown dApp';
  const originName = request.originName || (origin !== 'Unknown dApp' ? new URL(origin).hostname : 'Unknown');
  const originIcon = request.originIcon;

  return (
    <Screen
      title={isMessageSign ? 'Sign message' : 'Sign transaction'}
      footer={
        <div className="flex flex-col gap-2">
          {/* The failure sits with the action it belongs to, not in a banner
              at the top of a screen the user has already scrolled past. */}
          {error && (
            <p role="alert" className="text-tiny text-p01-red">
              {error}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" size="lg" disabled={isApproving} onClick={handleReject}>
              Reject
            </Button>
            <Button size="lg" loading={isApproving} onClick={handleApprove}>
              {isMessageSign ? 'Sign' : 'Approve'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* ── Who is asking ── */}
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-p01-border bg-p01-surface">
            {originIcon ? (
              <img
                src={originIcon}
                alt=""
                className="h-6 w-6"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Globe className="h-5 w-5 text-p01-cyan" aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-p01-text">{originName}</p>
            <p className="truncate font-mono text-tiny text-p01-text-dim">{origin}</p>
          </div>
        </div>

        {/* ── What is being signed. Message text in full, never truncated. ── */}
        {isMessageSign && payload.displayText && (
          <Panel>
            <Eyebrow>Message</Eyebrow>
            <p className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-all font-mono text-sm text-p01-text">
              {payload.displayText}
            </p>
          </Panel>
        )}

        {/* ── The facts of the signature. Always open. ── */}
        {!isMessageSign && (
          <Panel>
            <Detail label="From" value={truncateAddress(publicKey || '', 6)} />
            <Hairline className="bg-p01-border-soft" />
            <Detail label="Network" value="Solana devnet" />
            {isMultiple && (
              <>
                <Hairline className="bg-p01-border-soft" />
                <Detail label="Transactions" value={transactionCount} />
              </>
            )}
            {payload.isPrivate && (
              <>
                <Hairline className="bg-p01-border-soft" />
                <Detail
                  label="Privacy"
                  value="Stealth address"
                  sub="The recipient is not publicly linked to this wallet."
                />
              </>
            )}
            <Hairline className="bg-p01-border-soft" />
            <Detail
              label="Network fee"
              value="~0.000005 SOL"
              sub={payload.sendAfterSign ? 'Signed and broadcast in one step.' : undefined}
            />
          </Panel>
        )}

        {/* Caution, once. Amber is the site's caution colour and this is the
            one thing on the screen the user should read twice. */}
        <Panel tone="warn">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-p01-amber" aria-hidden="true" />
            <p className="text-tiny text-p01-text-muted">
              Only approve transactions from sites you trust. A malicious site can drain this
              wallet.
            </p>
          </div>
        </Panel>
      </div>
    </Screen>
  );
}
