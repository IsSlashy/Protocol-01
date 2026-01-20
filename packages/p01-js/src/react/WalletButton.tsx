/**
 * Protocol 01 Wallet Button
 *
 * A button component for connecting/disconnecting wallet.
 */

import React, { useState, useCallback } from 'react';
import { useP01, useP01Theme } from './P01Provider';
import type { WalletButtonProps } from './types';

export function WalletButton({
  connectText = 'Connect Wallet',
  showAddress = true,
  addressLength = 4,
  variant = 'primary',
  size = 'md',
  onConnect,
  onDisconnect,
  className = '',
  style,
}: WalletButtonProps) {
  const { isConnected, publicKey, isP01Wallet, connect, disconnect } = useP01();
  const theme = useP01Theme();
  const [loading, setLoading] = useState(false);

  // Truncate address
  const truncatedAddress = publicKey
    ? `${publicKey.slice(0, addressLength)}...${publicKey.slice(-addressLength)}`
    : '';

  // Handle click
  const handleClick = useCallback(async () => {
    if (loading) return;

    setLoading(true);
    try {
      if (isConnected) {
        await disconnect();
        onDisconnect?.();
      } else {
        await connect();
        if (publicKey) {
          onConnect?.(publicKey);
        }
      }
    } catch (err) {
      console.error('Wallet action failed:', err);
    } finally {
      setLoading(false);
    }
  }, [isConnected, loading, connect, disconnect, onConnect, onDisconnect, publicKey]);

  // Compute styles
  const baseStyles: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    fontFamily: theme.fontFamily,
    fontWeight: 600,
    cursor: loading ? 'not-allowed' : 'pointer',
    opacity: loading ? 0.6 : 1,
    transition: 'all 0.2s ease',
    border: 'none',
    outline: 'none',
    ...getSizeStyles(size),
    ...getVariantStyles(variant, theme, isConnected),
    ...style,
  };

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={`p01-wallet-button ${className}`}
      style={baseStyles}
    >
      {loading ? (
        <>
          <LoadingSpinner color={variant === 'primary' && !isConnected ? theme.backgroundColor : theme.primaryColor} />
          {isConnected ? 'Disconnecting...' : 'Connecting...'}
        </>
      ) : isConnected ? (
        <>
          {isP01Wallet && <P01Icon />}
          {showAddress ? truncatedAddress : 'Disconnect'}
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

// ============ Helper Components ============

function LoadingSpinner({ color }: { color: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      style={{ animation: 'p01-spin 1s linear infinite' }}
    >
      <style>
        {`@keyframes p01-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}
      </style>
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="32"
        strokeDashoffset="12"
      />
    </svg>
  );
}

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

// ============ Style Helpers ============

function getSizeStyles(size: 'sm' | 'md' | 'lg'): React.CSSProperties {
  switch (size) {
    case 'sm':
      return { padding: '8px 16px', fontSize: '14px', borderRadius: '8px' };
    case 'lg':
      return { padding: '16px 32px', fontSize: '18px', borderRadius: '16px' };
    case 'md':
    default:
      return { padding: '12px 24px', fontSize: '16px', borderRadius: '12px' };
  }
}

function getVariantStyles(variant: 'primary' | 'secondary' | 'outline', theme: any, isConnected: boolean): React.CSSProperties {
  // When connected, always show as secondary
  if (isConnected) {
    return {
      backgroundColor: theme.surfaceColor,
      color: theme.textColor,
      border: `1px solid ${theme.borderColor}`,
    };
  }

  switch (variant) {
    case 'secondary':
      return {
        backgroundColor: theme.surfaceColor,
        color: theme.textColor,
        border: `1px solid ${theme.borderColor}`,
      };
    case 'outline':
      return {
        backgroundColor: 'transparent',
        color: theme.primaryColor,
        border: `2px solid ${theme.primaryColor}`,
      };
    case 'primary':
    default:
      return {
        backgroundColor: theme.primaryColor,
        color: theme.backgroundColor,
        border: 'none',
      };
  }
}
