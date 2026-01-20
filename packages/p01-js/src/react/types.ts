/**
 * Protocol 01 React Component Types
 */

import type {
  MerchantConfig,
  PaymentInterval,
  PrivacyOptions,
  Subscription,
  MerchantCategory,
} from '../types';

// ============ Provider Types ============

export interface P01ProviderProps {
  /** Merchant configuration */
  config: MerchantConfig;
  /** Children components */
  children: React.ReactNode;
  /** Custom styles */
  theme?: Partial<WidgetTheme>;
}

export interface P01ContextValue {
  /** Is SDK initialized */
  isReady: boolean;
  /** Is wallet connected */
  isConnected: boolean;
  /** Connected wallet public key */
  publicKey: string | null;
  /** Is Protocol 01 wallet */
  isP01Wallet: boolean;
  /** Connect wallet */
  connect: () => Promise<void>;
  /** Disconnect wallet */
  disconnect: () => Promise<void>;
  /** Active subscriptions */
  subscriptions: Subscription[];
  /** Is loading subscriptions */
  loadingSubscriptions: boolean;
  /** Error state */
  error: Error | null;
  /** Clear error */
  clearError: () => void;
}

// ============ Button Types ============

export interface PaymentButtonProps {
  /** Payment amount in token units */
  amount: number;
  /** Token to use (defaults to USDC) */
  token?: string;
  /** Payment description */
  description?: string;
  /** Order ID for tracking */
  orderId?: string;
  /** Use stealth address */
  useStealthAddress?: boolean;
  /** Button text (defaults to "Pay {amount} {token}") */
  children?: React.ReactNode;
  /** Button variant */
  variant?: 'primary' | 'secondary' | 'outline';
  /** Button size */
  size?: 'sm' | 'md' | 'lg';
  /** Disabled state */
  disabled?: boolean;
  /** Loading state */
  loading?: boolean;
  /** On payment success */
  onSuccess?: (result: { signature: string; paymentId: string }) => void;
  /** On payment error */
  onError?: (error: Error) => void;
  /** Custom className */
  className?: string;
  /** Custom styles */
  style?: React.CSSProperties;
}

export interface SubscriptionButtonProps {
  /** Amount per payment period */
  amount: number;
  /** Token to use (defaults to USDC) */
  token?: string;
  /** Payment interval */
  interval: PaymentInterval;
  /** Maximum payments (0 = unlimited) */
  maxPayments?: number;
  /** Subscription description */
  description?: string;
  /** Subscription reference ID */
  subscriptionRef?: string;
  /** Trial period in days */
  trialDays?: number;
  /** Suggested privacy options */
  suggestedPrivacy?: PrivacyOptions;
  /** Button text */
  children?: React.ReactNode;
  /** Button variant */
  variant?: 'primary' | 'secondary' | 'outline';
  /** Button size */
  size?: 'sm' | 'md' | 'lg';
  /** Disabled state */
  disabled?: boolean;
  /** Loading state */
  loading?: boolean;
  /** On subscription success */
  onSuccess?: (result: { subscriptionId: string; signature: string }) => void;
  /** On subscription error */
  onError?: (error: Error) => void;
  /** Custom className */
  className?: string;
  /** Custom styles */
  style?: React.CSSProperties;
}

export interface WalletButtonProps {
  /** Button text when not connected */
  connectText?: string;
  /** Show address when connected */
  showAddress?: boolean;
  /** Truncate address length */
  addressLength?: number;
  /** Button variant */
  variant?: 'primary' | 'secondary' | 'outline';
  /** Button size */
  size?: 'sm' | 'md' | 'lg';
  /** On connect */
  onConnect?: (publicKey: string) => void;
  /** On disconnect */
  onDisconnect?: () => void;
  /** Custom className */
  className?: string;
  /** Custom styles */
  style?: React.CSSProperties;
}

// ============ Widget Types ============

export interface PricingTier {
  /** Tier ID */
  id: string;
  /** Display name */
  name: string;
  /** Price per period */
  price: number;
  /** Token to use */
  token?: string;
  /** Payment interval */
  interval: PaymentInterval;
  /** Description */
  description?: string;
  /** Features included */
  features?: string[];
  /** Is most popular */
  popular?: boolean;
  /** Suggested privacy options */
  suggestedPrivacy?: PrivacyOptions;
  /** Trial days */
  trialDays?: number;
  /** Max payments */
  maxPayments?: number;
}

export interface SubscriptionWidgetProps {
  /** Pricing tiers to display */
  tiers: PricingTier[];
  /** Widget title */
  title?: string;
  /** Widget description */
  description?: string;
  /** Show privacy options toggle */
  showPrivacyOptions?: boolean;
  /** On subscription success */
  onSuccess?: (result: { tierId: string; subscriptionId: string }) => void;
  /** On subscription error */
  onError?: (error: Error) => void;
  /** Custom className */
  className?: string;
  /** Custom styles */
  style?: React.CSSProperties;
  /** Custom theme */
  theme?: Partial<WidgetTheme>;
}

export interface SubscriptionCardProps {
  /** Subscription data */
  subscription: Subscription;
  /** Show cancel button */
  showCancel?: boolean;
  /** On cancel click */
  onCancel?: (subscriptionId: string) => void;
  /** On view details */
  onViewDetails?: (subscription: Subscription) => void;
  /** Custom className */
  className?: string;
  /** Custom styles */
  style?: React.CSSProperties;
}

// ============ Theme Types ============

export interface WidgetTheme {
  /** Primary brand color */
  primaryColor: string;
  /** Secondary color */
  secondaryColor: string;
  /** Background color */
  backgroundColor: string;
  /** Surface color */
  surfaceColor: string;
  /** Text color */
  textColor: string;
  /** Muted text color */
  mutedColor: string;
  /** Border color */
  borderColor: string;
  /** Success color */
  successColor: string;
  /** Error color */
  errorColor: string;
  /** Border radius */
  borderRadius: string;
  /** Font family */
  fontFamily: string;
}

export const DEFAULT_THEME: WidgetTheme = {
  primaryColor: '#39c5bb',
  secondaryColor: '#ff77a8',
  backgroundColor: '#0a0a0c',
  surfaceColor: '#151518',
  textColor: '#ffffff',
  mutedColor: '#888892',
  borderColor: '#2a2a30',
  successColor: '#10b981',
  errorColor: '#ef4444',
  borderRadius: '12px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};
