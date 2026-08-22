/**
 * Settings.
 *
 * 🎯 WHAT THIS PASS CHANGED, AND WHY
 * ─────────────────────────────────
 * This screen was 1113 lines and it looked like five different products
 * stacked on top of each other. Every setting line was hand-built: its own
 * padding, its own icon chip, its own 28px toggle, its own `text-p01-text`. Four
 * modals repeated the same overlay markup four times with four different
 * headings. The result is now one `Row` per line, one `Toggle`, one `Sheet`,
 * and the kit's `Button`/`Field` everywhere else.
 *
 * ⛔ THE SECTION LABELS ARE LITERAL CAPITALS ON PURPOSE. `PREFERENCES`,
 * `SECURITY` and `SUPPORT` are pinned by Settings.test.tsx as text content, so
 * the strings stay as they are; `Eyebrow` would have uppercased them anyway, so
 * nothing renders differently. Do not "fix" the casing without the test.
 *
 * 🚨 EVERY TOGGLE IS NOW A 44px TARGET. They were 48×28 pixel switches — under
 * the minimum, and the smallest things on the screen were the ones that turn
 * privacy features off. The track still reads 44×24; the button around it is
 * 44px tall and carries the focus ring.
 *
 * ⚠️ THE PASSWORD ERRORS MOVED UNDER THEIR FIELDS. "Current password is
 * incorrect" used to appear in a red box above the buttons, three fields away
 * from the one it was about. The strings are untouched — `handleChangePassword`
 * is not a UI concern — they are only routed to the field they describe.
 *
 * Deleted: the "Made with ❤️ on Solana" line, the 64px success circle after a
 * password change (the flow auto-locks 1.5s later, so a celebration nobody has
 * time to read was pure noise), the duplicate "Done" under a revealed seed
 * phrase (the sheet already closes), and every `text-p01-text`.
 */

import { useState, useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  BarChart3,
  Bell,
  Check,
  Copy,
  Eye,
  EyeOff,
  Globe,
  HelpCircle,
  Key,
  Lock,
  LogOut,
  Route,
  Shield,
  Smartphone,
  Wifi,
  X,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { useSettingsStore } from '@/shared/store/settings';
import { useShieldedStore } from '@/shared/store/shielded';
import { cn, truncateAddress, copyToClipboard } from '@/shared/utils';
import { decrypt, encrypt, verifyPassword, hashPassword } from '@/shared/services/crypto';
import Wordmark from '@/popup/components/Wordmark';
import { Button, Eyebrow, Field, Hairline, Panel, Row, Screen } from '@/popup/ui';

/** The product's own site. Used only as the destination for Help. */
const HELP_URL = 'https://protocol-01.dev';
const X_URL = 'https://x.com/Protocol01_';

/* ── Toggle ───────────────────────────────────────────────────────────────
   One switch for the whole screen. The button is 44px tall so it clears the
   minimum target; the visible track sits inside it. */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className="relative flex h-11 w-12 shrink-0 items-center justify-center rounded-full outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
    >
      <span
        className={cn(
          'block h-6 w-11 rounded-full transition-colors duration-exit',
          checked ? 'bg-p01-cyan' : 'bg-p01-border',
        )}
      />
      <span
        className={cn(
          'absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full transition-all duration-exit',
          checked ? 'left-[26px] bg-p01-void' : 'left-1 bg-p01-text-muted',
        )}
      />
    </button>
  );
}

/* ── Sheet ────────────────────────────────────────────────────────────────
   The overlay used to be copy-pasted four times. It animates with the global
   `animate-slideUp`, which the stylesheet already disables under
   prefers-reduced-motion — the framer-motion version did not. */
