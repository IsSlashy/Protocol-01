/**
 * Protocol 01 Wallet - Content Script
 *
 * Acts as a secure bridge between:
 * - Injected script (window.solana/window.protocol01) <-> Background service worker
 *
 * Communication:
 * - window.postMessage (with inject script)
 * - chrome.runtime.sendMessage (with background)
 *
 * Security:
 * - Validates message sources
 * - Sanitizes data before forwarding
 * - Prevents cross-origin attacks
 */

// ============ Constants ============

const CHANNEL = 'p01-extension-channel';
const ALLOWED_MESSAGE_TYPES = [
  // Connection
  'CONNECT',
  'CONNECT_SILENT',
  'DISCONNECT',
  'IS_CONNECTED',
  // Accounts
  'GET_ACCOUNTS',
  // Signing
  'SIGN_MESSAGE',
  'SIGN_TRANSACTION',
  'SIGN_ALL_TRANSACTIONS',
  'SIGN_AND_SEND_TRANSACTION',
  // Protocol 01 specific
  'SEND_PRIVATE',
  'GENERATE_STEALTH_ADDRESS',
  'CREATE_SUBSCRIPTION',
  'GET_SUBSCRIPTIONS',
  'CANCEL_SUBSCRIPTION',
];

// ============ Script Injection ============

/**
 * Inject the provider script into the page context
 */
function injectProviderScript(): void {
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    // Not a module - compiled as IIFE
    script.id = 'protocol01-provider';

    // Inject as early as possible
    const container = document.head || document.documentElement;
    container.insertBefore(script, container.firstChild);

    // Clean up after injection
    script.onload = () => {
      script.remove();
    };

    script.onerror = (error) => {
      console.error('[Protocol 01] Failed to inject provider script:', error);
      script.remove();
    };
  } catch (error) {
    console.error('[Protocol 01] Error injecting provider script:', error);
  }
}

// ============ Message Handling ============

/**
 * Send response back to injected script
 */
function sendToInject(
  type: string,
  payload: unknown,
  requestId: string,
  error?: string
): void {
  window.postMessage(
    {
      source: 'p01-content',
      channel: CHANNEL,
      type,
      payload,
      requestId,
      error,
    },
    '*'
  );
}

/**
 * Forward message to background and send response to inject
 */
async function forwardToBackground(
  type: string,
  payload: unknown,
  requestId: string,
  origin: string
): Promise<void> {
  try {
    // Add origin to payload for security validation in background
    const enrichedPayload = {
      ...(typeof payload === 'object' && payload !== null ? payload : {}),
      _origin: origin,
      _tabId: undefined, // Will be filled by background
    };

    const response = await chrome.runtime.sendMessage({
      source: 'p01-content',
      type,
      payload: enrichedPayload,
      requestId,
    });

    // Send response back to inject script
    // Handle both wrapped ({ data: ... }) and unwrapped responses
    if (response?.error) {
      sendToInject(type + '_RESPONSE', null, requestId, response.error);
    } else if (response?.data !== undefined) {
      // Response is wrapped in { data: ... } format from registerHandler
      if (response.data?.error) {
        sendToInject(type + '_RESPONSE', null, requestId, response.data.error);
      } else {
        sendToInject(type + '_RESPONSE', response.data, requestId);
      }
    } else {
      // Response is direct (not wrapped)
      sendToInject(type + '_RESPONSE', response, requestId);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Protocol 01] Error forwarding ${type}:`, errorMessage);
    sendToInject(type + '_RESPONSE', null, requestId, errorMessage);
  }
}

/**
 * Handle messages from injected script
 */
function handleInjectMessage(event: MessageEvent): void {
  // Security: Only accept messages from same window
  if (event.source !== window) return;

  // Validate message structure
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.source !== 'p01-inject') return;
  if (data.channel !== CHANNEL) return;

  const { type, payload, requestId } = data;

  // Validate message type
  if (!type || typeof type !== 'string') return;
  if (!requestId || typeof requestId !== 'string') return;

  // Security: Only allow known message types
  if (!ALLOWED_MESSAGE_TYPES.includes(type)) {
    console.warn(`[Protocol 01] Unknown message type: ${type}`);
    sendToInject(type + '_RESPONSE', null, requestId, `Unknown message type: ${type}`);
    return;
  }

  // Get current origin for security validation
  const origin = window.location.origin;

  // Forward to background
  forwardToBackground(type, payload, requestId, origin);
}

/**
 * Handle messages from background script
 */
function handleBackgroundMessage(
  message: {
    type: string;
    payload?: unknown;
    requestId?: string;
    approved?: boolean;
    reason?: string;
    data?: unknown;
  },
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): boolean {
  // Handle approval results
  if (message.type === 'APPROVAL_RESULT') {
    window.postMessage(
      {
        source: 'p01-content',
        channel: CHANNEL,
        type: 'APPROVAL_RESULT',
        payload: {
          approved: message.approved,
          reason: message.reason,
          data: message.data,
        },
        requestId: message.requestId,
      },
      '*'
    );
    sendResponse({ received: true });
    return false;
  }

  // Handle account change notifications
  if (message.type === 'ACCOUNT_CHANGED') {
    window.postMessage(
      {
        source: 'p01-content',
        channel: CHANNEL,
        type: 'ACCOUNT_CHANGED',
        payload: message.payload,
        requestId: '',
      },
      '*'
    );
    sendResponse({ received: true });
    return false;
  }

  // Handle disconnect notifications
  if (message.type === 'DISCONNECT_NOTIFICATION') {
    window.postMessage(
      {
        source: 'p01-content',
        channel: CHANNEL,
        type: 'DISCONNECT',
        payload: {},
        requestId: '',
      },
      '*'
    );
    sendResponse({ received: true });
    return false;
  }

  sendResponse({ received: true });
  return false;
}

// ============ Initialization ============

/**
 * Initialize the content script
 */
function initialize(): void {
  // Only run on http/https pages
  const protocol = window.location.protocol;
  if (protocol !== 'https:' && protocol !== 'http:') {
    return;
  }

  // Inject provider script
  injectProviderScript();

  // Listen for messages from injected script
  window.addEventListener('message', handleInjectMessage);

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);

  // Notify inject script that content script is ready
  window.postMessage(
    {
      source: 'p01-content',
      channel: CHANNEL,
      type: 'CONTENT_SCRIPT_READY',
      payload: { version: '0.1.0' },
      requestId: '',
    },
    '*'
  );

}

// Run initialization
initialize();
