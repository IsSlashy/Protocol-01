"use client";

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Shield, Eye, Repeat, X, Loader2, Globe, Check } from 'lucide-react';
import { truncateAddress } from '@/shared/utils';
import { useWalletStore } from '@/shared/store/wallet';
import { approveRequest, rejectRequest } from '@/shared/messaging';
import type { DappPermission, ApprovalRequest } from '@/shared/types';

const permissionLabels: Record<DappPermission, { label: string; icon: React.ElementType; code: string; description: string }> = {
  viewBalance: {
    label: 'VIEW BALANCE',
    icon: Eye,
    code: 'VIEW',
    description: 'See your wallet balance and token holdings',
  },
  requestTransaction: {
    label: 'REQUEST TRANSACTIONS',
    icon: Shield,
    code: 'TX',
    description: 'Ask for approval to send transactions',
  },
  requestSubscription: {
    label: 'REQUEST SUBSCRIPTIONS',
    icon: Repeat,
    code: 'STRM',
    description: 'Ask for approval to create recurring payments',
  },
  viewStealthAddress: {
    label: 'VIEW STEALTH ADDRESS',
    icon: Shield,
    code: 'STLTH',
    description: 'Generate stealth addresses for private receiving',
  },
};

const defaultPermissions: DappPermission[] = ['viewBalance', 'requestTransaction', 'requestSubscription'];