function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = `sheet-${title.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div
      className="absolute inset-0 z-50 flex items-end bg-p01-void/85 p-3"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="w-full animate-slideUp rounded-2xl border border-p01-border bg-p01-dark p-4 shadow-sheet">
        <div className="mb-2 flex items-start justify-between gap-2">
          <h2 id={titleId} className="mt-2 font-display text-lg font-normal tracking-tight">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-p01-text-muted outline-none transition-colors duration-exit hover:text-p01-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

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

  /**
   * ⚠️ Presentation only. `handleChangePassword` owns these strings; this just
   * decides which field each one belongs under. Anything that is not about a
   * single field falls through to `formLevelPasswordError` below.
   */
  const passwordErrorFor = (field: 'current' | 'new' | 'confirm') => {
    if (!passwordError) return undefined;
    if (passwordError === 'Current password is incorrect') return field === 'current' ? passwordError : undefined;
    if (passwordError === 'New password must be at least 8 characters') return field === 'new' ? passwordError : undefined;
    if (passwordError === 'Passwords do not match') return field === 'confirm' ? passwordError : undefined;
    return undefined;
  };
  const formLevelPasswordError =
    passwordError &&
    !passwordErrorFor('current') &&
    !passwordErrorFor('new') &&
    !passwordErrorFor('confirm')
      ? passwordError
      : '';

  return (
    <div className="relative h-full">
      <Screen
        title="Settings"
        onBack={() => navigate(-1)}
        footer={
          <Button variant="secondary" full size="lg" icon={LogOut} onClick={handleLock}>
            Disconnect Wallet
          </Button>
        }
      >
        <div className="flex flex-col gap-6">
          {/* ── The account. One card, one action: copy the address. ── */}
          <button
            onClick={handleCopy}
            aria-label={copied ? 'Wallet address copied' : 'Copy wallet address'}
            className="flex w-full items-center gap-3 rounded-xl border border-p01-border bg-p01-surface p-3 text-left outline-none transition-colors duration-exit hover:border-p01-border-light focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-p01-border-soft">
              <Wordmark size={20} showText={false} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-p01-text">My Wallet</span>
              <span className="block truncate font-mono text-tiny text-p01-text-muted">
                {publicKey ? truncateAddress(publicKey, 6) : '----'}
              </span>
            </span>
            {copied ? (
              <Check className="h-4 w-4 shrink-0 text-p01-cyan" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4 shrink-0 text-p01-text-dim" aria-hidden="true" />
            )}
          </button>

          {/* ── PREFERENCES ── */}
          <section>
            <Eyebrow>PREFERENCES</Eyebrow>
            <div className="mt-1 flex flex-col">
              <Row
                label="Network"
                icon={Wifi}
                value={
                  <span className="flex items-center gap-1 rounded-lg border border-p01-border p-0.5">
                    {([
                      ['devnet', 'Devnet'],
                      ['mainnet-beta', 'Mainnet'],
                    ] as const).map(([id, label]) => (
                      <button
                        key={id}
                        onClick={() => setNetwork(id)}
                        aria-pressed={network === id}
                        className={cn(
                          'min-h-[44px] rounded-md px-3 text-tiny outline-none transition-colors duration-exit',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan',
                          network === id
                            ? // Devnet is a caution state, and amber is what caution
                              // looks like here. Mainnet is the accent.
                              id === 'devnet'
                              ? 'bg-p01-amber/15 text-p01-amber'
                              : 'bg-p01-cyan/15 text-p01-cyan'
                            : 'text-p01-text-dim hover:text-p01-text',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </span>
                }
              />
              <Hairline className="bg-p01-border-soft" />
              <Row
                label="Hide Balance"
                sub="Mask amounts in the wallet"
                icon={hideBalance ? EyeOff : Eye}
                value={
                  <Toggle checked={hideBalance} onChange={toggleHideBalance} label="Hide balance" />
                }
              />
              <Hairline className="bg-p01-border-soft" />
              <Row
                label="Notifications"
                sub="Transactions, subscriptions, price"
                icon={Bell}
                chevron
                onClick={() => setShowNotifications(true)}
              />
            </div>
          </section>

          {/* ── PRIVACY FEATURES ──
              Two of these are retired and say so in their own line rather than
              in a badge nobody reads. */}
          <section>
            <Eyebrow>PRIVACY FEATURES</Eyebrow>
            <div className="mt-1 flex flex-col">
              <Row
                label="Shielded wallet"
                sub={
                  hasShieldedFunds
                    ? `Legacy · ${shieldedBalance.toFixed(4)} SOL, withdraw it`
                    : 'Legacy · the privacy pool replaces it'
                }
                icon={Shield}
                value={
                  <Toggle
                    checked={shieldedWalletEnabled}
                    onChange={() => setShieldedWalletEnabled(!shieldedWalletEnabled)}
                    label="Shielded wallet"
                  />
                }
              />
              <Hairline className="bg-p01-border-soft" />
              <Row
                label="Confidential balance"
                sub="Legacy · hides amounts, not addresses"
                icon={BarChart3}
                value={
                  <Toggle
                    checked={confidentialBalanceEnabled}
                    onChange={() => setConfidentialBalanceEnabled(!confidentialBalanceEnabled)}
                    label="Confidential balance"
                  />
                }
              />
              <Hairline className="bg-p01-border-soft" />
              <Row
                label="Privacy relayer"
                sub="Hides your IP when withdrawing"
                icon={Route}
                value={
                  <Toggle
                    checked={relayerEnabled}
                    onChange={() => setRelayerEnabled(!relayerEnabled)}
                    label="Privacy relayer"
                  />
                }
              />
            </div>
          </section>

          {/* ── SECURITY ── */}
          <section>
            <Eyebrow>SECURITY</Eyebrow>
            <div className="mt-1 flex flex-col">
              <Row
                label="Backup Seed Phrase"
                icon={Key}
                chevron
                onClick={() => setShowBackupModal(true)}
              />
              <Hairline className="bg-p01-border-soft" />
              <Row
                label="Link a phone"
                sub="Import this wallet by QR"
                icon={Smartphone}
                chevron
                onClick={() => navigate('/link-phone')}
              />
              <Hairline className="bg-p01-border-soft" />
              <Row
                label="Change Password"
                icon={Lock}
                chevron
                onClick={() => setShowPasswordModal(true)}
              />
              <Hairline className="bg-p01-border-soft" />
              <Row
                label="Connected Sites"
                sub="Sites that can see this wallet"
                icon={Globe}
                chevron
                onClick={() => navigate('/connected-sites')}
              />
            </div>
          </section>

          {/* ── SUPPORT ── */}
          <section>
            <Eyebrow>SUPPORT</Eyebrow>
            <div className="mt-1 flex flex-col">
              <Row
                label="Help & FAQ"
                icon={HelpCircle}
                value={<ArrowUpRight className="h-4 w-4 text-p01-text-dim" aria-hidden="true" />}
                onClick={() => window.open(HELP_URL, '_blank', 'noopener,noreferrer')}
              />
              <Hairline className="bg-p01-border-soft" />
              <Row
                label="Follow us on X"
                value={<ArrowUpRight className="h-4 w-4 text-p01-text-dim" aria-hidden="true" />}
                onClick={() => window.open(X_URL, '_blank', 'noopener,noreferrer')}
              />
            </div>
          </section>

          {/* ── The end of the list. Version, then the one irreversible thing. ── */}
          <div className="flex flex-col items-center gap-1 pb-2">
            <p className="text-tiny text-p01-text-dim">Protocol v0.1.0</p>
            <Button
              variant="ghost"
              className="text-tiny hover:text-p01-red"
              onClick={() => setShowResetConfirm(true)}
            >
              Delete Wallet
            </Button>
          </div>
        </div>
      </Screen>

      {/* ── Delete wallet ── */}
      {showResetConfirm && (
        <Sheet title="Delete Wallet" onClose={closeResetModal}>
          <p className="text-tiny text-p01-text-muted">This cannot be undone</p>
          <p className="mt-2 text-sm text-p01-red">
            The wallet is removed from this device. Without your seed phrase the funds are gone for
            good.
          </p>

          <div className="mt-4">
            <Field
              id="reset-password"
              label="Enter password to confirm deletion"
              type="password"
              value={resetPassword}
              onChange={(e) => {
                setResetPassword(e.target.value);
                setResetError('');
              }}
              placeholder="Your password"
              error={resetError || undefined}
              autoFocus
            />
          </div>

          <div className="mt-4 flex gap-2">
            <Button variant="secondary" full onClick={closeResetModal}>
              Cancel
            </Button>
            <Button
              variant="danger"
              full
              loading={resetLoading}
              disabled={!resetPassword}
              onClick={handleReset}
            >
              Delete forever
            </Button>
          </div>
        </Sheet>
      )}

      {/* ── Notifications ── */}
      {showNotifications && (
        <Sheet title="Notifications" onClose={() => setShowNotifications(false)}>
          <div className="flex flex-col">
            <Row
              label="Transactions"
              sub="When you send or receive"
              value={
                <Toggle
                  checked={notifyTransactions}
                  onChange={() => {
                    const newValue = !notifyTransactions;
                    setNotifyTransactions(newValue);
                    saveNotificationSettings(newValue, notifySubscriptions, notifyPrice);
                  }}
                  label="Transaction notifications"
                />
              }
            />
            <Hairline className="bg-p01-border-soft" />
            <Row
              label="Subscriptions"
              sub="When a payment goes out"
              value={
                <Toggle
                  checked={notifySubscriptions}
                  onChange={() => {
                    const newValue = !notifySubscriptions;
                    setNotifySubscriptions(newValue);
                    saveNotificationSettings(notifyTransactions, newValue, notifyPrice);
                  }}
                  label="Subscription notifications"
                />
              }
            />
            <Hairline className="bg-p01-border-soft" />
            <Row
              label="Price Alerts"
              sub="When SOL moves"
              value={
                <Toggle
                  checked={notifyPrice}
                  onChange={() => {
                    const newValue = !notifyPrice;
                    setNotifyPrice(newValue);
                    saveNotificationSettings(notifyTransactions, notifySubscriptions, newValue);
                  }}
                  label="Price alert notifications"
                />
              }
            />
          </div>

          <Button full size="lg" className="mt-4" onClick={() => setShowNotifications(false)}>
            Done
          </Button>
        </Sheet>
      )}

      {/* ── Backup seed phrase ── */}
      {showBackupModal && (
        <Sheet title="Backup Seed Phrase" onClose={closeBackupModal}>
          {!seedPhrase ? (
            <>
              <Panel tone="warn">
                <p className="text-tiny text-p01-amber">
                  Anyone who reads these twelve words owns this wallet. Never share them, and never
                  type them into a site.
                </p>
              </Panel>

              <div className="mt-4">
                <Field
                  id="backup-password"
                  label="Enter password to reveal"
                  type="password"
                  value={backupPassword}
                  onChange={(e) => {
                    setBackupPassword(e.target.value);
                    setBackupError('');
                  }}
                  placeholder="Your password"
                  error={backupError || undefined}
                  autoFocus
                />
              </div>

              <div className="mt-4 flex gap-2">
                <Button variant="secondary" full onClick={closeBackupModal}>
                  Cancel
                </Button>
                <Button
                  full
                  loading={backupLoading}
                  disabled={!backupPassword}
                  onClick={handleBackupReveal}
                >
                  Reveal
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-1.5">
                {seedPhrase.map((word, index) => (
                  <div
                    key={index}
                    className="flex items-baseline gap-1 rounded-lg border border-p01-border-soft bg-p01-void px-2 py-1.5"
                  >
                    <span className="text-[0.625rem] tabular text-p01-text-dim">{index + 1}</span>
                    <span className="truncate font-mono text-tiny text-p01-text">{word}</span>
                  </div>
                ))}
              </div>

              <Button
                variant="secondary"
                full
                size="lg"
                className="mt-4"
                icon={seedCopied ? Check : Copy}
                onClick={handleCopySeed}
              >
                {seedCopied ? 'Copied' : 'Copy seed phrase'}
              </Button>
            </>
          )}
        </Sheet>
      )}

      {/* ── Change password ── */}
      {showPasswordModal && (
        <Sheet title="Change Password" onClose={closePasswordModal}>
          {passwordSuccess ? (
            /* No success page and no Done button: the flow locks the wallet
               1.5s from here, so this is a status line, not a destination. */
            <p className="flex items-center gap-2 py-2 text-sm text-p01-text" role="status">
              <Check className="h-4 w-4 shrink-0 text-p01-cyan" aria-hidden="true" />
              Password changed. Locking the wallet…
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                <Field
                  id="current-password"
                  label="Current Password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => {
                    setCurrentPassword(e.target.value);
                    setPasswordError('');
                  }}
                  placeholder="Your current password"
                  error={passwordErrorFor('current')}
                  autoFocus
                />
                <Field
                  id="new-password"
                  label="New Password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    setPasswordError('');
                  }}
                  placeholder="At least 8 characters"
                  error={passwordErrorFor('new')}
                />
                <Field
                  id="confirm-new-password"
                  label="Confirm New Password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    setPasswordError('');
                  }}
                  placeholder="Type it again"
                  error={passwordErrorFor('confirm')}
                />
              </div>

              {formLevelPasswordError && (
                <p role="alert" className="mt-3 text-tiny text-p01-red">
                  {formLevelPasswordError}
                </p>
              )}

              <div className="mt-4 flex gap-2">
                <Button variant="secondary" full onClick={closePasswordModal}>
                  Cancel
                </Button>
                <Button
                  full
                  loading={passwordLoading}
                  disabled={!currentPassword || !newPassword || !confirmPassword}
                  onClick={handleChangePassword}
                >
                  Update
                </Button>
              </div>
            </>
          )}
        </Sheet>
      )}
    </div>
  );
}
