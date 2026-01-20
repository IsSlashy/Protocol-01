/**
 * Protocol 01 Wallet - Background Service Worker
 *
 * Handles:
 * - dApp connection/disconnection requests
 * - Transaction signing requests
 * - Message signing requests
 * - Subscription management & automatic payments (Stream Secure)
 * - Approval popup management
 * - Connected sites persistence
 */

import { initBackgroundMessageListener, registerHandler } from '@/shared/messaging';
import {
  getConnectedSites,
  addConnectedSite,
  removeConnectedSite,
  isSiteConnected,
  siteHasPermission,
} from '@/shared/store/connections';
import type { ApprovalRequest, ConnectedDapp, DappPermission } from '@/shared/types';

// ============ Types ============

interface StreamSubscription {
  id: string;
  name: string;
  recipient: string;
  tokenMint?: string;
  tokenSymbol: string;
  amount: number;
  interval: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
  nextPayment: number;
  isActive: boolean;
  createdAt: number;
  lastPayment?: number;
  totalPaid: number;
  paymentCount: number;
  maxPayments?: number;
  merchantName?: string;
  merchantLogo?: string;
  description?: string;
  // Privacy options
  amountNoise?: number;
  timingNoise?: number;
  useStealthAddress?: boolean;
}

interface PaymentRecord {
  subscriptionId: string;
  amount: number;
  timestamp: number;
  signature: string;
  success: boolean;
}

interface PendingApproval extends ApprovalRequest {
  tabId?: number;
  resolve?: (value: unknown) => void;
  reject?: (error: Error) => void;
}

// ============ State ============

interface BackgroundState {
  isUnlocked: boolean;
  pendingApprovals: Map<string, PendingApproval>;
  activeSubscriptions: StreamSubscription[];
  popupWindowId: number | null;
}

const state: BackgroundState = {
  isUnlocked: false,
  pendingApprovals: new Map(),
  activeSubscriptions: [],
  popupWindowId: null,
};

// ============ Subscription Scheduler ============

const SUBSCRIPTION_CHECK_ALARM = 'p01-subscription-check';
const SUBSCRIPTION_CHECK_INTERVAL_MINUTES = 15;

interface PendingSubscriptionPayment {
  subscriptionId: string;
  scheduledTime: number;
  attempts: number;
}

let pendingPayments: PendingSubscriptionPayment[] = [];

function isPaymentDue(sub: StreamSubscription): boolean {
  return sub.isActive && sub.nextPayment <= Date.now();
}

function calculateNextPayment(sub: StreamSubscription): { amount: number; timestamp: number } {
  return {
    amount: sub.amount,
    timestamp: sub.nextPayment,
  };
}

async function initSubscriptionScheduler() {
  await chrome.alarms.create(SUBSCRIPTION_CHECK_ALARM, {
    periodInMinutes: SUBSCRIPTION_CHECK_INTERVAL_MINUTES,
    delayInMinutes: 1,
  });
  console.log('[Stream Secure] Subscription scheduler initialized');
}

async function checkDueSubscriptions() {
  console.log('[Stream Secure] Checking for due subscriptions...');

  try {
    const result = await chrome.storage.local.get('p01-subscriptions');
    const storedData = result['p01-subscriptions']
      ? JSON.parse(result['p01-subscriptions'])
      : null;

    if (!storedData?.state?.subscriptions) {
      console.log('[Stream Secure] No subscriptions found');
      return;
    }

    const subscriptions: StreamSubscription[] = storedData.state.subscriptions;
    const dueSubscriptions = subscriptions.filter(isPaymentDue);

    if (dueSubscriptions.length === 0) {
      console.log('[Stream Secure] No payments due');
      return;
    }

    console.log(`[Stream Secure] ${dueSubscriptions.length} payment(s) due`);

    const walletResult = await chrome.storage.local.get('p01-wallet');
    const walletState = walletResult['p01-wallet']
      ? JSON.parse(walletResult['p01-wallet'])
      : null;

    if (!walletState?.state?.publicKey) {
      console.log('[Stream Secure] Wallet not initialized, skipping payments');
      return;
    }

    for (const sub of dueSubscriptions) {
      await notifyPendingPayment(sub);

      if (!pendingPayments.find((p) => p.subscriptionId === sub.id)) {
        pendingPayments.push({
          subscriptionId: sub.id,
          scheduledTime: sub.nextPayment,
          attempts: 0,
        });
      }
    }

    const isWalletUnlocked = await checkWalletUnlocked();
    if (isWalletUnlocked) {
      await processPendingPayments();
    }
  } catch (error) {
    console.error('[Stream Secure] Error checking subscriptions:', error);
  }
}

