/**
 * Messaging system for communication between:
 * - Popup <-> Background
 * - Content Script <-> Background
 * - Injected Script <-> Content Script (via window.postMessage)
 */

import type { ApprovalRequest } from './types';

// ============ Message Types ============

export interface InternalMessage {
  source: 'p01-popup' | 'p01-content' | 'p01-background';
  type: string;
  payload?: unknown;
  requestId?: string;
}

export interface InjectMessage {
  source: 'p01-inject';
  type: string;
  payload?: unknown;
  requestId: string;
}

// ============ Popup -> Background ============

export async function sendToBackground<T = unknown>(
  type: string,
  payload?: unknown
): Promise<T> {
  return new Promise((resolve, reject) => {
    const message: InternalMessage = {
      source: 'p01-popup',
      type,
      payload,
      requestId: crypto.randomUUID(),
    };

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response?.data as T);
    });
  });
}

// ============ Background Message Handler ============

type MessageHandler = (
  payload: unknown,
  sender: chrome.runtime.MessageSender
) => Promise<unknown> | unknown;

const handlers: Map<string, MessageHandler> = new Map();

export function registerHandler(type: string, handler: MessageHandler) {
  handlers.set(type, handler);
}

export function initBackgroundMessageListener() {
  chrome.runtime.onMessage.addListener((message: InternalMessage, sender, sendResponse) => {
    if (message.source !== 'p01-popup' && message.source !== 'p01-content') {
      return false;
    }

    const handler = handlers.get(message.type);
    if (!handler) {
      sendResponse({ error: `Unknown message type: ${message.type}` });
      return false;
    }

    // Handle async responses
    Promise.resolve(handler(message.payload, sender))
      .then((data) => sendResponse({ data }))
      .catch((err) => sendResponse({ error: err.message }));

    return true; // Indicates async response
  });
}

// ============ Content Script <-> Inject Script ============

export const P01_MESSAGE_CHANNEL = 'p01-extension-channel';

export function sendToContentScript(type: string, payload: unknown, requestId: string) {
  window.postMessage(
    {
      source: 'p01-inject',
      channel: P01_MESSAGE_CHANNEL,
      type,
      payload,
      requestId,
    },
    '*'
  );
}

export function listenFromInject(
  callback: (message: InjectMessage) => void
) {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'p01-inject') return;
    if (event.data?.channel !== P01_MESSAGE_CHANNEL) return;

    callback(event.data as InjectMessage);
  });
}

export function sendToInject(type: string, payload: unknown, requestId: string) {
  window.postMessage(
    {
      source: 'p01-content',
      channel: P01_MESSAGE_CHANNEL,
      type,
      payload,
      requestId,
    },
    '*'
  );
}

// ============ Approval Queue ============

export async function getApprovalQueue(): Promise<ApprovalRequest[]> {
  return sendToBackground<ApprovalRequest[]>('GET_APPROVAL_QUEUE');
}

export async function approveRequest(
  requestId: string,
  data?: { permissions?: string[]; [key: string]: unknown }
): Promise<void> {
  return sendToBackground('APPROVE_REQUEST', {
    requestId,
    data,
    permissions: data?.permissions,
  });
}

export async function rejectRequest(requestId: string, reason?: string): Promise<void> {
  return sendToBackground('REJECT_REQUEST', { requestId, reason });
}
