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

// ============ Demo Wallet Button ============
// We use a demo version because the real component requires P01Provider context

interface DemoWalletButtonProps {
  variant?: 'primary' | 'secondary' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  connectText?: string;
  connected?: boolean;
  address?: string;
  isP01Wallet?: boolean;
  loading?: boolean;
}

function DemoWalletButton({
  variant = 'primary',
  size = 'md',
  connectText = 'Connect Wallet',
  connected = false,
  address = '7xK9f...8c2e',
  isP01Wallet = false,
  loading = false,
}: DemoWalletButtonProps) {
  const sizeStyles = {
    sm: { padding: '8px 16px', fontSize: '14px', borderRadius: '8px' },
    md: { padding: '12px 24px', fontSize: '16px', borderRadius: '12px' },
    lg: { padding: '16px 32px', fontSize: '18px', borderRadius: '16px' },
  };

  const variantStyles = connected
    ? { backgroundColor: THEME.surfaceColor, color: THEME.textColor, border: `1px solid ${THEME.borderColor}` }
    : variant === 'primary'
    ? { backgroundColor: THEME.primaryColor, color: THEME.backgroundColor, border: 'none' }
    : variant === 'secondary'
    ? { backgroundColor: THEME.surfaceColor, color: THEME.textColor, border: `1px solid ${THEME.borderColor}` }
    : { backgroundColor: 'transparent', color: THEME.primaryColor, border: `2px solid ${THEME.primaryColor}` };

  return (
    <button
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        fontWeight: 600,
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.6 : 1,
        transition: 'all 0.2s ease',
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        ...sizeStyles[size],
        ...variantStyles,
      }}
    >
      {loading ? (
        <>
          <LoadingSpinner color={variant === 'primary' && !connected ? THEME.backgroundColor : THEME.primaryColor} />
          {connected ? 'Disconnecting...' : 'Connecting...'}
        </>
      ) : connected ? (
        <>
          {isP01Wallet && <P01Icon />}
          {address}
        </>
      ) : (
        <>
          <WalletIcon />
          {connectText}
        </>
      )}
    </button>
  );
}

// Icons
function WalletIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 9a2 2 0 012-2h14a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 9V7a2 2 0 012-2h12a2 2 0 012 2v2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="14" r="2" fill="currentColor" />
    </svg>
  );
}

function P01Icon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
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
const meta: Meta<typeof DemoWalletButton> = {
  title: 'Components/WalletButton',
  component: DemoWalletButton,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `
## WalletButton

A button component for connecting/disconnecting the user's wallet.

### Features
- Multiple variants: \`primary\`, \`secondary\`, \`outline\`
- Multiple sizes: \`sm\`, \`md\`, \`lg\`
- Shows truncated address when connected
- P-01 badge for Protocol 01 wallets
- Loading states for connect/disconnect actions

### Usage
\`\`\`tsx
import { WalletButton } from 'p-01/react';

<WalletButton
  variant="primary"
  size="md"
  onConnect={(pubkey) => console.log('Connected:', pubkey)}
  onDisconnect={() => console.log('Disconnected')}
/>
\`\`\`
        `,
      },
    },
  },
  argTypes: {
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
    connectText: {
      control: 'text',
      description: 'Text displayed when not connected',
    },
    connected: {
      control: 'boolean',
      description: 'Connection state',
    },
    address: {
      control: 'text',
      description: 'Wallet address (truncated)',
    },
    isP01Wallet: {
      control: 'boolean',
      description: 'Whether the wallet is a Protocol 01 wallet',
    },
    loading: {
      control: 'boolean',
      description: 'Loading state',
    },
  },
};

export default meta;
type Story = StoryObj<typeof DemoWalletButton>;

// ============ Stories ============

export const Primary: Story = {
  args: {
    variant: 'primary',
    size: 'md',
    connectText: 'Connect Wallet',
  },
};

export const Secondary: Story = {
  args: {
    variant: 'secondary',
    size: 'md',
  },
};

export const Outline: Story = {
  args: {
    variant: 'outline',
    size: 'md',
  },
};

export const Small: Story = {
  args: {
    variant: 'primary',
    size: 'sm',
  },
};

export const Large: Story = {
  args: {
    variant: 'primary',
    size: 'lg',
  },
};

export const Connected: Story = {
  args: {
    connected: true,
    address: '7xK9f...8c2e',
    isP01Wallet: false,
  },
};

export const ConnectedP01Wallet: Story = {
  args: {
    connected: true,
    address: '7xK9f...8c2e',
    isP01Wallet: true,
  },
  parameters: {
    docs: {
      description: {
        story: 'Shows P-01 badge when connected with a Protocol 01 wallet.',
      },
    },
  },
};

export const Connecting: Story = {
  args: {
    loading: true,
    connected: false,
  },
};

export const Disconnecting: Story = {
  args: {
    loading: true,
    connected: true,
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div>
        <p style={{ color: THEME.mutedColor, fontSize: '12px', marginBottom: '8px' }}>Disconnected</p>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <DemoWalletButton variant="primary" />
          <DemoWalletButton variant="secondary" />
          <DemoWalletButton variant="outline" />
        </div>
      </div>
      <div>
        <p style={{ color: THEME.mutedColor, fontSize: '12px', marginBottom: '8px' }}>Connected</p>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <DemoWalletButton connected address="7xK9f...8c2e" />
          <DemoWalletButton connected address="3mN2p...4f1a" isP01Wallet />
        </div>
      </div>
      <div>
        <p style={{ color: THEME.mutedColor, fontSize: '12px', marginBottom: '8px' }}>Sizes</p>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <DemoWalletButton size="sm" />
          <DemoWalletButton size="md" />
          <DemoWalletButton size="lg" />
        </div>
      </div>
    </div>
  ),
};
