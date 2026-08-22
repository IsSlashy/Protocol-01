import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useWalletStore } from '@/shared/store/wallet';

// Layouts
import MainLayout from './layouts/MainLayout';

// Pages
import Welcome from './pages/Welcome';
import CreateWallet from './pages/CreateWallet';
import ImportWallet from './pages/ImportWallet';
import ConnectPhone from './pages/ConnectPhone';
import Unlock from './pages/Unlock';
import Home from './pages/Home';
import Send from './pages/Send';
import SendConfirm from './pages/SendConfirm';
import Receive from './pages/Receive';
import Discover from './pages/Discover';
import Shield from './pages/Shield';
import Subscriptions from './pages/Subscriptions';
import CreateSubscription from './pages/CreateSubscription';
import SubscriptionDetails from './pages/SubscriptionDetails';
import Activity from './pages/Activity';
import Settings from './pages/Settings';
import ConnectDapp from './pages/ConnectDapp';
import ApproveTransaction from './pages/ApproveTransaction';
import ApproveSubscription from './pages/ApproveSubscription';
import ConnectedSites from './pages/ConnectedSites';
import DenominatedUnshield from './pages/DenominatedUnshield';
import DenominatedTransfer from './pages/DenominatedTransfer';
import DenominatedImport from './pages/DenominatedImport';
import LinkPhone from './pages/LinkPhone';
import Wordmark from '@/popup/components/Wordmark';