async function checkWalletUnlocked(): Promise<boolean> {
  try {
    const result = await chrome.storage.session.get('p01-wallet-unlocked');
    return result['p01-wallet-unlocked'] === true;
  } catch {
    return false;
  }
}

async function processPendingPayments() {
  if (pendingPayments.length === 0) {
    return;
  }

  console.log(`[Stream Secure] Processing ${pendingPayments.length} pending payment(s)`);

  try {
    await chrome.runtime.sendMessage({
      type: 'PROCESS_SUBSCRIPTION_PAYMENTS',
      subscriptionIds: pendingPayments.map((p) => p.subscriptionId),
    });
  } catch {
    console.log('[Stream Secure] Could not send message to popup');
  }
}

async function notifyPendingPayment(sub: StreamSubscription) {
  try {
    const permission = await chrome.permissions.contains({
      permissions: ['notifications'],
    });

    if (!permission) {
      console.log('[Stream Secure] Notification permission not granted');
      return;
    }

    const payment = calculateNextPayment(sub);

    await chrome.notifications.create(`p01-payment-${sub.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'Stream Secure Payment Due',
      message: `${sub.name}: ${payment.amount.toFixed(4)} ${sub.tokenSymbol} is ready to send`,
      priority: 2,
      requireInteraction: true,
    });
  } catch (error) {
    console.error('[Stream Secure] Failed to create notification:', error);
  }
}

chrome.notifications?.onButtonClicked?.addListener((notificationId, buttonIndex) => {
  if (!notificationId.startsWith('p01-payment-')) return;

  const subscriptionId = notificationId.replace('p01-payment-', '');

  if (buttonIndex === 0) {
    chrome.action.openPopup?.().catch(() => {
      chrome.windows.create({
        url: chrome.runtime.getURL('popup.html#/subscriptions/' + subscriptionId),
        type: 'popup',
        width: 375,
        height: 640,
        focused: true,
      });
    });
  } else if (buttonIndex === 1) {
    pendingPayments = pendingPayments.filter((p) => p.subscriptionId !== subscriptionId);
    chrome.notifications.clear(notificationId);
  }
});

chrome.notifications?.onClicked?.addListener((notificationId) => {
  if (!notificationId.startsWith('p01-payment-')) return;

  const subscriptionId = notificationId.replace('p01-payment-', '');

  chrome.windows.create({
    url: chrome.runtime.getURL('popup.html#/subscriptions/' + subscriptionId),
    type: 'popup',
    width: 375,
    height: 640,
    focused: true,
  });

  chrome.notifications.clear(notificationId);
});

// ============ Wallet State Helpers ============

async function getWalletPublicKey(): Promise<string | null> {
  try {
    const result = await chrome.storage.local.get('p01-wallet');
    const walletState = result['p01-wallet']
      ? JSON.parse(result['p01-wallet'])
      : null;
    return walletState?.state?.publicKey || null;
  } catch (error) {
    console.error('[Background] Failed to get wallet public key:', error);
    return null;
  }
}

// ============ Approval Queue Management ============

function generateApprovalId(): string {
  return crypto.randomUUID();
}

async function createApprovalRequest(
  request: Omit<ApprovalRequest, 'id' | 'createdAt'>,
  tabId?: number
): Promise<string> {
  const id = generateApprovalId();
  const approval: PendingApproval = {
    ...request,
    id,
    createdAt: Date.now(),
    tabId,
  };

  state.pendingApprovals.set(id, approval);
  await chrome.storage.session.set({ currentApproval: approval });
  console.log('[Background] Created approval request:', id, approval);

  return id;
}

async function openApprovalPopup(
  type: 'connect' | 'transaction' | 'signMessage' | 'subscription'
): Promise<void> {
  let path = '/connect';
  if (type === 'transaction' || type === 'signMessage') {
    path = '/approve';
  } else if (type === 'subscription') {
    path = '/approve-subscription';
  }

  // Store the pending approval info for the popup
  await chrome.storage.session.set({
    pendingApprovalPath: path,
    pendingApprovalTimestamp: Date.now()
  });

  // Open the extension's native popup only
  // User clicks on extension icon to see the approval request
  try {
    if (chrome.action?.openPopup) {
      await chrome.action.openPopup();
      console.log('[Background] Opened native extension popup');
    }
  } catch (e) {
    // openPopup() may fail in some contexts - that's OK
    // The user can click on the extension icon manually
    console.log('[Background] Could not auto-open popup, user should click extension icon:', e);

    // Show a badge to indicate pending approval
    try {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#39c5bb' });
    } catch {
      // Badge API might not be available
    }
  }
}

async function resolveApproval(
  requestId: string,
  approved: boolean,
  data?: unknown,
  reason?: string
): Promise<void> {
  const approval = state.pendingApprovals.get(requestId);
  if (!approval) {
    console.warn('[Background] Approval not found:', requestId);
    return;
  }

  state.pendingApprovals.delete(requestId);
  await chrome.storage.session.remove('currentApproval');

  if (approval.tabId) {
    try {
      await chrome.tabs.sendMessage(approval.tabId, {
        type: 'APPROVAL_RESULT',
        requestId,
        approved,
        data,
        reason,
      });
    } catch (error) {
      console.error('[Background] Failed to send approval result to tab:', error);
    }
  }

  if (approval.origin) {
    await notifyOrigin(approval.origin, {
      type: 'APPROVAL_RESULT',
      requestId,
      approved,
      data,
      reason,
    });
  }
}

// ============ Tab Communication ============

async function notifyOrigin(origin: string, message: unknown): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    for (const tab of tabs) {
      if (tab.id) {
        try {
          await chrome.tabs.sendMessage(tab.id, message);
        } catch {
          // Tab might not have content script or be closed
        }
      }
    }
  } catch (error) {
    console.error('[Background] Failed to notify origin:', error);
  }
}

// ============ Message Payload Type ============

type MessagePayload = {
  _origin?: string;
  _tabId?: number;
  origin?: string;
  title?: string;
  icon?: string;
  message?: string;
  displayText?: string;
  transaction?: string;
  transactions?: string[];
  options?: Record<string, unknown>;
  recipient?: string;
  amount?: number;
  tokenMint?: string;
  merchantName?: string;
  merchantLogo?: string;
  amountPerPeriod?: number;
  periodSeconds?: number;
  maxPeriods?: number;
  description?: string;
  subscriptionId?: string;
  requestId?: string;
  data?: unknown;
  reason?: string;
  permissions?: DappPermission[];
  isPrivate?: boolean;
  amountNoise?: number;
  timingNoise?: number;
  useStealthAddress?: boolean;
};

// ============ Content Script Message Handlers ============

async function handleConnect(
  payload: MessagePayload,
  sender: chrome.runtime.MessageSender
): Promise<{ publicKey: string } | { connected: boolean } | { error: string }> {
  const origin = payload._origin || payload.origin || '';
  const tabId = sender.tab?.id;

  // Check if wallet is initialized
  const walletResult = await chrome.storage.local.get('p01-wallet');
  const walletState = walletResult['p01-wallet']
    ? JSON.parse(walletResult['p01-wallet'])
    : null;

  const isWalletInitialized = !!walletState?.state?.encryptedSeedPhrase;

  if (!isWalletInitialized) {
    // Wallet not created - user needs to create one first
    await openApprovalPopup('connect'); // This will show welcome/create wallet flow
    return { error: 'Wallet not initialized. Please create a wallet first.' };
  }

  // Check if already connected
  const isConnected = await isSiteConnected(origin);
  if (isConnected) {
    const publicKey = await getWalletPublicKey();
    if (publicKey) {
      return { publicKey };
    }
    // Wallet is locked - need to unlock
    // Store the pending connection request and open popup
  }

  // Create approval request
  const requestId = await createApprovalRequest(
    {
      type: 'connect',
      origin,
      originName: payload.title || (origin ? new URL(origin).hostname : 'Unknown'),
      originIcon: payload.icon,
      payload: {},
    },
    tabId
  );

  // Open approval popup - this will show unlock page if needed, then redirect to connect
  await openApprovalPopup('connect');

  // Wait for approval
  return new Promise((resolve) => {
    const approval = state.pendingApprovals.get(requestId);
    if (approval) {
      approval.resolve = async () => {
        const publicKey = await getWalletPublicKey();
        if (publicKey) {
          resolve({ publicKey });
        } else {
          resolve({ error: 'Wallet not initialized' });
        }
      };
      approval.reject = (error: Error) => {
        resolve({ error: error.message });
      };
    }

    // Timeout after 5 minutes
    setTimeout(() => {
      if (state.pendingApprovals.has(requestId)) {
        state.pendingApprovals.delete(requestId);
        resolve({ error: 'Connection request timeout' });
      }
    }, 300000);
  });
}

async function handleConnectSilent(
  payload: MessagePayload,
  _sender: chrome.runtime.MessageSender
): Promise<{ connected: boolean; publicKey?: string }> {
  const origin = payload._origin || '';

  const isConnected = await isSiteConnected(origin);
  if (!isConnected) {
    return { connected: false };
  }

  const publicKey = await getWalletPublicKey();
  if (!publicKey) {
    return { connected: false };
  }

  return { connected: true, publicKey };
}

async function handleDisconnect(
  payload: MessagePayload,
  _sender: chrome.runtime.MessageSender
): Promise<{ success: boolean }> {
  const origin = payload._origin || payload.origin || '';

  await removeConnectedSite(origin);
  await notifyOrigin(origin, { type: 'DISCONNECT_NOTIFICATION' });

  return { success: true };
}

async function handleIsConnected(
  payload: MessagePayload,
  _sender: chrome.runtime.MessageSender
): Promise<{ connected: boolean }> {
  const origin = payload._origin || '';
  const isConnected = await isSiteConnected(origin);
  return { connected: isConnected };
}

async function handleGetAccounts(
  payload: MessagePayload,
  _sender: chrome.runtime.MessageSender
): Promise<{ accounts: string[] } | { error: string }> {
  const origin = payload._origin || '';

  const isConnected = await isSiteConnected(origin);
  if (!isConnected) {
    return { accounts: [] };
  }

  const publicKey = await getWalletPublicKey();
  if (!publicKey) {
    return { accounts: [] };
  }

  return { accounts: [publicKey] };
}

async function handleSignMessage(
  payload: MessagePayload,
  sender: chrome.runtime.MessageSender
): Promise<{ signature: string } | { pending: true; requestId: string } | { error: string }> {
  const origin = payload._origin || '';
  const tabId = sender.tab?.id;

  const hasPermission = await siteHasPermission(origin, 'requestTransaction');
  if (!hasPermission) {
    return { error: 'Not connected or missing permission' };
  }

  const requestId = await createApprovalRequest(
    {
      type: 'signMessage',
      origin,
      payload: {
        message: payload.message,
        displayText: payload.displayText,
      },
    },
    tabId
  );

  await openApprovalPopup('signMessage');

  return { pending: true, requestId };
}

async function handleSignTransaction(
  payload: MessagePayload,
  sender: chrome.runtime.MessageSender
): Promise<{ signedTransaction: string } | { pending: true; requestId: string } | { error: string }> {
  const origin = payload._origin || '';
  const tabId = sender.tab?.id;

  const hasPermission = await siteHasPermission(origin, 'requestTransaction');
  if (!hasPermission) {
    return { error: 'Not connected or missing permission' };
  }

  const requestId = await createApprovalRequest(
    {
      type: 'transaction',
      origin,
      payload: {
        transaction: payload.transaction,
        isPrivate: payload.isPrivate,
      },
    },
    tabId
  );

  await openApprovalPopup('transaction');

  return { pending: true, requestId };
}

async function handleSignAllTransactions(
  payload: MessagePayload,
  sender: chrome.runtime.MessageSender
): Promise<{ signedTransactions: string[] } | { pending: true; requestId: string } | { error: string }> {
  const origin = payload._origin || '';
  const tabId = sender.tab?.id;

  const hasPermission = await siteHasPermission(origin, 'requestTransaction');
  if (!hasPermission) {
    return { error: 'Not connected or missing permission' };
  }

  const requestId = await createApprovalRequest(
    {
      type: 'transaction',
      origin,
      payload: {
        transactions: payload.transactions,
        isMultiple: true,
      },
    },
    tabId
  );

  await openApprovalPopup('transaction');

  return { pending: true, requestId };
}

async function handleSignAndSendTransaction(
  payload: MessagePayload,
  sender: chrome.runtime.MessageSender
): Promise<{ signature: string } | { pending: true; requestId: string } | { error: string }> {
  const origin = payload._origin || '';
  const tabId = sender.tab?.id;

  const hasPermission = await siteHasPermission(origin, 'requestTransaction');
  if (!hasPermission) {
    return { error: 'Not connected or missing permission' };
  }

  const requestId = await createApprovalRequest(
    {
      type: 'transaction',
      origin,
      payload: {
        transaction: payload.transaction,
        options: payload.options,
        sendAfterSign: true,
      },
    },
    tabId
  );

  await openApprovalPopup('transaction');

  return { pending: true, requestId };
}

async function handleCreateSubscription(
  payload: MessagePayload,
  sender: chrome.runtime.MessageSender
): Promise<{ subscriptionId: string; address: string } | { pending: true; requestId: string } | { error: string }> {
  const origin = payload._origin || '';
  const tabId = sender.tab?.id;

  const hasPermission = await siteHasPermission(origin, 'requestSubscription');
  if (!hasPermission) {
    return { error: 'Not connected or missing subscription permission' };
  }

  const requestId = await createApprovalRequest(
    {
      type: 'subscription',
      origin,
      payload: {
        recipient: payload.recipient,
        merchantName: payload.merchantName,
        merchantLogo: payload.merchantLogo,
        tokenMint: payload.tokenMint,
        amountPerPeriod: payload.amountPerPeriod,
        periodSeconds: payload.periodSeconds,
        maxPeriods: payload.maxPeriods,
        description: payload.description,
        amountNoise: payload.amountNoise,
        timingNoise: payload.timingNoise,
        useStealthAddress: payload.useStealthAddress,
      },
    },
    tabId
  );

  await openApprovalPopup('subscription');

  return { pending: true, requestId };
}

async function handleGetSubscriptions(
  _payload: MessagePayload,
  _sender: chrome.runtime.MessageSender
): Promise<{ subscriptions: StreamSubscription[] }> {
  const result = await chrome.storage.local.get('p01-subscriptions');
  const storedData = result['p01-subscriptions']
    ? JSON.parse(result['p01-subscriptions'])
    : null;
  return { subscriptions: storedData?.state?.subscriptions || [] };
}

async function handleCancelSubscription(
  payload: MessagePayload,
  _sender: chrome.runtime.MessageSender
): Promise<{ success: boolean } | { error: string }> {
  const subscriptionId = payload.subscriptionId;
  if (!subscriptionId) {
    return { error: 'Subscription ID required' };
  }

  // Update subscription state
  const result = await chrome.storage.local.get('p01-subscriptions');
  const storedData = result['p01-subscriptions']
    ? JSON.parse(result['p01-subscriptions'])
    : null;

  if (storedData?.state?.subscriptions) {
    storedData.state.subscriptions = storedData.state.subscriptions.map(
      (sub: StreamSubscription) =>
        sub.id === subscriptionId ? { ...sub, isActive: false } : sub
    );
    await chrome.storage.local.set({
      'p01-subscriptions': JSON.stringify(storedData),
    });
  }

  return { success: true };
}

// ============ Popup Message Handlers ============

async function handleApproveRequest(
  payload: MessagePayload
): Promise<{ success: boolean } | { error: string }> {
  const { requestId, data, permissions } = payload;

  if (!requestId) {
    return { error: 'Request ID required' };
  }

  const approval = state.pendingApprovals.get(requestId);
  if (!approval) {
    return { error: 'Request not found' };
  }

  // Handle connection approval
  if (approval.type === 'connect') {
    const dapp: ConnectedDapp = {
      origin: approval.origin,
      name: approval.originName || (approval.origin ? new URL(approval.origin).hostname : 'Unknown'),
      icon: approval.originIcon,
      connectedAt: Date.now(),
      permissions: permissions || ['viewBalance', 'requestTransaction', 'requestSubscription'],
    };

    await addConnectedSite(dapp);
  }

  // Resolve the pending promise
  if (approval.resolve) {
    approval.resolve(data);
  }

  // Notify content script
  await resolveApproval(requestId, true, data);

  return { success: true };
}

async function handleRejectRequest(
  payload: MessagePayload
): Promise<{ success: boolean } | { error: string }> {
  const { requestId, reason } = payload;

  if (!requestId) {
    return { error: 'Request ID required' };
  }

  const approval = state.pendingApprovals.get(requestId);
  if (!approval) {
    return { error: 'Request not found' };
  }

  // Reject the pending promise
  if (approval.reject) {
    approval.reject(new Error(reason || 'User rejected'));
  }

  // Notify content script
  await resolveApproval(requestId, false, undefined, reason || 'User rejected');

  return { success: true };
}

async function handleGetConnectedDapps(): Promise<ConnectedDapp[]> {
  const sites = await getConnectedSites();
  return Object.values(sites);
}

async function handleDisconnectDapp(
  payload: MessagePayload
): Promise<{ success: boolean }> {
  const origin = payload.origin || '';
  await removeConnectedSite(origin);
  await notifyOrigin(origin, { type: 'DISCONNECT_NOTIFICATION' });
  return { success: true };
}

async function handleGetApprovalQueue(): Promise<ApprovalRequest[]> {
  return Array.from(state.pendingApprovals.values()).map(
    ({ resolve, reject, tabId, ...rest }) => rest
  );
}

// ============ Register Popup Handlers ============

registerHandler('GET_ACCOUNTS', async () => {
  const publicKey = await getWalletPublicKey();
  if (!publicKey) {
    throw new Error('Wallet not initialized');
  }
  return { publicKey };
});

registerHandler('GET_APPROVAL_QUEUE', async () => {
  return await handleGetApprovalQueue();
});

registerHandler('APPROVE_REQUEST', async (payload) => {
  return await handleApproveRequest(payload as MessagePayload);
});

registerHandler('REJECT_REQUEST', async (payload) => {
  return await handleRejectRequest(payload as MessagePayload);
});

registerHandler('GET_CONNECTED_DAPPS', async () => {
  return await handleGetConnectedDapps();
});

registerHandler('DISCONNECT_DAPP', async (payload) => {
  return await handleDisconnectDapp(payload as MessagePayload);
});

registerHandler('GET_SUBSCRIPTIONS', async () => {
  const result = await chrome.storage.local.get('p01-subscriptions');
  const storedData = result['p01-subscriptions']
    ? JSON.parse(result['p01-subscriptions'])
    : null;
  return storedData?.state?.subscriptions || [];
});

registerHandler('GET_PENDING_PAYMENTS', async () => {
  return pendingPayments;
});

registerHandler('PAYMENT_PROCESSED', async (payload) => {
  const { subscriptionId, success, payment } = payload as {
    subscriptionId: string;
    success: boolean;
    payment?: PaymentRecord;
  };

  pendingPayments = pendingPayments.filter((p) => p.subscriptionId !== subscriptionId);
  chrome.notifications?.clear(`p01-payment-${subscriptionId}`);

  if (success && payment) {
    try {
      await chrome.notifications.create(`p01-payment-success-${subscriptionId}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
        title: 'Payment Sent',
        message: `Successfully paid ${payment.amount.toFixed(4)} SOL`,
        priority: 1,
      });

      setTimeout(() => {
        chrome.notifications?.clear(`p01-payment-success-${subscriptionId}`);
      }, 5000);
    } catch {
      // Notifications might not be available
    }
  }

  return { success: true };
});

