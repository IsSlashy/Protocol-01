import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// ---------- Report size: cap the DOM dump on a failed query ----------
//
// Testing Library prints the whole rendered container when getByText and
// friends fail, up to 7000 characters per failure by default. With the Styx
// pages in the suite, three failing queries alone pushed a full red run to
// 42356 bytes of stdout on 2026-08-11. That is over the truncation cap of a
// normal capture buffer, and when the caller stops draining the pipe the main
// vitest process blocks forever on the write: the run prints "RUN v3.2.4",
// then nothing, and looks like a collection hang while the workers have in
// fact already finished. See the long note in vitest.config.ts for the
// measurement.
//
// prettyDOM reads this env var at print time, per worker process, so setting
// it here is enough. 2000 characters still shows the container and the first
// levels of markup, which is what you actually read when a query misses.
// Raise it temporarily if you need the full tree, do not raise it in a commit.
process.env.DEBUG_PRINT_LIMIT ??= '2000';

// ---------- Mock: @/i18n ----------
// Components call `useT()`, which reads the translation function off
// I18nContext. Tests render components without <I18nProvider>, so the context
// default returns the key itself and every assertion on visible copy fails
// against strings like "sdkDemo.heroSubtitle". Resolving against the real
// English catalogue keeps the tests asserting what a user actually sees, and
// means a renamed or deleted key fails the suite instead of passing silently.
vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const en = (await import('@/i18n/en')).default as Record<string, unknown>;

  const lookup = (path: string): string => {
    let current: unknown = en;
    for (const part of path.split('.')) {
      if (current == null || typeof current !== 'object') return path;
      current = (current as Record<string, unknown>)[part];
    }
    return typeof current === 'string' ? current : path;
  };

  return {
    ...actual,
    useT: () => lookup,
    useLocale: () => ({ locale: 'en', setLocale: vi.fn(), t: lookup }),
  };
});

// ---------- Mock: next/image ----------
vi.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const { fill, priority, ...rest } = props;
    return <img {...rest} data-fill={fill ? 'true' : undefined} data-priority={priority ? 'true' : undefined} />;
  },
}));

// ---------- Mock: next/link ----------
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// ---------- Mock: next/navigation ----------
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

// ---------- Mock: next/font/google ----------
//
// Every font the module can export, without naming any of them.
//
// A hand-listed mock (Space_Grotesk, JetBrains_Mono, Inter) broke the entire
// suite at COLLECTION time on 2026-08-11, the moment the Styx design system
// adopted Newsreader: `app/_styx/fonts.ts` imports it, every ported page imports
// StyxShell, and vitest died with `No "Newsreader" export is defined on the
// "next/font/google" mock` before running a single assertion. A list of names is
// a trap that springs on whoever next changes a typeface, so this returns a
// factory for any requested export instead.
//
// It honours the `variable` option the way the real API does, so a page reading
// `myFont.variable` still gets the CSS custom property it asked for.
vi.mock('next/font/google', () => {
  const kebab = (name: string) =>
    name.replace(/_/g, '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

  const makeFont =
    (name: string) =>
    (opts: { variable?: string } = {}) => ({
      variable: opts.variable ?? `--font-${kebab(name)}`,
      className: `mock-font-${kebab(name)}`,
      style: { fontFamily: name.replace(/_/g, ' ') },
    });

  // `then` MUST stay undefined. Vitest awaits the factory result
  // (`const exports = await mock.resolve()`), so if the namespace answers 'then'
  // with a function, the await treats the whole module as a thenable and calls
  // that function with (resolve, reject). A font factory ignores both and
  // returns an object, so resolve() is never called and the import never
  // settles: measured as an 8s+ hang on `await import('next/font/google')`,
  // which killed the suite at COLLECTION time for every page that reaches
  // app/_styx/fonts.ts. Reproduces outside vitest too:
  // `await new Proxy({}, { get: () => () => ({}) })` never settles.
  const NOT_A_FONT = new Set(['then', 'catch', 'finally']);

  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === '__esModule') return true;
        if (typeof prop !== 'string') return undefined;
        if (NOT_A_FONT.has(prop)) return undefined;
        return makeFont(prop);
      },
      // Same reason: an `in` check for 'then' must not claim the trap exists.
      has: (_target, prop) => !(typeof prop === 'string' && NOT_A_FONT.has(prop)),
    },
  );
});

