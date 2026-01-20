"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Shield,
  Check,
  X,
  Plus,
  Trash2,
  RefreshCw,
  Lock,
  User,
  Mail,
  Folder,
  Clock,
  AlertTriangle,
  Copy,
  ExternalLink,
} from "lucide-react";

interface WhitelistEntry {
  wallet: string;
  email?: string;
  projectName?: string;
  approvedAt: string;
  approvedBy: string;
}

interface WhitelistData {
  approved: WhitelistEntry[];
  pending: WhitelistEntry[];
}

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [whitelist, setWhitelist] = useState<WhitelistData>({ approved: [], pending: [] });

  // Form for adding new wallet
  const [newWallet, setNewWallet] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newProject, setNewProject] = useState("");

  const fetchWhitelist = useCallback(async () => {
    if (!password) return;

    setIsLoading(true);
    try {
      const res = await fetch("/api/whitelist?admin=true", {
        headers: { "x-admin-password": password },
      });

      if (res.status === 401) {
        setIsAuthenticated(false);
        setError("Invalid password");
        return;
      }

      const data = await res.json();
      setWhitelist(data);
      setIsAuthenticated(true);
      setError("");
    } catch (err) {
      setError("Failed to fetch whitelist");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, [password]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetchWhitelist();
  };

  const handleApprove = async (wallet: string, email?: string, projectName?: string) => {
    try {
      const res = await fetch("/api/whitelist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": password,
        },
        body: JSON.stringify({ wallet, email, projectName, action: "approve" }),
      });

      if (res.ok) {
        await fetchWhitelist();
      }
    } catch (err) {
      console.error("Failed to approve:", err);
    }
  };

  const handleReject = async (wallet: string) => {
    try {
      const res = await fetch("/api/whitelist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": password,
        },
        body: JSON.stringify({ wallet, action: "reject" }),
      });

      if (res.ok) {
        await fetchWhitelist();
      }
    } catch (err) {
      console.error("Failed to reject:", err);
    }
  };

  const handleRevoke = async (wallet: string) => {
    if (!confirm(`Revoke access for ${wallet.slice(0, 8)}...?`)) return;

    try {
      const res = await fetch(`/api/whitelist?wallet=${wallet}`, {
        method: "DELETE",
        headers: { "x-admin-password": password },
      });

      if (res.ok) {
        await fetchWhitelist();
      }
    } catch (err) {
      console.error("Failed to revoke:", err);
    }
  };

  const handleAddManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWallet.trim()) return;

    await handleApprove(newWallet.trim(), newEmail.trim(), newProject.trim());
    setNewWallet("");
    setNewEmail("");
    setNewProject("");
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!isAuthenticated) return;

    const interval = setInterval(fetchWhitelist, 30000);
    return () => clearInterval(interval);
  }, [isAuthenticated, fetchWhitelist]);

  // Login Screen
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[#0a0a0c] flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="bg-[#111114] border border-[#2a2a30] p-8">
            <div className="flex items-center justify-center gap-3 mb-8">
              <div className="w-12 h-12 bg-[#39c5bb]/10 border border-[#39c5bb]/30 flex items-center justify-center">
                <Lock size={24} className="text-[#39c5bb]" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">Admin Panel</h1>
                <p className="text-[#888892] text-sm">Protocol 01 Whitelist</p>
              </div>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-[#888892] text-sm mb-2">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter admin password"
                  className="w-full px-4 py-3 bg-[#0a0a0c] border border-[#2a2a30] text-white placeholder-[#555560] focus:border-[#39c5bb] focus:outline-none"
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 p-3 bg-[#ff2d7a]/10 border border-[#ff2d7a]/30 text-[#ff2d7a] text-sm">
                  <AlertTriangle size={16} />
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={isLoading || !password}
                className="w-full py-3 bg-[#39c5bb] text-[#0a0a0c] font-semibold hover:bg-[#39c5bb]/90 transition-colors disabled:opacity-50"
              >
                {isLoading ? "Authenticating..." : "Login"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Admin Dashboard
  return (
    <div className="min-h-screen bg-[#0a0a0c] p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#39c5bb]/10 border border-[#39c5bb]/30 flex items-center justify-center">
              <Shield size={20} className="text-[#39c5bb]" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Developer Whitelist</h1>
              <p className="text-[#888892] text-sm">Manage SDK access</p>
            </div>
          </div>

          <button
            onClick={fetchWhitelist}
            disabled={isLoading}
            className="flex items-center gap-2 px-4 py-2 bg-[#151518] border border-[#2a2a30] text-[#888892] hover:text-white hover:border-[#39c5bb]/50 transition-colors"
          >
            <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-[#111114] border border-[#2a2a30] p-4">
            <p className="text-[#888892] text-sm mb-1">Approved</p>
            <p className="text-2xl font-bold text-[#39c5bb]">{whitelist.approved.length}</p>
          </div>
          <div className="bg-[#111114] border border-[#2a2a30] p-4">
            <p className="text-[#888892] text-sm mb-1">Pending</p>
            <p className="text-2xl font-bold text-[#ffcc00]">{whitelist.pending.length}</p>
          </div>
          <div className="bg-[#111114] border border-[#2a2a30] p-4">
            <p className="text-[#888892] text-sm mb-1">Total Requests</p>
            <p className="text-2xl font-bold text-white">
              {whitelist.approved.length + whitelist.pending.length}
            </p>
          </div>
          <div className="bg-[#111114] border border-[#2a2a30] p-4">
            <p className="text-[#888892] text-sm mb-1">Approval Rate</p>
            <p className="text-2xl font-bold text-white">
              {whitelist.approved.length + whitelist.pending.length > 0
                ? Math.round(
                    (whitelist.approved.length /
                      (whitelist.approved.length + whitelist.pending.length)) *
                      100
                  )
                : 0}
              %
            </p>
          </div>
        </div>

        {/* Add Manual Entry */}
        <div className="bg-[#111114] border border-[#2a2a30] p-6">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <Plus size={18} className="text-[#39c5bb]" />
            Add Developer Manually
          </h2>
          <form onSubmit={handleAddManual} className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-[#888892] text-xs mb-1">Wallet Address *</label>
              <input
                type="text"
                value={newWallet}
                onChange={(e) => setNewWallet(e.target.value)}
                placeholder="7xK9f...8c2e"
                className="w-full px-3 py-2 bg-[#0a0a0c] border border-[#2a2a30] text-white placeholder-[#555560] focus:border-[#39c5bb] focus:outline-none text-sm"
              />
            </div>
            <div>
              <label className="block text-[#888892] text-xs mb-1">Email</label>
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="dev@example.com"
                className="w-full px-3 py-2 bg-[#0a0a0c] border border-[#2a2a30] text-white placeholder-[#555560] focus:border-[#39c5bb] focus:outline-none text-sm"
              />
            </div>
            <div>
              <label className="block text-[#888892] text-xs mb-1">Project</label>
              <input
                type="text"
                value={newProject}
                onChange={(e) => setNewProject(e.target.value)}
                placeholder="Project name"
                className="w-full px-3 py-2 bg-[#0a0a0c] border border-[#2a2a30] text-white placeholder-[#555560] focus:border-[#39c5bb] focus:outline-none text-sm"
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={!newWallet.trim()}
                className="w-full py-2 bg-[#39c5bb] text-[#0a0a0c] font-semibold hover:bg-[#39c5bb]/90 transition-colors disabled:opacity-50 text-sm"
              >
                Add & Approve
              </button>
            </div>
          </form>
        </div>

        {/* Pending Requests */}
        {whitelist.pending.length > 0 && (
          <div className="bg-[#111114] border border-[#ffcc00]/30 p-6">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <Clock size={18} className="text-[#ffcc00]" />
              Pending Requests ({whitelist.pending.length})
            </h2>
            <div className="space-y-3">
              {whitelist.pending.map((entry) => (
                <div
                  key={entry.wallet}
                  className="flex items-center justify-between p-4 bg-[#0a0a0c] border border-[#2a2a30]"
                >
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className="w-10 h-10 bg-[#ffcc00]/10 border border-[#ffcc00]/30 flex items-center justify-center flex-shrink-0">
                      <User size={18} className="text-[#ffcc00]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-white font-mono text-sm truncate">{entry.wallet}</p>
                        <button
                          onClick={() => copyToClipboard(entry.wallet)}
                          className="text-[#555560] hover:text-[#39c5bb]"
                        >
                          <Copy size={14} />
                        </button>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-[#888892]">
                        {entry.email && (
                          <span className="flex items-center gap-1">
                            <Mail size={12} /> {entry.email}
                          </span>
                        )}
                        {entry.projectName && (
                          <span className="flex items-center gap-1">
                            <Folder size={12} /> {entry.projectName}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <button
                      onClick={() => handleApprove(entry.wallet, entry.email, entry.projectName)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-[#39c5bb]/10 border border-[#39c5bb]/30 text-[#39c5bb] hover:bg-[#39c5bb]/20 transition-colors text-sm"
                    >
                      <Check size={14} /> Approve
                    </button>
                    <button
                      onClick={() => handleReject(entry.wallet)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-[#ff2d7a]/10 border border-[#ff2d7a]/30 text-[#ff2d7a] hover:bg-[#ff2d7a]/20 transition-colors text-sm"
                    >
                      <X size={14} /> Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Approved Developers */}
        <div className="bg-[#111114] border border-[#2a2a30] p-6">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <Check size={18} className="text-[#39c5bb]" />
            Approved Developers ({whitelist.approved.length})
          </h2>

          {whitelist.approved.length === 0 ? (
            <p className="text-[#888892] text-center py-8">No approved developers yet</p>
          ) : (
            <div className="space-y-3">
              {whitelist.approved.map((entry) => (
                <div
                  key={entry.wallet}
                  className="flex items-center justify-between p-4 bg-[#0a0a0c] border border-[#39c5bb]/20"
                >
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className="w-10 h-10 bg-[#39c5bb]/10 border border-[#39c5bb]/30 flex items-center justify-center flex-shrink-0">
                      <Check size={18} className="text-[#39c5bb]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-white font-mono text-sm truncate">{entry.wallet}</p>
                        <button
                          onClick={() => copyToClipboard(entry.wallet)}
                          className="text-[#555560] hover:text-[#39c5bb]"
                        >
                          <Copy size={14} />
                        </button>
                        <a
                          href={`https://solscan.io/account/${entry.wallet}?cluster=devnet`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#555560] hover:text-[#39c5bb]"
                        >
                          <ExternalLink size={14} />
                        </a>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-[#888892]">
                        {entry.email && (
                          <span className="flex items-center gap-1">
                            <Mail size={12} /> {entry.email}
                          </span>
                        )}
                        {entry.projectName && (
                          <span className="flex items-center gap-1">
                            <Folder size={12} /> {entry.projectName}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <Clock size={12} /> {new Date(entry.approvedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRevoke(entry.wallet)}
                    className="flex items-center gap-1 px-3 py-1.5 bg-[#ff2d7a]/10 border border-[#ff2d7a]/30 text-[#ff2d7a] hover:bg-[#ff2d7a]/20 transition-colors text-sm ml-4"
                  >
                    <Trash2 size={14} /> Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-center text-[#555560] text-sm">
          <p>Protocol 01 Admin Panel • Volta Team</p>
        </div>
      </div>
    </div>
  );
}
