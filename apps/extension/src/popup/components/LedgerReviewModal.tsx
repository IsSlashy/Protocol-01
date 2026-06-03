/**
 * LedgerReviewModal — per-sign review + blind-sign explainer (extension).
 *
 * Shown before every Ledger co-sign (docs/pairing-ledger-spec.md §1B / UI-4).
 * Two jobs:
 *   1. Tell the user to confirm the prompt ON the device (we never auto-approve).
 *   2. Handle the P01 blind-sign blocker: every pool ix is a custom-program ix, so
 *      the Solana app returns 0x6808 (BLIND_SIGNATURE_REQUIRED) unless "Allow blind
 *      sign" is ON. We surface a one-time explainer with the exact device steps,
 *      driven either by a pre-flight `blindSignEnabled === false` OR by catching a
 *      thrown LedgerBlindSignRequiredError at sign time.
 *
 * Pure presentational modal — the caller owns the transport / signing lifecycle.
 */

import { motion } from 'framer-motion';
import { Usb, AlertTriangle, Loader2, X, ShieldCheck } from 'lucide-react';

export type LedgerReviewState =
  | 'awaiting-device' // prompt is (or is about to be) on the device
  | 'blind-sign-required' // 0x6808 — user must enable Allow blind sign
  | 'rejected' // user declined on the device (0x6985)
  | 'error'; // any other device/transport error

export interface LedgerReviewModalProps {
  open: boolean;
  state: LedgerReviewState;
  /** Optional human-readable action label, e.g. "Withdraw 1 SOL". */
  actionLabel?: string;
  /** Error detail for the 'error' state. */
  errorMessage?: string;
  /** Retry the operation (re-prompts the device). */
  onRetry?: () => void;
  /** Dismiss / cancel the flow. */
  onClose: () => void;
}

export default function LedgerReviewModal({
  open,
  state,
  actionLabel,
  errorMessage,
  onRetry,
  onClose,
}: LedgerReviewModalProps) {
  if (!open) return null;

  return (
    <div
      className="absolute inset-0 bg-black/80 flex items-end justify-center p-4 z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ledger-review-title"
    >
      <motion.div
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="w-full bg-p01-surface rounded-2xl p-5"
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-p01-cyan/20 flex items-center justify-center">
              <Usb className="w-5 h-5 text-p01-cyan" />
            </div>
            <h3 id="ledger-review-title" className="text-lg font-display font-bold text-white">
              Confirm on Ledger
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-p01-chrome hover:text-white"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {actionLabel && (
          <p className="text-p01-chrome/80 text-sm mb-4">
            <span className="text-white font-medium">{actionLabel}</span>
          </p>
        )}

        {state === 'awaiting-device' && (
          <div className="text-center py-4">
            <Loader2 className="w-8 h-8 text-p01-cyan animate-spin mx-auto mb-3" />
            <p className="text-white font-medium">Review the transaction on your device</p>
            <p className="text-p01-chrome/60 text-sm mt-1">
              Approve the prompt on your Ledger to sign. Nothing is signed without
              your on-device confirmation.
            </p>
          </div>
        )}

        {state === 'blind-sign-required' && (
          <div className="py-2">
            <div className="bg-warning/10 rounded-xl p-3 mb-4 border border-warning/30 flex gap-2">
              <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-warning">
                Protocol-01 uses a custom Solana program, so your Ledger needs blind
                signing enabled to approve it.
              </p>
            </div>
            <ol className="text-sm text-p01-chrome/80 space-y-2 mb-4 list-decimal list-inside">
              <li>On the Ledger, open the <span className="text-white">Solana</span> app.</li>
              <li>Go to <span className="text-white">Settings</span>.</li>
              <li>Set <span className="text-white">Allow blind sign</span> to <span className="text-white">Enabled</span>.</li>
              <li>Come back here and retry.</li>
            </ol>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 py-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-border transition-colors"
              >
                Cancel
              </button>
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="flex-1 py-3 bg-p01-cyan text-p01-void font-medium rounded-xl hover:bg-p01-cyan-dim transition-colors"
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        )}

        {state === 'rejected' && (
          <div className="py-2">
            <div className="bg-red-500/10 rounded-xl p-3 mb-4 border border-red-500/20 flex gap-2">
              <ShieldCheck className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-red-400">
                You rejected the transaction on the device. Nothing was signed.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 py-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-border transition-colors"
              >
                Close
              </button>
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="flex-1 py-3 bg-p01-cyan text-p01-void font-medium rounded-xl hover:bg-p01-cyan-dim transition-colors"
                >
                  Try Again
                </button>
              )}
            </div>
          </div>
        )}

        {state === 'error' && (
          <div className="py-2">
            <div className="bg-red-500/10 rounded-xl p-3 mb-4 border border-red-500/20 flex gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-red-400 break-words">
                {errorMessage || 'The device could not complete the signature. Reconnect and try again.'}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 py-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-border transition-colors"
              >
                Close
              </button>
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="flex-1 py-3 bg-p01-cyan text-p01-void font-medium rounded-xl hover:bg-p01-cyan-dim transition-colors"
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
