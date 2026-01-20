import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';

// ============ P-01 Theme Constants ============
// Inspired by: Hatsune Miku, NEEDY STREAMER OVERLOAD, ULTRAKILL
// RULES: NO purple | NO black text | NO green #00ff88
const THEME = {
  // Primary: Cyan (Miku)
  primaryColor: '#39c5bb',
  primaryBright: '#00ffe5',
  // Secondary: Pink (KAngel)
  secondaryColor: '#ff77a8',
  pinkHot: '#ff2d7a',
  // Backgrounds
  backgroundColor: '#0a0a0c',
  surfaceColor: '#151518',
  // Text (NO black)
  textColor: '#ffffff',
  mutedColor: '#888892',
  dimColor: '#555560',
  // Borders
  borderColor: '#2a2a30',
  // Status (cyan for success, NOT green)
  successColor: '#39c5bb',
  errorColor: '#ff3366',
  warningColor: '#ffcc00',
};

// ============ Types ============
interface PricingTier {
  id: string;
  name: string;
  price: number;
  token?: string;
  interval: string;
  description?: string;
  features?: string[];
  popular?: boolean;
  trialDays?: number;
}

interface DemoSubscriptionWidgetProps {
  tiers: PricingTier[];
  title?: string;
  description?: string;
  showPrivacyOptions?: boolean;
}

// ============ Demo Subscription Widget ============
function DemoSubscriptionWidget({
  tiers,
  title = 'Choose Your Plan',
  description,
  showPrivacyOptions = true,
}: DemoSubscriptionWidgetProps) {
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [enablePrivacy, setEnablePrivacy] = useState(true);

  return (
    <div style={{
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      backgroundColor: THEME.backgroundColor,
      borderRadius: '12px',
      padding: '32px',
      maxWidth: '900px',
    }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '32px' }}>
        <h2 style={{ color: THEME.textColor, fontSize: '28px', fontWeight: 700, margin: '0 0 8px 0' }}>
          {title}
        </h2>
        {description && (
          <p style={{ color: THEME.mutedColor, fontSize: '16px', margin: 0 }}>{description}</p>
        )}
      </div>

      {/* Privacy Toggle */}
      {showPrivacyOptions && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '24px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: THEME.mutedColor, fontSize: '14px' }}>
            <input
              type="checkbox"
              checked={enablePrivacy}
              onChange={(e) => setEnablePrivacy(e.target.checked)}
              style={{ accentColor: THEME.primaryColor }}
            />
            <ShieldIcon color={enablePrivacy ? THEME.primaryColor : THEME.mutedColor} />
            Enable Privacy Features
          </label>
        </div>
      )}

      {/* Tiers Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(tiers.length, 3)}, 1fr)`, gap: '24px' }}>
        {tiers.map((tier) => (
          <TierCard
            key={tier.id}
            tier={tier}
            isSelected={selectedTier === tier.id}
            onSelect={() => setSelectedTier(tier.id)}
          />
        ))}
      </div>

      {/* Footer */}
      <div style={{ textAlign: 'center', marginTop: '24px', color: THEME.mutedColor, fontSize: '12px' }}>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
          <LockIcon color={THEME.primaryColor} />
          Secured by Protocol 01 Stream Secure
        </span>
      </div>
    </div>
  );
}

