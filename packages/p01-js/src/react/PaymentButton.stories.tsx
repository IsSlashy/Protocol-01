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

// ============ Demo Payment Button ============
interface DemoPaymentButtonProps {
  amount: number;
  token?: string;
  variant?: 'primary' | 'secondary' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  children?: React.ReactNode;
}

function DemoPaymentButton({
  amount,
  token = 'USDC',
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  children,
}: DemoPaymentButtonProps) {
  const buttonText = children ?? `Pay ${amount} ${token}`;

  const sizeStyles = {
    sm: { padding: '8px 16px', fontSize: '14px', borderRadius: '8px' },
    md: { padding: '12px 24px', fontSize: '16px', borderRadius: '12px' },
    lg: { padding: '16px 32px', fontSize: '18px', borderRadius: '16px' },
  };

  const variantStyles =
    variant === 'primary'
      ? { backgroundColor: THEME.primaryColor, color: THEME.backgroundColor, border: 'none' }
      : variant === 'secondary'
      ? { backgroundColor: THEME.surfaceColor, color: THEME.textColor, border: `1px solid ${THEME.borderColor}` }
      : { backgroundColor: 'transparent', color: THEME.primaryColor, border: `2px solid ${THEME.primaryColor}` };

  return (
    <button
      disabled={disabled || loading}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        fontWeight: 600,
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled || loading ? 0.6 : 1,
        transition: 'all 0.2s ease',
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        ...sizeStyles[size],
        ...variantStyles,
      }}
    >
      {loading ? (
        <>
          <LoadingSpinner color={variant === 'primary' ? THEME.backgroundColor : THEME.primaryColor} />
          Processing...
        </>
      ) : (
        <>
          <PaymentIcon />
          {buttonText}
        </>
      )}
    </button>
  );
}

function PaymentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14m-7-7h14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LoadingSpinner({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 1s linear infinite' }}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray="32" strokeDashoffset="12" />
    </svg>
  );
}

// ============ Storybook Meta ============
const meta: Meta<typeof DemoPaymentButton> = {
  title: 'Components/PaymentButton',
  component: DemoPaymentButton,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `
## PaymentButton

A button component for one-time payments.

### Features
- Displays amount and token
- Multiple variants: \`primary\`, \`secondary\`, \`outline\`
- Multiple sizes: \`sm\`, \`md\`, \`lg\`
- Loading state during payment processing
- Optional stealth address for privacy

### Usage
\`\`\`tsx
import { PaymentButton } from 'p-01/react';

<PaymentButton
  amount={9.99}
  token="USDC"
  description="Premium Feature"
  useStealthAddress={true}
  onSuccess={(result) => console.log('Paid:', result.signature)}
  onError={(err) => console.error(err)}
/>
\`\`\`

### Privacy Features
Enable \`useStealthAddress\` to send payments through a stealth address,
making it impossible to link the payment to your public wallet.
        `,
      },
    },
  },
  argTypes: {
    amount: {
      control: 'number',
      description: 'Payment amount',
    },
    token: {
      control: 'select',
      options: ['USDC', 'SOL', 'USDT'],
      description: 'Token to use for payment',
    },
    variant: {
      control: 'select',
      options: ['primary', 'secondary', 'outline'],
      description: 'Visual style variant',
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
      description: 'Button size',
    },
    disabled: {
      control: 'boolean',
      description: 'Disabled state',
    },
    loading: {
      control: 'boolean',
      description: 'Loading state',
    },
  },
};

export default meta;
type Story = StoryObj<typeof DemoPaymentButton>;

// ============ Stories ============

export const Primary: Story = {
  args: {
    amount: 9.99,
    token: 'USDC',
    variant: 'primary',
    size: 'md',
  },
};

export const Secondary: Story = {
  args: {
    amount: 25,
    token: 'SOL',
    variant: 'secondary',
    size: 'md',
  },
};

export const Outline: Story = {
  args: {
    amount: 100,
    token: 'USDC',
    variant: 'outline',
    size: 'md',
  },
};

export const Small: Story = {
  args: {
    amount: 5,
    token: 'USDC',
    size: 'sm',
  },
};

export const Large: Story = {
  args: {
    amount: 99.99,
    token: 'USDC',
    size: 'lg',
  },
};

export const Loading: Story = {
  args: {
    amount: 9.99,
    token: 'USDC',
    loading: true,
  },
};

export const Disabled: Story = {
  args: {
    amount: 9.99,
    token: 'USDC',
    disabled: true,
  },
};

export const CustomLabel: Story = {
  args: {
    amount: 50,
    token: 'USDC',
    children: 'Buy Premium Access',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div>
        <p style={{ color: THEME.mutedColor, fontSize: '12px', marginBottom: '8px' }}>Variants</p>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <DemoPaymentButton amount={9.99} token="USDC" variant="primary" />
          <DemoPaymentButton amount={25} token="SOL" variant="secondary" />
          <DemoPaymentButton amount={100} token="USDC" variant="outline" />
        </div>
      </div>
      <div>
        <p style={{ color: THEME.mutedColor, fontSize: '12px', marginBottom: '8px' }}>Sizes</p>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <DemoPaymentButton amount={5} token="USDC" size="sm" />
          <DemoPaymentButton amount={9.99} token="USDC" size="md" />
          <DemoPaymentButton amount={99.99} token="USDC" size="lg" />
        </div>
      </div>
      <div>
        <p style={{ color: THEME.mutedColor, fontSize: '12px', marginBottom: '8px' }}>States</p>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <DemoPaymentButton amount={9.99} token="USDC" />
          <DemoPaymentButton amount={9.99} token="USDC" loading />
          <DemoPaymentButton amount={9.99} token="USDC" disabled />
        </div>
      </div>
    </div>
  ),
};
