import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Key,
  Eye,
  EyeOff,
  Globe,
  Trash2,
  ChevronRight,
  Copy,
  Check,
  LogOut,
  Wifi,
  Bell,
  HelpCircle,
  ExternalLink,
  Lock,
  X,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { useSettingsStore } from '@/shared/store/settings';
import { useShieldedStore } from '@/shared/store/shielded';
import { cn, truncateAddress, copyToClipboard } from '@/shared/utils';
import { decrypt, encrypt, verifyPassword, hashPassword } from '@/shared/services/crypto';
import { Shield, BarChart3, Smartphone } from 'lucide-react';
import Wordmark from '@/popup/components/Wordmark';

export default function Settings() {
  const navigate = useNavigate();
  const { publicKey, network, setNetwork, hideBalance, toggleHideBalance, lock, reset, encryptedSeedPhrase, passwordHash } =
    useWalletStore();
  const {
    shieldedWalletEnabled,
    confidentialBalanceEnabled,
    relayerEnabled,
    setShieldedWalletEnabled,
    setConfidentialBalanceEnabled,
    setRelayerEnabled,
    initialize: initSettings,
  } = useSettingsStore();
  const { shieldedBalance } = useShieldedStore();
  const hasShieldedFunds = shieldedBalance > 0;

  const [copied, setCopied] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetLoading, setResetLoading] = useState(false);

  // Notifications state
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifyTransactions, setNotifyTransactions] = useState(true);
  const [notifySubscriptions, setNotifySubscriptions] = useState(true);
  const [notifyPrice, setNotifyPrice] = useState(false);

  // Backup seed phrase state
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const [seedPhrase, setSeedPhrase] = useState<string[] | null>(null);
  const [backupError, setBackupError] = useState('');
  const [backupLoading, setBackupLoading] = useState(false);
  const [seedCopied, setSeedCopied] = useState(false);

  // Change password state
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  // Load notification settings from storage
  useEffect(() => { initSettings(); }, []);

  useEffect(() => {
    const loadNotificationSettings = async () => {
      try {
        const result = await chrome.storage.local.get('p01-notifications');
        if (result['p01-notifications']) {
          const settings = JSON.parse(result['p01-notifications']);
          setNotifyTransactions(settings.transactions ?? true);
          setNotifySubscriptions(settings.subscriptions ?? true);
          setNotifyPrice(settings.price ?? false);
        }
      } catch (e) {
        console.error('Failed to load notification settings:', e);
      }
    };
    loadNotificationSettings();
  }, []);

  // Save notification settings
  const saveNotificationSettings = async (transactions: boolean, subscriptions: boolean, price: boolean) => {
    try {
      await chrome.storage.local.set({
        'p01-notifications': JSON.stringify({ transactions, subscriptions, price })
      });
    } catch (e) {
      console.error('Failed to save notification settings:', e);
    }
  };

  const handleCopy = async () => {
    if (!publicKey) return;
    await copyToClipboard(publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLock = async () => {
    lock();
    navigate('/unlock');
  };

  const handleReset = async () => {
    if (!passwordHash) return;

    setResetLoading(true);
    setResetError('');

    try {
      const isValid = await verifyPassword(resetPassword, passwordHash);
      if (!isValid) {
        setResetError('Invalid password');
        setResetLoading(false);
        return;
      }

      await reset();
      navigate('/welcome');
    } catch (e) {
      setResetError('Verification failed');
      setResetLoading(false);
    }
  };

  const closeResetModal = () => {
    setShowResetConfirm(false);
    setResetPassword('');
    setResetError('');
  };

  // Handle backup seed phrase
  const handleBackupReveal = async () => {
    if (!encryptedSeedPhrase || !passwordHash) return;

    setBackupLoading(true);
    setBackupError('');

    try {
      const isValid = await verifyPassword(backupPassword, passwordHash);
      if (!isValid) {
        setBackupError('Invalid password');
        setBackupLoading(false);
        return;
      }

      const mnemonic = await decrypt(encryptedSeedPhrase, backupPassword);
      setSeedPhrase(mnemonic.split(' '));
      setBackupLoading(false);
    } catch (e) {
      setBackupError('Failed to decrypt seed phrase');
      setBackupLoading(false);
    }
  };

  const handleCopySeed = async () => {
    if (!seedPhrase) return;
    await copyToClipboard(seedPhrase.join(' '));
    setSeedCopied(true);
    setTimeout(() => setSeedCopied(false), 2000);
  };

  const closeBackupModal = () => {
    setShowBackupModal(false);
    setBackupPassword('');
    setSeedPhrase(null);
    setBackupError('');
  };

  // Handle change password
  const handleChangePassword = async () => {
    if (!encryptedSeedPhrase || !passwordHash) return;

    // Validation
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('All fields are required');
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters');
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }

    setPasswordLoading(true);
    setPasswordError('');

    try {
      // Verify current password
      const isValid = await verifyPassword(currentPassword, passwordHash);
      if (!isValid) {
        setPasswordError('Current password is incorrect');
        setPasswordLoading(false);
        return;
      }

      // Decrypt seed phrase with old password
      const mnemonic = await decrypt(encryptedSeedPhrase, currentPassword);

      // Re-encrypt with new password
      const newEncryptedSeed = await encrypt(mnemonic, newPassword);
      const newPasswordHash = await hashPassword(newPassword);

      // Update in storage
      const result = await chrome.storage.local.get('p01-wallet');
      if (result['p01-wallet']) {
        const walletData = JSON.parse(result['p01-wallet']);
        walletData.state.encryptedSeedPhrase = newEncryptedSeed;
        walletData.state.passwordHash = newPasswordHash;
        await chrome.storage.local.set({ 'p01-wallet': JSON.stringify(walletData) });
      }

      setPasswordLoading(false);
      setPasswordSuccess(true);

      // Close modal after success
      setTimeout(() => {
        closePasswordModal();
        // Lock wallet to require re-login with new password
        lock();
        navigate('/unlock');
      }, 1500);
    } catch (e) {
      setPasswordError('Failed to change password');
      setPasswordLoading(false);
    }
  };

  const closePasswordModal = () => {
    setShowPasswordModal(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordError('');
    setPasswordSuccess(false);
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
        <button
          onClick={() => navigate(-1)}
          className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-white font-display font-bold tracking-wide">Settings</h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* Account Card */}
        <div className="p-4">
          <button
            onClick={handleCopy}
            className="w-full bg-p01-surface rounded-2xl p-4 flex items-center gap-4 hover:bg-p01-surface/80 transition-colors"
            aria-label={copied ? 'Address copied' : 'Copy wallet address'}
          >
            {/* Was the 01 raster used as an avatar. An account has no
                portrait here, so the mark stands in without pretending to. */}
            <span className="flex h-14 w-14 items-center justify-center rounded-full border border-p01-border bg-p01-surface">
              <Wordmark size={26} showText={false} />
            </span>

            {/* Info */}
            <div className="flex-1 text-left">
              <p className="text-white font-medium mb-0.5">
                My Wallet
              </p>
              <p className="text-p01-chrome text-sm font-mono">
                {publicKey ? truncateAddress(publicKey, 6) : '----'}
              </p>
            </div>

            {/* Copy */}
            <div className="p-2 bg-p01-surface rounded-lg">
              {copied ? (
                <Check className="w-5 h-5 text-p01-cyan" />
              ) : (
                <Copy className="w-5 h-5 text-p01-chrome" />
              )}
            </div>
          </button>
        </div>

        {/* Preferences */}
        <div className="px-4 mb-4">
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
            PREFERENCES
          </p>
          <div className="bg-p01-surface rounded-xl overflow-hidden">
            {/* Network Selector */}
            <div className="p-4 border-b border-p01-border/50">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 rounded-lg bg-p01-cyan/20 flex items-center justify-center">
                  <Wifi className="w-5 h-5 text-p01-cyan" />
                </div>
                <p className="text-white font-medium">Network</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setNetwork('devnet')}
                  className={cn(
                    'flex-1 py-2.5 rounded-lg text-sm font-medium transition-all',
                    network === 'devnet'
                      ? 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/40'
                      : 'bg-p01-void text-p01-chrome/60 hover:text-white'
                  )}
                >
                  Devnet
                </button>
                <button
                  onClick={() => setNetwork('mainnet-beta')}
                  className={cn(
                    'flex-1 py-2.5 rounded-lg text-sm font-medium transition-all',
                    network === 'mainnet-beta'
                      ? 'bg-p01-cyan/20 text-p01-cyan border border-p01-cyan/40'
                      : 'bg-p01-void text-p01-chrome/60 hover:text-white'
                  )}
                >
                  Mainnet
                </button>
              </div>
            </div>

            {/* Hide Balance Toggle */}
            <div className="flex items-center justify-between p-4 border-b border-p01-border/50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-p01-cyan/20 flex items-center justify-center">
                  {hideBalance ? (
                    <EyeOff className="w-5 h-5 text-p01-cyan" />
                  ) : (
                    <Eye className="w-5 h-5 text-p01-cyan" />
                  )}
                </div>
                <div>
                  <p className="text-white font-medium">Hide Balance</p>
                  <p className="text-p01-chrome/60 text-xs">Mask amounts in wallet</p>
                </div>
              </div>
              <button
                onClick={toggleHideBalance}
                role="switch"
                aria-checked={hideBalance}
                aria-label="Hide balance"
                className={cn(
                  'w-12 h-7 rounded-full transition-colors relative',
                  hideBalance ? 'bg-p01-cyan' : 'bg-p01-border'
                )}
              >
                <motion.span
                  layout
                  className={cn(
                    'absolute top-1 w-5 h-5 rounded-full bg-white shadow-md',
                    hideBalance ? 'left-6' : 'left-1'
                  )}
                />
              </button>
            </div>

            {/* Notifications */}
            <button
              onClick={() => setShowNotifications(true)}
              className="w-full flex items-center justify-between p-4 hover:bg-p01-void/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-warning/20 flex items-center justify-center">
                  <Bell className="w-5 h-5 text-warning" />
                </div>
                <div className="text-left">
                  <p className="text-white font-medium">Notifications</p>
                  <p className="text-p01-chrome/60 text-xs">Manage alerts</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-p01-chrome/40" />
            </button>
          </div>
        </div>

        {/* Privacy Features */}
        <div className="px-4 mb-4">
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
            PRIVACY FEATURES
          </p>
          <div className="bg-p01-surface rounded-xl overflow-hidden">
            {/* Shielded Wallet Toggle */}
            <div className="flex items-center justify-between p-4 border-b border-p01-border/50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-p01-chrome/10 flex items-center justify-center">
                  <Shield className="w-5 h-5 text-p01-chrome/60" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-white font-medium text-sm">Shielded Wallet</p>
                    <span className="text-[9px] text-p01-chrome/50 font-mono bg-p01-chrome/10 px-1 py-0.5 rounded">Legacy</span>
                  </div>
                  <p className="text-p01-chrome/60 text-xs">
                    {hasShieldedFunds
                      ? `${shieldedBalance.toFixed(4)} SOL — withdraw recommended`
                      : 'Use Privacy Pool instead for stronger anonymity'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShieldedWalletEnabled(!shieldedWalletEnabled)}
                role="switch"
                aria-checked={shieldedWalletEnabled}
                aria-label="Shielded wallet"
                className={cn(
                  'w-12 h-7 rounded-full transition-colors relative',
                  shieldedWalletEnabled ? 'bg-p01-cyan' : 'bg-p01-border'
                )}
              >
                <motion.span
                  layout
                  className={cn(
                    'absolute top-1 w-5 h-5 rounded-full bg-white shadow-md',
                    shieldedWalletEnabled ? 'left-6' : 'left-1'
                  )}
                />
              </button>
            </div>

            {/* Confidential Balance Toggle */}
            <div className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-p01-chrome/10 flex items-center justify-center">
                  <BarChart3 className="w-5 h-5 text-p01-chrome/60" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-white font-medium text-sm">Confidential Balance</p>
                    <span className="text-[9px] text-p01-chrome/50 font-mono bg-p01-chrome/10 px-1 py-0.5 rounded">Legacy</span>
                  </div>
                  <p className="text-p01-chrome/60 text-xs">
                    Hide amounts on-chain. Sender/recipient visible.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setConfidentialBalanceEnabled(!confidentialBalanceEnabled)}
                role="switch"
                aria-checked={confidentialBalanceEnabled}
                aria-label="Confidential balance"
                className={cn(
                  'w-12 h-7 rounded-full transition-colors relative',
                  confidentialBalanceEnabled ? 'bg-p01-cyan' : 'bg-p01-border'
                )}
              >
                <motion.span
                  layout
                  className={cn(
                    'absolute top-1 w-5 h-5 rounded-full bg-white shadow-md',
                    confidentialBalanceEnabled ? 'left-6' : 'left-1'
                  )}
                />
              </button>
            </div>

            {/* Privacy Relayer Toggle */}
            <div className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-p01-chrome/10 flex items-center justify-center">
                  <Wifi className="w-5 h-5 text-p01-chrome/60" />
                </div>
                <div>
                  <p className="text-white font-medium text-sm">Privacy Relayer</p>
                  <p className="text-p01-chrome/60 text-xs">
                    Route withdrawals via a relayer to hide your IP. Falls back to direct if unavailable.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setRelayerEnabled(!relayerEnabled)}
                role="switch"
                aria-checked={relayerEnabled}
                aria-label="Privacy relayer"
                className={cn(
                  'w-12 h-7 rounded-full transition-colors relative shrink-0',
                  relayerEnabled ? 'bg-p01-cyan' : 'bg-p01-border'
                )}
              >
                <motion.span
                  layout
                  className={cn(
                    'absolute top-1 w-5 h-5 rounded-full bg-white shadow-md',
                    relayerEnabled ? 'left-6' : 'left-1'
                  )}
                />
              </button>
            </div>
          </div>
        </div>

        {/* Security */}
        <div className="px-4 mb-4">
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
            SECURITY
          </p>
          <div className="bg-p01-surface rounded-xl overflow-hidden">
            {/* Backup Seed Phrase */}
            <button
              onClick={() => setShowBackupModal(true)}
              className="w-full flex items-center justify-between p-4 border-b border-p01-border/50 hover:bg-p01-void/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-p01-pink/20 flex items-center justify-center">
                  <Key className="w-5 h-5 text-p01-pink" />
                </div>
                <div className="text-left">
                  <p className="text-white font-medium">Backup Seed Phrase</p>
                  <p className="text-p01-chrome/60 text-xs">View your recovery phrase</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-p01-chrome/40" />
            </button>

            {/* Link a phone */}
            <button
              onClick={() => navigate('/link-phone')}
              className="w-full flex items-center justify-between p-4 border-b border-p01-border/50 hover:bg-p01-void/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-p01-cyan/20 flex items-center justify-center">
                  <Smartphone className="w-5 h-5 text-p01-cyan" />
                </div>
                <div className="text-left">
                  <p className="text-white font-medium">Link a phone</p>
                  <p className="text-p01-chrome/60 text-xs">Import this wallet to the P01 app by QR</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-p01-chrome/40" />
            </button>

            {/* Change Password */}
            <button
              onClick={() => setShowPasswordModal(true)}
              className="w-full flex items-center justify-between p-4 border-b border-p01-border/50 hover:bg-p01-void/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-p01-cyan/20 flex items-center justify-center">
                  <Lock className="w-5 h-5 text-p01-cyan" />
                </div>
                <div className="text-left">
                  <p className="text-white font-medium">Change Password</p>
                  <p className="text-p01-chrome/60 text-xs">Update your password</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-p01-chrome/40" />
            </button>

            {/* Connected Sites */}
            <button
              onClick={() => navigate('/connected-sites')}
              className="w-full flex items-center justify-between p-4 hover:bg-p01-void/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-p01-blue/20 flex items-center justify-center">
                  <Globe className="w-5 h-5 text-p01-blue" />
                </div>
                <div className="text-left">
                  <p className="text-white font-medium">Connected Sites</p>
                  <p className="text-p01-chrome/60 text-xs">Manage dApp connections</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-p01-chrome/40" />
            </button>
          </div>
        </div>

        {/* Support */}
        <div className="px-4 mb-4">
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
            SUPPORT
          </p>
          <div className="bg-p01-surface rounded-xl overflow-hidden">
            <button className="w-full flex items-center justify-between p-4 border-b border-p01-border/50 hover:bg-p01-void/50 transition-colors">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-p01-chrome/10 flex items-center justify-center">
                  <HelpCircle className="w-5 h-5 text-p01-chrome" />
                </div>
                <p className="text-white font-medium">Help & FAQ</p>
              </div>
              <ExternalLink className="w-4 h-4 text-p01-chrome/40" />
            </button>

            <a
              href="https://x.com/Protocol01_"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center justify-between p-4 hover:bg-p01-void/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-p01-chrome/10 flex items-center justify-center">
                  <span className="text-p01-chrome font-bold">𝕏</span>
                </div>
                <p className="text-white font-medium">Follow us on X</p>
              </div>
              <ExternalLink className="w-4 h-4 text-p01-chrome/40" />
            </a>
          </div>
        </div>

        {/* Lock Button - Prominent */}
        <div className="px-4 mb-6">
          <button
            onClick={handleLock}
            className="w-full flex items-center justify-center gap-3 py-4 bg-p01-cyan text-p01-void font-bold text-base rounded-xl hover:bg-p01-cyan-dim transition-colors"
          >
            <LogOut className="w-6 h-6" />
            Disconnect Wallet
          </button>
        </div>

        {/* Version */}
        <div className="text-center py-6">
          <p className="text-p01-chrome/40 text-xs">Protocol v0.1.0</p>
          <p className="text-p01-chrome/30 text-[10px] mt-1">Made with ❤️ on Solana</p>
        </div>

        {/* Danger Zone - Hidden at bottom */}
        <div className="px-4 pb-6">
          <div className="border-t border-p01-border/30 pt-4">
            <button
              onClick={() => setShowResetConfirm(true)}
              className="w-full text-center text-p01-chrome/40 hover:text-red-400 text-[11px] transition-colors"
            >
              Delete Wallet
            </button>
          </div>
        </div>
      </div>

      {/* Reset Confirmation Modal */}
      {showResetConfirm && (
        <div className="absolute inset-0 bg-black/80 flex items-end justify-center p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="w-full bg-p01-surface rounded-2xl p-5"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                  <Trash2 className="w-5 h-5 text-red-500" />
                </div>
                <div>
                  <h3 id="delete-modal-title" className="text-lg font-display font-bold text-white">
                    Delete Wallet
                  </h3>
                  <p className="text-xs text-p01-chrome/60">
                    This cannot be undone
                  </p>
                </div>
              </div>
              <button
                onClick={closeResetModal}
                className="p-2 text-p01-chrome hover:text-white"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-red-500/10 rounded-xl p-3 mb-4 border border-red-500/20">
              <p className="text-xs text-red-400">
                ⚠️ This will permanently delete your wallet from this device. Make sure you have backed up your seed phrase. Without it, you will lose access to your funds forever.
              </p>
            </div>

            <div className="mb-4">
              <label htmlFor="reset-password" className="text-p01-chrome/60 text-xs mb-2 block">
                Enter password to confirm deletion
              </label>
              <input
                id="reset-password"
                type="password"
                value={resetPassword}
                onChange={(e) => {
                  setResetPassword(e.target.value);
                  setResetError('');
                }}
                placeholder="Your password"
                className="w-full px-4 py-3 bg-p01-void border border-p01-border rounded-xl text-white font-mono text-sm focus:outline-none focus:border-red-500"
                aria-describedby="reset-error"
              />
            </div>

            {resetError && (
              <div id="reset-error" className="flex items-center gap-2 p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400" role="alert" aria-live="polite">
                <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                <span className="text-xs">{resetError}</span>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={closeResetModal}
                className="flex-1 py-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-border transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleReset}
                disabled={resetLoading || !resetPassword}
                className="flex-1 py-3 bg-red-500 text-white font-medium rounded-xl hover:bg-red-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {resetLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  'Delete Wallet'
                )}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Notifications Modal */}
      {showNotifications && (
        <div className="absolute inset-0 bg-black/80 flex items-end justify-center p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="notif-modal-title">
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="w-full bg-p01-surface rounded-2xl p-5"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-warning/20 flex items-center justify-center">
                  <Bell className="w-5 h-5 text-warning" />
                </div>
                <h3 id="notif-modal-title" className="text-lg font-display font-bold text-white">
                  Notifications
                </h3>
              </div>
              <button
                onClick={() => setShowNotifications(false)}
                className="p-2 text-p01-chrome hover:text-white"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Transaction notifications */}
              <div className="flex items-center justify-between p-3 bg-p01-void rounded-xl">
                <div>
                  <p className="text-white font-medium text-sm">Transactions</p>
                  <p className="text-p01-chrome/60 text-xs">Notify on send/receive</p>
                </div>
                <button
                  onClick={() => {
                    const newValue = !notifyTransactions;
                    setNotifyTransactions(newValue);
                    saveNotificationSettings(newValue, notifySubscriptions, notifyPrice);
                  }}
                  role="switch"
                  aria-checked={notifyTransactions}
                  aria-label="Transaction notifications"
                  className={cn(
                    'w-12 h-7 rounded-full transition-colors relative',
                    notifyTransactions ? 'bg-p01-cyan' : 'bg-p01-border'
                  )}
                >
                  <motion.span
                    layout
                    className={cn(
                      'absolute top-1 w-5 h-5 rounded-full bg-white shadow-md',
                      notifyTransactions ? 'left-6' : 'left-1'
                    )}
                  />
                </button>
              </div>

              {/* Subscription notifications */}
              <div className="flex items-center justify-between p-3 bg-p01-void rounded-xl">
                <div>
                  <p className="text-white font-medium text-sm">Subscriptions</p>
                  <p className="text-p01-chrome/60 text-xs">Notify on payments</p>
                </div>
                <button
                  onClick={() => {
                    const newValue = !notifySubscriptions;
                    setNotifySubscriptions(newValue);
                    saveNotificationSettings(notifyTransactions, newValue, notifyPrice);
                  }}
                  role="switch"
                  aria-checked={notifySubscriptions}
                  aria-label="Subscription notifications"
                  className={cn(
                    'w-12 h-7 rounded-full transition-colors relative',
                    notifySubscriptions ? 'bg-p01-cyan' : 'bg-p01-border'
                  )}
                >
                  <motion.span
                    layout
                    className={cn(
                      'absolute top-1 w-5 h-5 rounded-full bg-white shadow-md',
                      notifySubscriptions ? 'left-6' : 'left-1'
                    )}
                  />
                </button>
              </div>

              {/* Price alerts */}
              <div className="flex items-center justify-between p-3 bg-p01-void rounded-xl">
                <div>
                  <p className="text-white font-medium text-sm">Price Alerts</p>
                  <p className="text-p01-chrome/60 text-xs">SOL price changes</p>
                </div>
                <button
                  onClick={() => {
                    const newValue = !notifyPrice;
                    setNotifyPrice(newValue);
                    saveNotificationSettings(notifyTransactions, notifySubscriptions, newValue);
                  }}
                  role="switch"
                  aria-checked={notifyPrice}
                  aria-label="Price alert notifications"
                  className={cn(
                    'w-12 h-7 rounded-full transition-colors relative',
                    notifyPrice ? 'bg-p01-cyan' : 'bg-p01-border'
                  )}
                >
                  <motion.span
                    layout
                    className={cn(
                      'absolute top-1 w-5 h-5 rounded-full bg-white shadow-md',
                      notifyPrice ? 'left-6' : 'left-1'
                    )}
                  />
                </button>
              </div>
            </div>

            <button
              onClick={() => setShowNotifications(false)}
              className="w-full mt-4 py-3 bg-p01-cyan text-p01-void font-medium rounded-xl hover:bg-p01-cyan-dim transition-colors"
            >
              Done
            </button>
          </motion.div>
        </div>
      )}

      {/* Backup Seed Phrase Modal */}
      {showBackupModal && (
        <div className="absolute inset-0 bg-black/80 flex items-end justify-center p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="backup-modal-title">
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="w-full bg-p01-surface rounded-2xl p-5"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-p01-pink/20 flex items-center justify-center">
                  <Key className="w-5 h-5 text-p01-pink" />
                </div>
                <h3 id="backup-modal-title" className="text-lg font-display font-bold text-white">
                  Backup Seed Phrase
                </h3>
              </div>
              <button
                onClick={closeBackupModal}
                className="p-2 text-p01-chrome hover:text-white"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {!seedPhrase ? (
              <>
                <div className="bg-red-500/10 rounded-xl p-3 mb-4 border border-red-500/20">
                  <p className="text-xs text-red-400">
                    ⚠️ Never share your seed phrase. Anyone with it can access your funds.
                  </p>
                </div>

                <div className="mb-4">
                  <label htmlFor="backup-password" className="text-p01-chrome/60 text-xs mb-2 block">
                    Enter password to reveal
                  </label>
                  <input
                    id="backup-password"
                    type="password"
                    value={backupPassword}
                    onChange={(e) => {
                      setBackupPassword(e.target.value);
                      setBackupError('');
                    }}
                    placeholder="Your password"
                    className="w-full px-4 py-3 bg-p01-void border border-p01-border rounded-xl text-white font-mono text-sm focus:outline-none focus:border-p01-cyan"
                  />
                </div>

                {backupError && (
                  <div className="flex items-center gap-2 p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400" role="alert" aria-live="polite">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                    <span className="text-xs">{backupError}</span>
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={closeBackupModal}
                    className="flex-1 py-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-border transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleBackupReveal}
                    disabled={backupLoading || !backupPassword}
                    className="flex-1 py-3 bg-p01-pink text-white font-medium rounded-xl hover:bg-p01-pink/80 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {backupLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Verifying...
                      </>
                    ) : (
                      'Reveal'
                    )}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 mb-4">
                  {seedPhrase.map((word, index) => (
                    <div
                      key={index}
                      className="bg-p01-void rounded-lg p-2 text-center"
                    >
                      <span className="text-p01-chrome/40 text-[10px]">{index + 1}.</span>
                      <span className="text-white text-xs ml-1 font-mono">{word}</span>
                    </div>
                  ))}
                </div>

                <button
                  onClick={handleCopySeed}
                  className="w-full py-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-border transition-colors flex items-center justify-center gap-2 mb-3"
                >
                  {seedCopied ? (
                    <>
                      <Check className="w-4 h-4 text-p01-cyan" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      Copy Seed Phrase
                    </>
                  )}
                </button>

                <button
                  onClick={closeBackupModal}
                  className="w-full py-3 bg-p01-cyan text-p01-void font-medium rounded-xl hover:bg-p01-cyan-dim transition-colors"
                >
                  Done
                </button>
              </>
            )}
          </motion.div>
        </div>
      )}

      {/* Change Password Modal */}
      {showPasswordModal && (
        <div className="absolute inset-0 bg-black/80 flex items-end justify-center p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="password-modal-title">
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="w-full bg-p01-surface rounded-2xl p-5"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-p01-cyan/20 flex items-center justify-center">
                  <Lock className="w-5 h-5 text-p01-cyan" />
                </div>
                <h3 id="password-modal-title" className="text-lg font-display font-bold text-white">
                  Change Password
                </h3>
              </div>
              <button
                onClick={closePasswordModal}
                className="p-2 text-p01-chrome hover:text-white"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {passwordSuccess ? (
              <div className="text-center py-4">
                <div className="w-16 h-16 rounded-full bg-p01-cyan/20 flex items-center justify-center mx-auto mb-4">
                  <Check className="w-8 h-8 text-p01-cyan" />
                </div>
                <p className="text-white font-medium">Password Changed!</p>
                <p className="text-p01-chrome/60 text-sm mt-1">Redirecting to unlock...</p>
              </div>
            ) : (
              <>
                <div className="space-y-3 mb-4">
                  <div>
                    <label htmlFor="current-password" className="text-p01-chrome/60 text-xs mb-1 block">Current Password</label>
                    <input
                      id="current-password"
                      type="password"
                      value={currentPassword}
                      onChange={(e) => {
                        setCurrentPassword(e.target.value);
                        setPasswordError('');
                      }}
                      placeholder="Enter current password"
                      className="w-full px-4 py-3 bg-p01-void border border-p01-border rounded-xl text-white font-mono text-sm focus:outline-none focus:border-p01-cyan"
                    />
                  </div>
                  <div>
                    <label htmlFor="new-password" className="text-p01-chrome/60 text-xs mb-1 block">New Password</label>
                    <input
                      id="new-password"
                      type="password"
                      value={newPassword}
                      onChange={(e) => {
                        setNewPassword(e.target.value);
                        setPasswordError('');
                      }}
                      placeholder="Min 8 characters"
                      className="w-full px-4 py-3 bg-p01-void border border-p01-border rounded-xl text-white font-mono text-sm focus:outline-none focus:border-p01-cyan"
                    />
                  </div>
                  <div>
                    <label htmlFor="confirm-new-password" className="text-p01-chrome/60 text-xs mb-1 block">Confirm New Password</label>
                    <input
                      id="confirm-new-password"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => {
                        setConfirmPassword(e.target.value);
                        setPasswordError('');
                      }}
                      placeholder="Confirm new password"
                      className="w-full px-4 py-3 bg-p01-void border border-p01-border rounded-xl text-white font-mono text-sm focus:outline-none focus:border-p01-cyan"
                    />
                  </div>
                </div>

                {passwordError && (
                  <div className="flex items-center gap-2 p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400" role="alert" aria-live="polite">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                    <span className="text-xs">{passwordError}</span>
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={closePasswordModal}
                    className="flex-1 py-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-border transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleChangePassword}
                    disabled={passwordLoading || !currentPassword || !newPassword || !confirmPassword}
                    className="flex-1 py-3 bg-p01-cyan text-p01-void font-medium rounded-xl hover:bg-p01-cyan/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {passwordLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Changing...
                      </>
                    ) : (
                      'Change Password'
                    )}
                  </button>
                </div>
              </>
            )}
          </motion.div>
        </div>
      )}
    </div>
  );
}