function TierCard({ tier, isSelected, onSelect }: { tier: PricingTier; isSelected: boolean; onSelect: () => void }) {
  return (
    <div
      onClick={onSelect}
      style={{
        backgroundColor: THEME.surfaceColor,
        borderRadius: '12px',
        border: tier.popular ? `2px solid ${THEME.primaryColor}` : `1px solid ${THEME.borderColor}`,
        padding: '24px',
        position: 'relative',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        transform: isSelected ? 'scale(1.02)' : 'scale(1)',
      }}
    >
      {/* Popular Badge */}
      {tier.popular && (
        <div style={{
          position: 'absolute',
          top: '-12px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: THEME.primaryColor,
          color: THEME.backgroundColor,
          padding: '4px 16px',
          borderRadius: '12px',
          fontSize: '12px',
          fontWeight: 600,
        }}>
          Most Popular
        </div>
      )}

      {/* Name */}
      <h3 style={{ color: THEME.textColor, fontSize: '20px', fontWeight: 600, margin: '0 0 8px 0', textAlign: 'center' }}>
        {tier.name}
      </h3>

      {/* Price */}
      <div style={{ textAlign: 'center', marginBottom: '16px' }}>
        <span style={{ color: THEME.textColor, fontSize: '40px', fontWeight: 700 }}>{tier.price}</span>
        <span style={{ color: THEME.mutedColor, fontSize: '16px', marginLeft: '4px' }}>
          {tier.token || 'USDC'}/{tier.interval}
        </span>
      </div>

      {/* Description */}
      {tier.description && (
        <p style={{ color: THEME.mutedColor, fontSize: '14px', textAlign: 'center', margin: '0 0 16px 0' }}>
          {tier.description}
        </p>
      )}

      {/* Trial */}
      {tier.trialDays && (
        <div style={{ textAlign: 'center', marginBottom: '16px', color: THEME.primaryColor, fontSize: '13px', fontWeight: 500 }}>
          {tier.trialDays} day free trial
        </div>
      )}

      {/* Features */}
      {tier.features && tier.features.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 20px 0' }}>
          {tier.features.map((feature, index) => (
            <li key={index} style={{ display: 'flex', alignItems: 'center', gap: '8px', color: THEME.textColor, fontSize: '14px', marginBottom: '8px' }}>
              <CheckIcon color={THEME.successColor} />
              {feature}
            </li>
          ))}
        </ul>
      )}

      {/* Button */}
      <button
        style={{
          width: '100%',
          padding: '14px 24px',
          backgroundColor: tier.popular ? THEME.primaryColor : 'transparent',
          color: tier.popular ? THEME.backgroundColor : THEME.primaryColor,
          border: tier.popular ? 'none' : `2px solid ${THEME.primaryColor}`,
          borderRadius: '10px',
          fontSize: '16px',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Connect Wallet
      </button>
    </div>
  );
}

// Icons
function CheckIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShieldIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon({ color }: { color: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  );
}

// ============ Default Tiers ============
const DEFAULT_TIERS: PricingTier[] = [
  {
    id: 'basic',
    name: 'Basic',
    price: 9.99,
    interval: 'monthly',
    features: ['1 Project', 'Basic Analytics', 'Email Support'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 19.99,
    interval: 'monthly',
    popular: true,
    trialDays: 14,
    features: ['Unlimited Projects', 'Advanced Analytics', 'Priority Support', 'API Access'],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 49.99,
    interval: 'monthly',
    features: ['Everything in Pro', 'Custom Integrations', 'Dedicated Manager', 'SLA Guarantee'],
  },
];

// ============ Storybook Meta ============
const meta: Meta<typeof DemoSubscriptionWidget> = {
  title: 'Widgets/SubscriptionWidget',
  component: DemoSubscriptionWidget,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: `
## SubscriptionWidget

A complete pricing widget for Stream Secure subscription payments.

### Features
- Display multiple pricing tiers
- "Most Popular" badge for highlighted tier
- Trial period support
- Privacy toggle for stealth address payments
- Automatic wallet connection

### Stream Secure Protection
Unlike traditional crypto subscriptions, Stream Secure enforces limits on-chain:
- **Amount limits** - Merchant cannot charge more than approved
- **Frequency limits** - Merchant cannot charge more often than approved
- **Max payments** - Optional limit on total payments

### Usage
\`\`\`tsx
import { P01Provider, SubscriptionWidget } from 'p-01/react';

<P01Provider config={{ merchantId: 'your-id', merchantName: 'Your App' }}>
  <SubscriptionWidget
    title="Choose Your Plan"
    description="Start with a 14-day free trial"
    tiers={[
      {
        id: 'basic',
        name: 'Basic',
        price: 9.99,
        interval: 'monthly',
        features: ['Feature 1', 'Feature 2'],
      },
      {
        id: 'pro',
        name: 'Pro',
        price: 19.99,
        interval: 'monthly',
        popular: true,
        trialDays: 14,
        features: ['All Basic', 'Feature 3', 'Feature 4'],
      },
    ]}
    onSuccess={(result) => console.log('Subscribed:', result)}
    onError={(error) => console.error('Error:', error)}
  />
</P01Provider>
\`\`\`
        `,
      },
    },
  },
  argTypes: {
    title: {
      control: 'text',
      description: 'Widget title',
    },
    description: {
      control: 'text',
      description: 'Widget description',
    },
    showPrivacyOptions: {
      control: 'boolean',
      description: 'Show privacy toggle',
    },
  },
};

