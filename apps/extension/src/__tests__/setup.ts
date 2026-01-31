/**
 * P-01 Extension Test Setup
 *
 * Configures the testing environment for the Protocol 01 browser extension.
 * Mocks Chrome extension APIs, crypto globals, and other browser APIs
 * that are unavailable in the jsdom test environment.
 */

import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Global module mocks
// ---------------------------------------------------------------------------

// Mock framer-motion globally to avoid React version conflicts in the monorepo.
// Inline factory is required because Vitest auto-mock resolution does not find
// __mocks__ directories inside src/.
vi.mock('framer-motion', () => {
  const React = require('react');

  const motionHandler = {
    get(_target: unknown, prop: string) {
      return React.forwardRef(function MotionMock(
        { initial, animate, exit, transition, whileHover, whileTap, whileFocus, whileInView, variants, layout, layoutId, ...props }: any,
        ref: React.Ref<HTMLElement>,
      ) {
        return React.createElement(prop, { ...props, ref });
      });
    },
  };

  const motion = new Proxy({}, motionHandler);

  function AnimatePresence({ children }: { children: React.ReactNode }) {
    return React.createElement(React.Fragment, null, children);
  }

  function useAnimation() {
    return { start: () => Promise.resolve(), set: () => {}, stop: () => {} };
  }

  function useMotionValue(initial: number) {
    return { get: () => initial, set: () => {}, on: () => () => {} };
  }

  function useSpring(initial: number) {
    return useMotionValue(initial);
  }

  function useTransform() {
    return useMotionValue(0);
  }

  function useInView() {
    return true;
  }

  function useScroll() {
    return { scrollY: useMotionValue(0), scrollYProgress: useMotionValue(0) };
  }

  const LayoutGroup = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const LazyMotion = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const MotionConfig = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const Reorder = { Group: 'div', Item: 'div' };

  return {
    motion,
    AnimatePresence,
    useAnimation,
    useMotionValue,
    useSpring,
    useTransform,
    useInView,
    useScroll,
    LayoutGroup,
    LazyMotion,
    MotionConfig,
    Reorder,
  };
});

// Mock qrcode.react to avoid canvas dependency issues in jsdom
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, ...props }: { value: string }) => {
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'qr-code', 'data-value': value, ...props }, 'QR Code');
  },
}));

// ---------------------------------------------------------------------------
// Cleanup after each test
// ---------------------------------------------------------------------------
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Mock: Chrome Extension APIs
// ---------------------------------------------------------------------------

const mockChromeStorageArea = () => {
  const store: Record<string, unknown> = {};
  return {
    get: vi.fn((keys: string | string[]) => {
      if (typeof keys === 'string') {
        return Promise.resolve({ [keys]: store[keys] });
      }
      const result: Record<string, unknown> = {};
      (keys as string[]).forEach((k) => {
        result[k] = store[k];
      });
      return Promise.resolve(result);
    }),
    set: vi.fn((items: Record<string, unknown>) => {
      Object.assign(store, items);
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string | string[]) => {
      const keyList = typeof keys === 'string' ? [keys] : keys;
      keyList.forEach((k) => delete store[k]);
      return Promise.resolve();
    }),
    clear: vi.fn(() => {
      Object.keys(store).forEach((k) => delete store[k]);
      return Promise.resolve();
    }),
  };
};

const chromeMock = {
  runtime: {
    sendMessage: vi.fn(() => Promise.resolve()),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    getURL: vi.fn((path: string) => `chrome-extension://mock-id/${path}`),
    id: 'mock-extension-id',
  },
  storage: {
    local: mockChromeStorageArea(),
    session: mockChromeStorageArea(),
    sync: mockChromeStorageArea(),
  },
  action: {
    setBadgeText: vi.fn(() => Promise.resolve()),
    setBadgeBackgroundColor: vi.fn(() => Promise.resolve()),
  },
  tabs: {
    query: vi.fn(() => Promise.resolve([])),
    sendMessage: vi.fn(() => Promise.resolve()),
  },
};

// Attach to globalThis for extension code that references `chrome` directly
Object.defineProperty(globalThis, 'chrome', {
  value: chromeMock,
  writable: true,
});

// ---------------------------------------------------------------------------
// Mock: Navigator clipboard
// ---------------------------------------------------------------------------

Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: vi.fn(() => Promise.resolve()),
    readText: vi.fn(() => Promise.resolve('')),
  },
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Mock: window.matchMedia (required by framer-motion)
// ---------------------------------------------------------------------------

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ---------------------------------------------------------------------------
// Mock: window.close (used by approval popups)
// ---------------------------------------------------------------------------

window.close = vi.fn();

// ---------------------------------------------------------------------------
// Mock: crypto.randomUUID (used by generateId utility)
// ---------------------------------------------------------------------------

if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...globalThis.crypto,
      randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }),
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
    },
    writable: true,
  });
}

// ---------------------------------------------------------------------------
// Mock: import.meta.env (Vite environment variables)
// ---------------------------------------------------------------------------

if (!(import.meta as any).env) {
  (import.meta as any).env = {};
}
(import.meta as any).env.VITE_PRIVY_APP_ID = '';

// ---------------------------------------------------------------------------
// Mock: IntersectionObserver (used by lazy components)
// ---------------------------------------------------------------------------

class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  value: MockIntersectionObserver,
});

// ---------------------------------------------------------------------------
// Mock: ResizeObserver (used by some UI libraries)
// ---------------------------------------------------------------------------

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  value: MockResizeObserver,
});

// ---------------------------------------------------------------------------
// Suppress console noise during tests
// ---------------------------------------------------------------------------

const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  // Suppress React internal warnings and act() noise
  const message = typeof args[0] === 'string' ? args[0] : '';
  if (
    message.includes('act(') ||
    message.includes('not wrapped in act') ||
    message.includes('ReactDOMTestUtils.act')
  ) {
    return;
  }
  originalConsoleError(...args);
};