// ---------- Mock: framer-motion ----------
vi.mock('framer-motion', () => {
  const React = require('react');

  const createMotionComponent = (tag: string) => {
    return React.forwardRef((props: Record<string, unknown>, ref: unknown) => {
      const {
        initial, animate, exit, transition, variants,
        whileInView, viewport, whileHover, whileTap,
        ...domProps
      } = props;
      return React.createElement(tag, { ...domProps, ref });
    });
  };

  const motion = new Proxy(
    {},
    {
      get: (_target: unknown, prop: string) => createMotionComponent(prop),
    }
  );

  return {
    __esModule: true,
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useInView: () => true,
    useAnimation: () => ({ start: vi.fn(), stop: vi.fn() }),
    useMotionValue: (val: number) => ({ get: () => val, set: vi.fn() }),
    useTransform: () => ({ get: () => 0, set: vi.fn() }),
  };
});

// ---------- Mock: @solana/wallet-adapter-react ----------
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    publicKey: null,
    connected: false,
    connecting: false,
    disconnect: vi.fn(),
    connect: vi.fn(),
    select: vi.fn(),
    wallet: null,
    wallets: [],
    signMessage: vi.fn(),
    signTransaction: vi.fn(),
    sendTransaction: vi.fn(),
  }),
  useConnection: () => ({
    connection: {
      getBalance: vi.fn().mockResolvedValue(0),
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: 'mock', lastValidBlockHeight: 0 }),
      rpcEndpoint: 'https://api.devnet.solana.com',
    },
  }),
  ConnectionProvider: ({ children }: { children: React.ReactNode }) => children,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ---------- Mock: @solana/wallet-adapter-react-ui ----------
vi.mock('@solana/wallet-adapter-react-ui', () => ({
  WalletModalProvider: ({ children }: { children: React.ReactNode }) => children,
  WalletMultiButton: () => <button data-testid="wallet-button">Select Wallet</button>,
  WalletConnectButton: () => <button>Connect Wallet</button>,
}));

// ---------- Mock: @solana/wallet-adapter-wallets ----------
vi.mock('@solana/wallet-adapter-wallets', () => ({
  PhantomWalletAdapter: vi.fn().mockImplementation(() => ({ name: 'Phantom' })),
  SolflareWalletAdapter: vi.fn().mockImplementation(() => ({ name: 'Solflare' })),
  CoinbaseWalletAdapter: vi.fn().mockImplementation(() => ({ name: 'Coinbase' })),
  LedgerWalletAdapter: vi.fn().mockImplementation(() => ({ name: 'Ledger' })),
  TorusWalletAdapter: vi.fn().mockImplementation(() => ({ name: 'Torus' })),
}));

// ---------- Mock: @solana/web3.js ----------
// ⚠️ `Keypair` is the REAL implementation, deliberately.
//
// The rest of this stub stands in for things that would open sockets or need a
// wallet. `Keypair` needs neither: it is ed25519 arithmetic, and code that
// stores or reloads a secret key has to be tested against the real one — a
// stub would accept a 3-byte "secret" and every round-trip assertion would
// pass while the shipped path threw. That is exactly the class of bug this
// project keeps finding, so the mock defers here instead.
vi.mock('@solana/web3.js', async (importOriginal) => ({
  ...{ Keypair: (await importOriginal<typeof import('@solana/web3.js')>()).Keypair },
  clusterApiUrl: (network: string) => `https://api.${network}.solana.com`,
  Connection: vi.fn(),
  PublicKey: vi.fn().mockImplementation((key: string) => ({
    toBase58: () => key,
    toString: () => key,
  })),
  LAMPORTS_PER_SOL: 1_000_000_000,
  SystemProgram: { transfer: vi.fn() },
  Transaction: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
    sign: vi.fn(),
  })),
}));

// ---------- Mock: @solana/wallet-adapter-react-ui/styles.css ----------
vi.mock('@solana/wallet-adapter-react-ui/styles.css', () => ({}));

// ---------- Mock: react-qr-code ----------
vi.mock('react-qr-code', () => ({
  __esModule: true,
  default: (props: { value: string; size?: number }) => (
    <div data-testid="qr-code" data-value={props.value}>[QR: {props.value?.substring(0, 30)}...]</div>
  ),
}));

// ---------- Mock: @vercel/kv ----------
vi.mock('@vercel/kv', () => ({
  kv: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  },
}));

// ---------- Mock: resend ----------
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      send: vi.fn().mockResolvedValue({ id: 'mock-email-id' }),
    },
  })),
}));

// ---------- Global: window.matchMedia ----------
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

// ---------- Global: IntersectionObserver ----------
class MockIntersectionObserver {
  readonly root: Element | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn().mockReturnValue([]);
}

Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  value: MockIntersectionObserver,
});

// ---------- Global: ResizeObserver ----------
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  value: MockResizeObserver,
});

// ---------- Global: scrollIntoView ----------
Element.prototype.scrollIntoView = vi.fn();

// ---------- Global: crypto.getRandomValues ----------
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
      },
      randomUUID: () => '00000000-0000-4000-8000-000000000000',
    },
  });
}
