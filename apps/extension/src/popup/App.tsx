import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useWalletStore } from '@/shared/store/wallet';
import { usePrivy } from '@/shared/providers/PrivyProvider';

// Layouts
import MainLayout from './layouts/MainLayout';

// Pages
import Welcome from './pages/Welcome';
import CreateWallet from './pages/CreateWallet';
import ImportWallet from './pages/ImportWallet';
import Unlock from './pages/Unlock';
import Home from './pages/Home';
import Send from './pages/Send';
import SendConfirm from './pages/SendConfirm';
import Receive from './pages/Receive';
import Swap from './pages/Swap';
import Subscriptions from './pages/Subscriptions';
import CreateSubscription from './pages/CreateSubscription';
import SubscriptionDetails from './pages/SubscriptionDetails';
import Activity from './pages/Activity';
import Settings from './pages/Settings';
import Agent from './pages/Agent';
import Buy from './pages/Buy';
import StealthPayments from './pages/StealthPayments';
import ShieldedWallet from './pages/ShieldedWallet';
import ShieldedTransfer from './pages/ShieldedTransfer';
import ConnectDapp from './pages/ConnectDapp';
import ApproveTransaction from './pages/ApproveTransaction';
import ApproveSubscription from './pages/ApproveSubscription';
import ConnectedSites from './pages/ConnectedSites';

function App() {
  const [isHydrated, setIsHydrated] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const { isInitialized, isUnlocked, isPrivyWallet, reset, tryAutoUnlock } = useWalletStore();
  const { ready: privyReady, authenticated: privyAuthenticated } = usePrivy();
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
        // Check storage state
        const result = await chrome.storage.local.get('p01-wallet');
        const storedData = result['p01-wallet'];
        const parsed = storedData ? JSON.parse(storedData) : null;
        const hasEncryptedSeed = parsed?.state?.encryptedSeedPhrase;
        const storedIsPrivy = parsed?.state?.isPrivyWallet;
        const storedIsInit = parsed?.state?.isInitialized;

        // Case 1: Privy wallet but not authenticated → reset
        if (storedIsPrivy && !privyAuthenticated) {
          await reset();
        }
        // Case 2: Not Privy, claims initialized but no seed phrase → reset
        else if (!storedIsPrivy && storedIsInit && !hasEncryptedSeed) {
          await reset();
        }
        // Case 3: No storage at all but store thinks initialized → reset
        else if (!storedData && isInitialized) {
          await reset();
        }
      } catch (e) {
        console.error('[Popup] Error verifying storage:', e);
      }

      // Try auto-unlock from session (10 minute timeout) — legacy wallets only
      if (isInitialized && !isUnlocked && !isPrivyWallet) {
        await tryAutoUnlock();
      }

      // Give a bit more time for proper hydration
      setTimeout(() => {
        setIsHydrated(true);
      }, 50);
    };

    // Wait for Privy to be ready before verifying
    if (privyReady) {
      verifyAndHydrate();
    }
  }, [privyReady]);

  // Show loading state while hydrating or while Privy SDK is initializing
  if (!isHydrated || !privyReady) {
    return (
      <div className="w-[360px] h-[600px] bg-p01-void flex items-center justify-center">
        <div className="text-center">
          <img
            src="/01-miku.png"
            alt="Protocol 01"
            className="w-16 h-16 mx-auto mb-4 rounded-xl animate-pulse"
          />
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
        <Route path="/unlock" element={<Unlock />} />

        {/* Main app routes - protected, require unlock */}
        <Route element={<MainLayout />}>
          <Route path="/" element={
            isInitialized && !isUnlocked && !isPrivyWallet && !privyAuthenticated ? <Navigate to="/unlock" replace /> : <Home />
          } />
          <Route path="/send" element={<Send />} />
          <Route path="/send/confirm" element={<SendConfirm />} />
          <Route path="/receive" element={<Receive />} />
          <Route path="/swap" element={<Swap />} />
          <Route path="/subscriptions" element={<Subscriptions />} />
          <Route path="/subscriptions/new" element={<CreateSubscription />} />
          <Route path="/subscriptions/:id" element={<SubscriptionDetails />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/buy" element={<Buy />} />
          <Route path="/agent" element={<Agent />} />
          <Route path="/stealth-payments" element={<StealthPayments />} />
          <Route path="/shielded" element={<ShieldedWallet />} />
          <Route path="/shielded/transfer" element={<ShieldedTransfer />} />
          <Route path="/connected-sites" element={<ConnectedSites />} />
        </Route>

        {/* Popup request routes (from dApps) */}
        <Route path="/connect" element={<ConnectDapp />} />
        <Route path="/approve" element={<ApproveTransaction />} />
        <Route path="/approve-subscription" element={<ApproveSubscription />} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to={isInitialized ? ((isUnlocked || isPrivyWallet || privyAuthenticated) ? "/" : "/unlock") : "/welcome"} replace />} />
      </Routes>
    </div>
  );
}

export default App;