export default meta;
type Story = StoryObj<typeof DemoSubscriptionWidget>;

// ============ Stories ============

export const Default: Story = {
  args: {
    tiers: DEFAULT_TIERS,
    title: 'Choose Your Plan',
    description: 'Start with a 14-day free trial. No credit card required.',
    showPrivacyOptions: true,
  },
};

export const TwoTiers: Story = {
  args: {
    tiers: [
      {
        id: 'free',
        name: 'Free',
        price: 0,
        interval: 'monthly',
        features: ['5 Projects', 'Community Support'],
      },
      {
        id: 'pro',
        name: 'Pro',
        price: 29,
        interval: 'monthly',
        popular: true,
        features: ['Unlimited Projects', 'Priority Support', 'Advanced Features'],
      },
    ],
    title: 'Upgrade to Pro',
    description: 'Unlock all features',
  },
};

export const YearlyPricing: Story = {
  args: {
    tiers: [
      {
        id: 'monthly',
        name: 'Monthly',
        price: 19.99,
        interval: 'monthly',
        features: ['All Features', 'Cancel Anytime'],
      },
      {
        id: 'yearly',
        name: 'Yearly',
        price: 199.99,
        interval: 'yearly',
        popular: true,
        description: 'Save 17%',
        features: ['All Features', '2 Months Free', 'Priority Support'],
      },
    ],
    title: 'Choose Billing Cycle',
  },
};

export const WithSOLPricing: Story = {
  args: {
    tiers: [
      {
        id: 'basic',
        name: 'Basic',
        price: 0.5,
        token: 'SOL',
        interval: 'monthly',
        features: ['Basic Access', 'Community Support'],
      },
      {
        id: 'pro',
        name: 'Pro',
        price: 1.5,
        token: 'SOL',
        interval: 'monthly',
        popular: true,
        features: ['Full Access', 'Priority Support', 'Early Features'],
      },
    ],
    title: 'SOL Pricing',
    description: 'Pay in SOL for lower fees',
  },
};

export const NoPrivacyToggle: Story = {
  args: {
    tiers: DEFAULT_TIERS,
    title: 'Simple Pricing',
    showPrivacyOptions: false,
  },
};

export const WithTrials: Story = {
  args: {
    tiers: [
      {
        id: 'starter',
        name: 'Starter',
        price: 9,
        interval: 'monthly',
        trialDays: 7,
        features: ['5 Projects', 'Basic Support'],
      },
      {
        id: 'pro',
        name: 'Professional',
        price: 29,
        interval: 'monthly',
        popular: true,
        trialDays: 14,
        features: ['Unlimited Projects', 'Priority Support', 'API Access'],
      },
      {
        id: 'team',
        name: 'Team',
        price: 79,
        interval: 'monthly',
        trialDays: 30,
        features: ['Everything in Pro', 'Team Management', 'SSO'],
      },
    ],
    title: 'Try Before You Subscribe',
    description: 'All plans include a free trial',
  },
};