registerHandler('WALLET_UNLOCKED', async () => {
  await chrome.storage.session.set({ 'p01-wallet-unlocked': true });
  await processPendingPayments();
  return { success: true };
});

registerHandler('WALLET_LOCKED', async () => {
  await chrome.storage.session.remove('p01-wallet-unlocked');
  return { success: true };
});

// ============ Register Content Script Handlers ============
// These handlers are called when content script sends messages

registerHandler('CONNECT', async (payload, sender) => {
  return await handleConnect(payload as MessagePayload, sender);
});

registerHandler('CONNECT_SILENT', async (payload, sender) => {
  return await handleConnectSilent(payload as MessagePayload, sender);
});

registerHandler('DISCONNECT', async (payload, sender) => {
  return await handleDisconnect(payload as MessagePayload, sender);
});

registerHandler('IS_CONNECTED', async (payload, sender) => {
  return await handleIsConnected(payload as MessagePayload, sender);
});

registerHandler('SIGN_MESSAGE', async (payload, sender) => {
  return await handleSignMessage(payload as MessagePayload, sender);
});

registerHandler('SIGN_TRANSACTION', async (payload, sender) => {
  return await handleSignTransaction(payload as MessagePayload, sender);
});

registerHandler('SIGN_ALL_TRANSACTIONS', async (payload, sender) => {
  return await handleSignAllTransactions(payload as MessagePayload, sender);
});

