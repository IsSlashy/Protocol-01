import '@testing-library/jest-dom/vitest';

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
vi.mock('next/font/google', () => ({
  Space_Grotesk: () => ({ variable: '--font-space-grotesk', style: {} }),
  JetBrains_Mono: () => ({ variable: '--font-jetbrains-mono', style: {} }),
  Inter: () => ({ variable: '--font-inter', style: {} }),
}));

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
vi.mock('@solana/web3.js', () => ({
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