export default function ConnectDapp() {
  const { publicKey } = useWalletStore();
  const [isConnecting, setIsConnecting] = useState(false);
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [selectedPermissions, setSelectedPermissions] = useState<DappPermission[]>(defaultPermissions);

  const displayAddress = publicKey || '7xKX...m4Pq';

  // Load connection request from storage
  useEffect(() => {
    const loadRequest = async () => {
      try {
        console.log('[ConnectDapp] Loading currentApproval from storage...');
        const result = await chrome.storage.session.get('currentApproval');
        console.log('[ConnectDapp] Storage result:', result);
        if (result.currentApproval) {
          console.log('[ConnectDapp] Found approval request:', result.currentApproval);
          setRequest(result.currentApproval);
        } else {
          console.log('[ConnectDapp] No approval request found in storage');
        }
      } catch (error) {
        console.error('[ConnectDapp] Failed to load approval request:', error);
      }
    };
    loadRequest();
  }, []);

  const togglePermission = (permission: DappPermission) => {
    setSelectedPermissions((prev) =>
      prev.includes(permission)
        ? prev.filter((p) => p !== permission)
        : [...prev, permission]
    );
  };

  const handleConnect = async () => {
    if (!request) return;

    setIsConnecting(true);
    try {
      await approveRequest(request.id, { permissions: selectedPermissions });

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
      <div className="flex flex-col h-full bg-p01-void items-center justify-center">
        <Loader2 className="w-8 h-8 text-p01-cyan animate-spin" />
        <p className="text-[10px] text-[#555560] font-mono mt-4">LOADING REQUEST...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header - Industrial style */}
      <div className="p-4 border-b border-p01-border">
        <div className="flex items-center justify-center gap-3">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-14 h-14 bg-p01-surface border border-p01-border flex items-center justify-center"
          >
            {originIcon ? (
              <img
                src={originIcon}
                alt=""
                className="w-10 h-10"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Globe className="w-7 h-7 text-p01-cyan" />
            )}
          </motion.div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Site Info - Terminal style */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="text-center"
        >
          <h1 className="text-lg font-bold text-white tracking-wider font-mono mb-1">
            {originName.toUpperCase()}
          </h1>
          <p className="text-[10px] text-[#555560] font-mono tracking-wider">
            {origin}
          </p>
        </motion.div>

        {/* Connection Request */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="text-center py-2"
        >
          <span className="text-[#ff2d7a] text-[10px] font-bold tracking-[4px] font-mono">
            [ CONNECTION REQUEST ]
          </span>
        </motion.div>

        {/* Wallet Address - Industrial panel */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.15 }}
          className="bg-p01-surface p-3 border border-p01-border"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center">
              <span className="text-p01-cyan font-bold font-mono">01</span>
            </div>
            <div>
              <p className="text-xs font-bold text-white font-mono tracking-wider">P-01 WALLET</p>
              <p className="text-[10px] text-[#555560] font-mono">
                {truncateAddress(displayAddress, 6)}
              </p>
            </div>
            <div className="ml-auto flex items-center">
              <div className="w-2 h-2 bg-p01-cyan mr-2" />
              <span className="text-[10px] text-[#555560] font-mono">ACTIVE</span>
            </div>
          </div>
        </motion.div>

        {/* Permissions - Industrial checkboxes */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
        >
          <p className="text-[10px] text-[#555560] font-mono tracking-[3px] mb-3">
            PERMISSIONS REQUESTED
          </p>
          <div className="space-y-2">
            {defaultPermissions.map((permission, index) => {
              const { label, icon: Icon, code, description } = permissionLabels[permission];
              const isSelected = selectedPermissions.includes(permission);

              return (
                <motion.button
                  key={permission}
                  initial={{ x: -10, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ delay: 0.25 + index * 0.05 }}
                  onClick={() => togglePermission(permission)}
                  className={`w-full flex items-center gap-3 p-3 border transition-colors ${
                    isSelected
                      ? 'bg-p01-cyan/5 border-p01-cyan/40'
                      : 'bg-p01-surface border-p01-border hover:border-p01-border-hover'
                  }`}
                >
                  <div
                    className={`w-8 h-8 flex items-center justify-center border ${
                      isSelected ? 'bg-p01-cyan/10 border-p01-cyan/30' : 'bg-p01-dark border-p01-border'
                    }`}
                  >
                    <Icon
                      className={`w-4 h-4 ${
                        isSelected ? 'text-p01-cyan' : 'text-[#555560]'
                      }`}
                    />
                  </div>
                  <div className="flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-[#ff2d7a] font-mono tracking-wider">
                        [{code}]
                      </span>
                      <p className={`text-[11px] font-bold font-mono tracking-wider ${
                        isSelected ? 'text-white' : 'text-[#888892]'
                      }`}>
                        {label}
                      </p>
                    </div>
                    <p className="text-[10px] text-[#555560] font-mono mt-0.5">
                      {description}
                    </p>
                  </div>
                  <div
                    className={`w-5 h-5 border-2 flex items-center justify-center ${
                      isSelected
                        ? 'bg-p01-cyan border-p01-cyan'
                        : 'border-p01-border'
                    }`}
                  >
                    {isSelected && <Check className="w-3 h-3 text-p01-void" />}
                  </div>
                </motion.button>
              );
            })}
          </div>
        </motion.div>

        {/* Info - Warning style */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="bg-p01-surface p-3 border border-p01-border"
        >
          <p className="text-[10px] text-[#555560] font-mono leading-relaxed">
            This site will be able to perform the selected actions.
            You can disconnect at any time from Settings.
          </p>
        </motion.div>
      </div>

      {/* Actions - Industrial buttons */}
      <div className="p-4 border-t border-p01-border space-y-2">
        <motion.button
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.45 }}
          onClick={handleConnect}
          disabled={isConnecting || selectedPermissions.length === 0}
          className="w-full py-3 bg-p01-cyan text-p01-void font-bold text-sm tracking-wider font-mono hover:bg-p01-cyan-dim transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {isConnecting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              CONNECTING...
            </>
          ) : (
            'CONNECT'
          )}
        </motion.button>

        <motion.button
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.5 }}
          onClick={handleReject}
          disabled={isConnecting}
          className="w-full py-3 bg-p01-surface text-[#888892] font-bold text-sm tracking-wider font-mono border border-p01-border hover:text-white hover:border-p01-border-hover transition-colors flex items-center justify-center gap-2"
        >
          <X className="w-4 h-4" />
          CANCEL
        </motion.button>
      </div>
    </div>
  );
}
