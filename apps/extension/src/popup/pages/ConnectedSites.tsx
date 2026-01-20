"use client";

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Globe,
  Trash2,
  Shield,
  Eye,
  Repeat,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { sendToBackground } from '@/shared/messaging';
import type { ConnectedDapp, DappPermission } from '@/shared/types';
import { cn } from '@/shared/utils';

const permissionIcons: Record<DappPermission, React.ElementType> = {
  viewBalance: Eye,
  requestTransaction: Shield,
  requestSubscription: Repeat,
  viewStealthAddress: Shield,
};

const permissionLabels: Record<DappPermission, string> = {
  viewBalance: 'View Balance',
  requestTransaction: 'Transactions',
  requestSubscription: 'Subscriptions',
  viewStealthAddress: 'Stealth',
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
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
        <button
          onClick={() => navigate(-1)}
          className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-white font-bold font-mono tracking-wider text-sm">
            CONNECTED SITES
          </h1>
          <p className="text-[10px] text-[#555560] font-mono">
            {sites.length} site{sites.length !== 1 ? 's' : ''} connected
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-8 h-8 text-p01-cyan animate-spin" />
          </div>
        ) : sites.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center h-full text-center"
          >
            <div className="w-16 h-16 bg-p01-surface border border-p01-border flex items-center justify-center mb-4">
              <Globe className="w-8 h-8 text-[#555560]" />
            </div>
            <h2 className="text-white font-bold font-mono tracking-wider mb-2">
              NO CONNECTED SITES
            </h2>
            <p className="text-[10px] text-[#555560] font-mono max-w-[200px]">
              When you connect to dApps, they will appear here
            </p>
          </motion.div>
        ) : (
          <AnimatePresence>
            <div className="space-y-3">
              {sites.map((site, index) => (
                <motion.div
                  key={site.origin}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 10 }}
                  transition={{ delay: index * 0.05 }}
                  className="bg-p01-surface border border-p01-border p-4"
                >
                  <div className="flex items-start gap-3">
                    {/* Site Icon */}
                    <div className="w-10 h-10 bg-p01-void border border-p01-border flex items-center justify-center flex-shrink-0">
                      {site.icon ? (
                        <img
                          src={site.icon}
                          alt=""
                          className="w-6 h-6"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <Globe className="w-5 h-5 text-p01-cyan" />
                      )}
                    </div>

                    {/* Site Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-white font-bold font-mono text-sm truncate">
                          {site.name}
                        </h3>
                        <a
                          href={site.origin}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#555560] hover:text-p01-cyan transition-colors"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                      <p className="text-[10px] text-[#555560] font-mono truncate mb-2">
                        {site.origin}
                      </p>

                      {/* Permissions */}
                      <div className="flex flex-wrap gap-1.5">
                        {site.permissions.map((permission) => {
                          const Icon = permissionIcons[permission];
                          return (
                            <div
                              key={permission}
                              className="flex items-center gap-1 px-2 py-1 bg-p01-void border border-p01-border"
                            >
                              <Icon className="w-3 h-3 text-p01-cyan" />
                              <span className="text-[9px] text-[#888892] font-mono">
                                {permissionLabels[permission]}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      {/* Connected Date */}
                      <p className="text-[9px] text-[#444450] font-mono mt-2">
                        Connected {formatDate(site.connectedAt)}
                      </p>
                    </div>

                    {/* Disconnect Button */}
                    <button
                      onClick={() => handleDisconnect(site.origin)}
                      disabled={disconnecting === site.origin}
                      className={cn(
                        'p-2 transition-colors',
                        disconnecting === site.origin
                          ? 'text-[#555560]'
                          : 'text-[#555560] hover:text-red-400'
                      )}
                    >
                      {disconnecting === site.origin ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <Trash2 className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>
          </AnimatePresence>
        )}
      </div>

      {/* Footer Info */}
      <div className="p-4 border-t border-p01-border">
        <div className="bg-p01-surface p-3 border border-p01-border">
          <p className="text-[10px] text-[#555560] font-mono leading-relaxed">
            Connected sites can view your balance and request transactions.
            Disconnect sites you no longer use for better security.
          </p>
        </div>
      </div>
    </div>
  );
}