function App() {
  const [isHydrated, setIsHydrated] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const { isInitialized, isUnlocked, encryptedSeedPhrase, reset, tryAutoUnlock } = useWalletStore();
  const navigate = useNavigate();
  const location = useLocation();

  // Check for pending approval requests when popup opens
  useEffect(() => {
    const checkPendingApproval = async () => {
      try {
        const result = await chrome.storage.session.get(['pendingApprovalPath', 'pendingApprovalTimestamp']);
        if (result.pendingApprovalPath) {
          // Only use if recent (within last 5 minutes)
          const isRecent = result.pendingApprovalTimestamp &&
            (Date.now() - result.pendingApprovalTimestamp) < 5 * 60 * 1000;

          if (isRecent) {
            setPendingPath(result.pendingApprovalPath);
          }

          // Clear the pending path
          await chrome.storage.session.remove(['pendingApprovalPath', 'pendingApprovalTimestamp']);

          // Clear any badge
          try {
            await chrome.action.setBadgeText({ text: '' });
          } catch {
            // Badge API might not be available
          }
        }
      } catch (e) {
        console.error('[Popup] Error checking pending approval:', e);
      }
    };
    checkPendingApproval();
  }, []);

  // Redirect to pending approval path when there's a pending request
  useEffect(() => {
    if (isHydrated && pendingPath) {
      // Only redirect if we're not already on an approval page
      const isOnApprovalPage = location.pathname.startsWith('/connect') ||
                               location.pathname.startsWith('/approve');
      const isOnAuthPage = location.pathname.startsWith('/unlock') ||
                           location.pathname.startsWith('/welcome') ||
                           location.pathname.startsWith('/create-wallet');

      if (!isOnApprovalPage && !isOnAuthPage) {
        // If wallet is locked, go to unlock first, then to approval
        if (isInitialized && !isUnlocked) {
          // Store the pending path for after unlock
          chrome.storage.session.set({ afterUnlockPath: pendingPath });
          navigate('/unlock');
        } else if (!isInitialized) {
          navigate('/welcome');
        } else {
          navigate(pendingPath);
        }
        setPendingPath(null);
      }
    }
  }, [isHydrated, pendingPath, isInitialized, isUnlocked, navigate, location.pathname]);

  // Wait for store hydration, verify storage state, and try auto-unlock
  useEffect(() => {
    const verifyAndHydrate = async () => {
      try {
        const STORE_KEY = 'p01-wallet';
        const result = await chrome.storage.local.get(STORE_KEY);
        const storedData = result[STORE_KEY];
        const parsed = storedData ? JSON.parse(storedData) : null;
        const hasEncryptedSeed = parsed?.state?.encryptedSeedPhrase;
        const storedIsInit = parsed?.state?.isInitialized;

        console.log('[Popup] Storage check:', {
          hasData: !!storedData,
          isInit: storedIsInit,
          hasSeed: !!hasEncryptedSeed,
        });

        // Reset if wallet claims initialized but has NO seed phrase. Post
        // Privy-removal the seed phrase is the only signing material, so this
        // catches genuinely corrupted (or orphaned ex-Privy) state without
        // nuking valid local wallets.
        if (storedIsInit && !hasEncryptedSeed) {
          console.log('[Popup] Reset: Corrupted state — initialized without seed');
          await reset();
        }
      } catch (e) {
        console.error('[Popup] Error verifying storage:', e);
      }

      // Re-check after potential reset
      const currentState = useWalletStore.getState();

      // Try auto-unlock from saved session (10 minute timeout).
      if (currentState.isInitialized && !currentState.isUnlocked) {
        await tryAutoUnlock();
      }

      setIsHydrated(true);
    };

    verifyAndHydrate();
  }, []);

  // Show loading state while hydrating (max 3s then force show)
  useEffect(() => {
    const forceTimeout = setTimeout(() => {
      if (!isHydrated) setIsHydrated(true);
    }, 3000);
    return () => clearTimeout(forceTimeout);
  }, [isHydrated]);

  if (!isHydrated) {
    return (
      <div className="w-[360px] h-[600px] bg-p01-void flex items-center justify-center">
        <div className="text-center">
          {/* Was the 01 raster. The mark is drawn now, so the boot state
              renders before any asset has to load. */}
          <Wordmark size={44} showText={false} className="mx-auto mb-4 justify-center" />
          <p className="text-white font-display font-bold text-sm tracking-wider mb-1">
            PROTOCOL
          </p>
          <p className="text-[10px] text-p01-chrome/60 font-mono tracking-wider">
            LOADING...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-[360px] h-[600px] bg-p01-void overflow-hidden">
      <Routes>
        {/* Auth routes - standalone pages with their own branding (no layout header) */}
        <Route path="/welcome" element={<Welcome />} />
        <Route path="/create-wallet" element={<CreateWallet />} />
        <Route path="/import-wallet" element={<ImportWallet />} />
        <Route path="/connect-phone" element={<ConnectPhone />} />
        <Route path="/unlock" element={<Unlock />} />

        {/* Main app routes - protected, require unlock */}
        <Route element={<MainLayout />}>
          <Route path="/" element={
            !isInitialized || !encryptedSeedPhrase ? <Navigate to="/welcome" replace /> :
            !isUnlocked ? <Navigate to="/unlock" replace /> :
            <Home />
          } />
          <Route path="/send" element={<Send />} />
          <Route path="/send/confirm" element={<SendConfirm />} />
          <Route path="/receive" element={<Receive />} />
          <Route path="/discover" element={<Discover />} />
          <Route path="/subscriptions" element={<Subscriptions />} />
          <Route path="/subscriptions/new" element={<CreateSubscription />} />
          <Route path="/subscriptions/:id" element={<SubscriptionDetails />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/link-phone" element={<LinkPhone />} />
          <Route path="/connected-sites" element={<ConnectedSites />} />
          {/* ── The shield family, one tab ────────────────────────────
              /shield is now the action, not a dashboard pointing at one.
              ⚠️ THE OLD PATHS MUST KEEP RESOLVING. background/index.ts builds
              deep links as bare strings, and App.tsx restores a pendingPath
              after unlock, so a hash URL from either can still name a route
              this table would otherwise no longer know. Redirects, not
              deletions. */}
          <Route path="/shield" element={<Shield />} />
          <Route path="/shield/withdraw" element={<DenominatedUnshield />} />
          <Route path="/shield/send-note" element={<DenominatedTransfer />} />
          <Route path="/shield/receive-note" element={<DenominatedImport />} />

          <Route path="/shielded" element={<Navigate to="/shield" replace />} />
          <Route path="/denominated-shield" element={<Navigate to="/shield" replace />} />
          <Route path="/denominated-unshield" element={<Navigate to="/shield/withdraw" replace />} />
          <Route path="/denominated-transfer" element={<Navigate to="/shield/send-note" replace />} />
          <Route path="/denominated-import" element={<Navigate to="/shield/receive-note" replace />} />

          {/* ⛔ PARKED 2026-08-23, not deleted. Founder ruling: personal
              payments are parked and the agent is retired. The files stay so
              the work is recoverable; the routes go so nothing lands on them.
              /swap and /confidential were already unreachable in practice. */}
          <Route path="/agent" element={<Navigate to="/discover" replace />} />
          <Route path="/stealth-payments" element={<Navigate to="/shield" replace />} />
          <Route path="/swap" element={<Navigate to="/" replace />} />
          <Route path="/confidential" element={<Navigate to="/shield" replace />} />
          <Route path="/subscription-vaults" element={<Navigate to="/subscriptions" replace />} />
        </Route>

        {/* Popup request routes (from dApps) */}
        <Route path="/connect" element={<ConnectDapp />} />
        <Route path="/approve" element={<ApproveTransaction />} />
        <Route path="/approve-subscription" element={<ApproveSubscription />} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to={
          !isInitialized || !encryptedSeedPhrase ? "/welcome" :
          isUnlocked ? "/" : "/unlock"
        } replace />} />
      </Routes>
    </div>
  );
}

export default App;
