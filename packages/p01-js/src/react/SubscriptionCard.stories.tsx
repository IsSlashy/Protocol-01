import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';

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
interface DemoSubscriptionCardProps {
  merchantName: string;
  description?: string;
  amount: number;
  token?: string;
  interval: string;
  status: 'active' | 'paused' | 'cancelled' | 'failed';
  nextPayment: string;
  totalPaid: number;
  periodsPaid: number;
  privacyEnabled?: boolean;
  showCancel?: boolean;
  showDetails?: boolean;
}

// ============ Demo Subscription Card ============
function DemoSubscriptionCard({
  merchantName,
  description,
  amount,
  token = 'USDC',
  interval,
  status,
  nextPayment,
  totalPaid,
  periodsPaid,
  privacyEnabled = false,
  showCancel = true,
  showDetails = true,
}: DemoSubscriptionCardProps) {
  const statusColor =
    status === 'active' ? THEME.successColor
    : status === 'paused' ? THEME.warningColor
    : THEME.errorColor;

  return (
    <div
      style={{
        backgroundColor: THEME.surfaceColor,
        borderRadius: '12px',
        border: `1px solid ${THEME.borderColor}`,
        padding: '20px',
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        width: '380px',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '40px',
            height: '40px',
            borderRadius: '10px',
            backgroundColor: THEME.primaryColor + '20',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <SubscriptionIcon color={THEME.primaryColor} />
          </div>
          <div>
            <h4 style={{ color: THEME.textColor, fontSize: '16px', fontWeight: 600, margin: 0 }}>{merchantName}</h4>
            {description && (
              <p style={{ color: THEME.mutedColor, fontSize: '13px', margin: '2px 0 0 0' }}>{description}</p>
            )}
          </div>
        </div>
        <div style={{
          padding: '4px 10px',
          borderRadius: '6px',
          backgroundColor: statusColor + '20',
          color: statusColor,
          fontSize: '12px',
          fontWeight: 600,
          textTransform: 'capitalize',
        }}>
          {status}
        </div>
      </div>

      {/* Details Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '16px' }}>
        <div>
          <p style={{ color: THEME.mutedColor, fontSize: '12px', margin: '0 0 4px 0' }}>Amount</p>
          <p style={{ color: THEME.textColor, fontSize: '16px', fontWeight: 600, margin: 0 }}>{amount} {token}</p>
          <p style={{ color: THEME.mutedColor, fontSize: '12px', margin: '2px 0 0 0' }}>per {interval}</p>
        </div>
        <div>
          <p style={{ color: THEME.mutedColor, fontSize: '12px', margin: '0 0 4px 0' }}>Next Payment</p>
          <p style={{ color: THEME.textColor, fontSize: '16px', fontWeight: 600, margin: 0 }}>{nextPayment}</p>
        </div>
        <div>
          <p style={{ color: THEME.mutedColor, fontSize: '12px', margin: '0 0 4px 0' }}>Total Paid</p>
          <p style={{ color: THEME.textColor, fontSize: '16px', fontWeight: 600, margin: 0 }}>{totalPaid} {token}</p>
          <p style={{ color: THEME.mutedColor, fontSize: '12px', margin: '2px 0 0 0' }}>{periodsPaid} payments</p>
        </div>
      </div>

      {/* Privacy Badge */}
      {privacyEnabled && (
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 12px',
          backgroundColor: THEME.primaryColor + '10',
          borderRadius: '6px',
          marginBottom: '16px',
        }}>
          <ShieldIcon color={THEME.primaryColor} />
          <span style={{ color: THEME.primaryColor, fontSize: '12px', fontWeight: 500 }}>Privacy Enabled</span>
        </div>
      )}

      {/* Actions */}
      <div style={{
        display: 'flex',
        gap: '12px',
        borderTop: `1px solid ${THEME.borderColor}`,
        paddingTop: '16px',
        marginTop: '8px',
      }}>
        {showDetails && (
          <button style={{
            flex: 1,
            padding: '10px 16px',
            backgroundColor: 'transparent',
            color: THEME.textColor,
            border: `1px solid ${THEME.borderColor}`,
            borderRadius: '8px',
            fontSize: '14px',
            fontWeight: 500,
            cursor: 'pointer',
          }}>
            View Details
          </button>
        )}
        {showCancel && status === 'active' && (
          <button style={{
            flex: 1,
            padding: '10px 16px',
            backgroundColor: 'transparent',
            color: THEME.errorColor,
            border: `1px solid ${THEME.errorColor}40`,
            borderRadius: '8px',
            fontSize: '14px',
            fontWeight: 500,
            cursor: 'pointer',
          }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// Icons
function SubscriptionIcon({ color }: { color: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShieldIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ============ Storybook Meta ============
const meta: Meta<typeof DemoSubscriptionCard> = {
  title: 'Components/SubscriptionCard',
  component: DemoSubscriptionCard,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `
## SubscriptionCard

A card component for displaying active subscription details.

### Features
- Shows merchant info, amount, and payment schedule
- Status badge (active, paused, cancelled, failed)
- Privacy badge when stealth address is enabled
- View details and cancel actions

### Usage
\`\`\`tsx
import { SubscriptionCard } from 'p-01/react';

<SubscriptionCard
  subscription={subscription}
  showCancel={true}
  onCancel={(id) => console.log('Cancelled:', id)}
  onViewDetails={(sub) => openModal(sub)}
/>
\`\`\`

### Subscription Object
\`\`\`typescript
interface Subscription {
  id: string;
  merchantId: string;
  merchantName: string;
  description?: string;
  amountPerPeriod: number;
  tokenSymbol: string;
  periodSeconds: number;
  status: 'active' | 'paused' | 'cancelled' | 'failed';
  nextPaymentAt: number;
  totalPaid: number;
  periodsPaid: number;
  privacySettings?: {
    useStealthAddress: boolean;
  };
}
\`\`\`
        `,
      },
    },
  },
  argTypes: {
    merchantName: { control: 'text', description: 'Service/merchant name' },
    description: { control: 'text', description: 'Subscription description' },
    amount: { control: 'number', description: 'Amount per period' },
    token: { control: 'select', options: ['USDC', 'SOL', 'USDT'], description: 'Token' },
    interval: { control: 'select', options: ['daily', 'weekly', 'monthly', 'yearly'], description: 'Payment interval' },
    status: { control: 'select', options: ['active', 'paused', 'cancelled', 'failed'], description: 'Subscription status' },
    nextPayment: { control: 'text', description: 'Next payment date/time' },
    totalPaid: { control: 'number', description: 'Total amount paid' },
    periodsPaid: { control: 'number', description: 'Number of payments made' },
    privacyEnabled: { control: 'boolean', description: 'Privacy features enabled' },
    showCancel: { control: 'boolean', description: 'Show cancel button' },
    showDetails: { control: 'boolean', description: 'Show details button' },
  },
};

export default meta;
type Story = StoryObj<typeof DemoSubscriptionCard>;

// ============ Stories ============

export const Active: Story = {
  args: {
    merchantName: 'Netflix',
    description: 'Premium Plan',
    amount: 15.99,
    token: 'USDC',
    interval: 'monthly',
    status: 'active',
    nextPayment: 'in 12 days',
    totalPaid: 47.97,
    periodsPaid: 3,
  },
};

export const ActiveWithPrivacy: Story = {
  args: {
    merchantName: 'ProtonMail',
    description: 'Plus Plan',
    amount: 4.99,
    token: 'USDC',
    interval: 'monthly',
    status: 'active',
    nextPayment: 'in 5 days',
    totalPaid: 29.94,
    periodsPaid: 6,
    privacyEnabled: true,
  },
};

export const Paused: Story = {
  args: {
    merchantName: 'Spotify',
    description: 'Family Plan',
    amount: 16.99,
    token: 'USDC',
    interval: 'monthly',
    status: 'paused',
    nextPayment: 'Paused',
    totalPaid: 33.98,
    periodsPaid: 2,
  },
};

export const Cancelled: Story = {
  args: {
    merchantName: 'Adobe CC',
    description: 'All Apps',
    amount: 54.99,
    token: 'USDC',
    interval: 'monthly',
    status: 'cancelled',
    nextPayment: '—',
    totalPaid: 164.97,
    periodsPaid: 3,
  },
};

export const Failed: Story = {
  args: {
    merchantName: 'GitHub',
    description: 'Pro',
    amount: 4,
    token: 'USDC',
    interval: 'monthly',
    status: 'failed',
    nextPayment: 'Failed',
    totalPaid: 8,
    periodsPaid: 2,
  },
};

export const SOLPayment: Story = {
  args: {
    merchantName: 'Magic Eden',
    description: 'Pro Trader',
    amount: 0.5,
    token: 'SOL',
    interval: 'monthly',
    status: 'active',
    nextPayment: 'in 3 days',
    totalPaid: 1.5,
    periodsPaid: 3,
    privacyEnabled: true,
  },
};

export const AllStatuses: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <DemoSubscriptionCard
        merchantName="Active Service"
        description="Monthly Plan"
        amount={9.99}
        interval="monthly"
        status="active"
        nextPayment="in 12 days"
        totalPaid={29.97}
        periodsPaid={3}
      />
      <DemoSubscriptionCard
        merchantName="Paused Service"
        description="Yearly Plan"
        amount={99}
        interval="yearly"
        status="paused"
        nextPayment="Paused"
        totalPaid={99}
        periodsPaid={1}
      />
      <DemoSubscriptionCard
        merchantName="Cancelled Service"
        description="Basic Plan"
        amount={4.99}
        interval="monthly"
        status="cancelled"
        nextPayment="—"
        totalPaid={14.97}
        periodsPaid={3}
      />
      <DemoSubscriptionCard
        merchantName="Failed Service"
        description="Pro Plan"
        amount={19.99}
        interval="monthly"
        status="failed"
        nextPayment="Payment failed"
        totalPaid={39.98}
        periodsPaid={2}
      />
    </div>
  ),
  parameters: {
    layout: 'padded',
  },
};