registerHandler('SIGN_AND_SEND_TRANSACTION', async (payload, sender) => {
  return await handleSignAndSendTransaction(payload as MessagePayload, sender);
});

registerHandler('CREATE_SUBSCRIPTION', async (payload, sender) => {
  return await handleCreateSubscription(payload as MessagePayload, sender);
});

registerHandler('CANCEL_SUBSCRIPTION', async (payload, sender) => {
  return await handleCancelSubscription(payload as MessagePayload, sender);
});

// ============ Content Script Message Router (Legacy) ============

chrome.runtime.onMessage.addListener(
  (
    message: {
      source?: string;
      type: string;
      payload?: MessagePayload;
      requestId?: string;
    },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    // Handle messages from content script
    if (message.source === 'p01-content') {
      const handler = async () => {
        try {
          const payload = message.payload || {};

          switch (message.type) {
            case 'CONNECT':
              return await handleConnect(payload, sender);
            case 'CONNECT_SILENT':
              return await handleConnectSilent(payload, sender);
            case 'DISCONNECT':
              return await handleDisconnect(payload, sender);
            case 'IS_CONNECTED':
              return await handleIsConnected(payload, sender);
            case 'GET_ACCOUNTS':
              return await handleGetAccounts(payload, sender);
            case 'SIGN_MESSAGE':
              return await handleSignMessage(payload, sender);
            case 'SIGN_TRANSACTION':
              return await handleSignTransaction(payload, sender);
            case 'SIGN_ALL_TRANSACTIONS':
              return await handleSignAllTransactions(payload, sender);
            case 'SIGN_AND_SEND_TRANSACTION':
              return await handleSignAndSendTransaction(payload, sender);
            case 'CREATE_SUBSCRIPTION':
              return await handleCreateSubscription(payload, sender);
            case 'GET_SUBSCRIPTIONS':
              return await handleGetSubscriptions(payload, sender);
            case 'CANCEL_SUBSCRIPTION':
              return await handleCancelSubscription(payload, sender);
            default:
              return { error: `Unknown message type: ${message.type}` };
          }
        } catch (error) {
          console.error(`[Background] Error handling ${message.type}:`, error);
          return { error: error instanceof Error ? error.message : 'Unknown error' };
        }
      };

      handler().then(sendResponse);
      return true; // Async response
    }

    return false;
  }
);

// ============ Alarm Handler ============

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    console.log('[Protocol 01] Keepalive ping');
  } else if (alarm.name === SUBSCRIPTION_CHECK_ALARM) {
    checkDueSubscriptions();
  }
});

// ============ Initialization ============

initBackgroundMessageListener();
initSubscriptionScheduler();

console.log('[Protocol 01] Background service worker initialized');
console.log('[Stream Secure] Privacy-enhanced recurring payments enabled');

// Keep service worker alive
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });

// Initial subscription check on startup
setTimeout(() => {
  checkDueSubscriptions();
}, 5000);

// Handle extension install/update
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[Protocol 01] Extension installed');
  } else if (details.reason === 'update') {
    console.log(
      '[Protocol 01] Extension updated to version',
      chrome.runtime.getManifest().version
    );
  }
});
