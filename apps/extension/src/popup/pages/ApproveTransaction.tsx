"use client";

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Shield,
  AlertTriangle,
  X,
  Loader2,
  ExternalLink,
  ArrowUpRight,
  Globe,
  FileText,
  Pencil,
} from 'lucide-react';
import { truncateAddress } from '@/shared/utils';
import { useWalletStore } from '@/shared/store/wallet';
import { approveRequest, rejectRequest } from '@/shared/messaging';
import type { ApprovalRequest } from '@/shared/types';

interface TransactionPayload {
  transaction?: string;
  transactions?: string[];
  message?: string;
  displayText?: string;
  isPrivate?: boolean;
  sendAfterSign?: boolean;
  isMultiple?: boolean;
}

export default function ApproveTransaction() {
  const { publicKey } = useWalletStore();
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
      // TODO: Actual signing logic will be implemented here
      // For now, we just approve the request and let the background handle it
      await approveRequest(request.id, {
        // In a real implementation, we would sign the transaction here
        // and return the signed transaction data
        approved: true,
      });

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
      <div className="flex flex-col h-full bg-p01-void items-center justify-center">
        <Loader2 className="w-8 h-8 text-p01-cyan animate-spin" />
        <p className="text-[10px] text-[#555560] font-mono mt-4">LOADING REQUEST...</p>
      </div>
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
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header - Industrial style */}
      <div className="p-4 border-b border-p01-border">
        <div className="flex items-center gap-3">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-12 h-12 bg-p01-surface border border-p01-border flex items-center justify-center"
          >
            {originIcon ? (
              <img
                src={originIcon}
                alt=""
                className="w-8 h-8"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Globe className="w-6 h-6 text-p01-cyan" />
            )}
          </motion.div>
          <div>
            <h1 className="text-sm font-bold text-white font-mono tracking-wider">
              {isMessageSign ? 'SIGN MESSAGE' : 'SIGN TRANSACTION'}
            </h1>
            <p className="text-[10px] text-[#555560] font-mono">
              {originName}
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Request Type Badge */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="flex items-center justify-center"
        >
          <div className="flex items-center gap-2 px-3 py-1.5 bg-p01-surface border border-p01-border">
            {isMessageSign ? (
              <>
                <Pencil className="w-4 h-4 text-p01-cyan" />
                <span className="text-xs font-bold text-white font-mono tracking-wider">
                  MESSAGE SIGNATURE
                </span>
              </>
            ) : (
              <>
                <ArrowUpRight className="w-4 h-4 text-p01-cyan" />
                <span className="text-xs font-bold text-white font-mono tracking-wider">
                  {isMultiple ? `${transactionCount} TRANSACTIONS` : 'TRANSACTION'}
                </span>
              </>
            )}
          </div>
        </motion.div>

        {/* Message Content (for sign message) */}
        {isMessageSign && payload.displayText && (
          <motion.div
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="bg-p01-surface p-4 border border-p01-border"
          >
            <div className="flex items-center gap-2 mb-2">
              <FileText className="w-4 h-4 text-[#555560]" />
              <span className="text-[10px] text-[#555560] font-mono tracking-wider">
                MESSAGE CONTENT
              </span>
            </div>
            <p className="text-sm text-white font-mono break-all whitespace-pre-wrap max-h-32 overflow-y-auto">
              {payload.displayText}
            </p>
          </motion.div>
        )}

        {/* Transaction Preview (for transactions) */}
        {!isMessageSign && (
          <motion.div
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="bg-p01-surface p-4 border border-p01-border space-y-3"
          >
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-[#555560]" />
              <span className="text-[10px] text-[#555560] font-mono tracking-wider">
                TRANSACTION DATA
              </span>
            </div>

            {/* Sender */}
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-[#555560] font-mono">FROM</span>
              <div className="flex items-center gap-1">
                <span className="text-xs font-mono text-white">
                  {truncateAddress(publicKey || '', 6)}
                </span>
              </div>
            </div>

            {/* Network */}
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-[#555560] font-mono">NETWORK</span>
              <span className="text-xs text-white font-mono">Solana Devnet</span>
            </div>

            {/* Privacy Mode */}
            {payload.isPrivate && (
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-[#555560] font-mono">PRIVACY</span>
                <div className="flex items-center gap-1.5">
                  <Shield className="w-4 h-4 text-p01-cyan" />
                  <span className="text-xs text-p01-cyan font-mono">STEALTH</span>
                </div>
              </div>
            )}

            {/* Send After Sign */}
            {payload.sendAfterSign && (
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-[#555560] font-mono">ACTION</span>
                <span className="text-xs text-white font-mono">SIGN & SEND</span>
              </div>
            )}

            {/* Estimated Fee */}
            <div className="border-t border-p01-border pt-3">
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-[#555560] font-mono">EST. FEE</span>
                <span className="text-xs text-white font-mono">~0.000005 SOL</span>
              </div>
            </div>
          </motion.div>
        )}

        {/* Privacy Info (for private transactions) */}
        {payload.isPrivate && (
          <motion.div
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="bg-p01-cyan/5 p-4 border border-p01-cyan/30"
          >
            <div className="flex items-start gap-3">
              <Shield className="w-5 h-5 text-p01-cyan flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-p01-cyan font-mono">
                  PRIVATE TRANSACTION
                </p>
                <p className="text-[10px] text-[#888892] font-mono mt-1">
                  This transaction uses a stealth address. The recipient address
                  will not be publicly linked to your wallet.
                </p>
              </div>
            </div>
          </motion.div>
        )}

        {/* Warning for unknown transactions */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.25 }}
          className="bg-[#ff2d7a]/10 p-4 border border-[#ff2d7a]/30"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[#ff2d7a] flex-shrink-0" />
            <div>
              <p className="text-xs font-bold text-[#ff2d7a] font-mono">
                VERIFY BEFORE SIGNING
              </p>
              <p className="text-[10px] text-[#888892] font-mono mt-1">
                Only approve transactions from sites you trust.
                Malicious sites may try to drain your wallet.
              </p>
            </div>
          </div>
        </motion.div>

        {/* Error Message */}
        {error && (
          <motion.div
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="bg-red-500/10 p-3 border border-red-500/30"
          >
            <p className="text-xs text-red-400 font-mono">{error}</p>
          </motion.div>
        )}

        {/* Origin Info */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="bg-p01-surface p-3 border border-p01-border"
        >
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-[#555560]" />
            <span className="text-[10px] text-[#555560] font-mono flex-1 truncate">
              {origin}
            </span>
            <ExternalLink className="w-3 h-3 text-[#555560]" />
          </div>
        </motion.div>
      </div>

      {/* Actions - Industrial buttons */}
      <div className="p-4 border-t border-p01-border space-y-2">
        <motion.button
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.35 }}
          onClick={handleApprove}
          disabled={isApproving}
          className="w-full py-3 bg-p01-cyan text-p01-void font-bold text-sm tracking-wider font-mono hover:bg-p01-cyan-dim transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {isApproving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {isMessageSign ? 'SIGNING...' : 'APPROVING...'}
            </>
          ) : (
            isMessageSign ? 'SIGN MESSAGE' : 'APPROVE'
          )}
        </motion.button>

        <motion.button
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.4 }}
          onClick={handleReject}
          disabled={isApproving}
          className="w-full py-3 bg-p01-surface text-[#888892] font-bold text-sm tracking-wider font-mono border border-p01-border hover:text-white hover:border-p01-border-hover transition-colors flex items-center justify-center gap-2"
        >
          <X className="w-4 h-4" />
          REJECT
        </motion.button>
      </div>
    </div>
  );
}
