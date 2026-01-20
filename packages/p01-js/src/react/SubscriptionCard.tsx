/**
 * Protocol 01 Subscription Card
 *
 * A card component for displaying subscription details.
 */

import React, { useState, useCallback } from 'react';
import { useP01SDK, useP01Theme } from './P01Provider';
import type { SubscriptionCardProps } from './types';
import { getIntervalName, formatDate, getTimeUntilPayment, fromRawAmount, getTokenSymbol } from '../utils';

export function SubscriptionCard({
  subscription,
  showCancel = true,
  onCancel,
  onViewDetails,
  className = '',
  style,
}: SubscriptionCardProps) {
  const sdk = useP01SDK();
  const theme = useP01Theme();
  const [cancelling, setCancelling] = useState(false);

  const intervalName = getIntervalName(subscription.periodSeconds);
  const nextPayment = getTimeUntilPayment(subscription.nextPaymentAt);

  // Handle cancel
  const handleCancel = useCallback(async () => {
    if (cancelling) return;

    const confirmed = window.confirm(
      `Are you sure you want to cancel your ${subscription.merchantName} subscription?`
    );

    if (!confirmed) return;

    setCancelling(true);
    try {
      if (sdk) {
        await sdk.cancelSubscription(subscription.id);
      }
      onCancel?.(subscription.id);
    } catch (err) {
      console.error('Failed to cancel subscription:', err);
    } finally {
      setCancelling(false);
    }
  }, [sdk, subscription, onCancel, cancelling]);

  // Status color
  const getStatusColor = () => {
    switch (subscription.status) {
      case 'active':
        return theme.successColor;
      case 'paused':
        return '#f59e0b';
      case 'cancelled':
      case 'failed':
        return theme.errorColor;
      default:
        return theme.mutedColor;
    }
  };

  // Card styles
  const cardStyles: React.CSSProperties = {
    backgroundColor: theme.surfaceColor,
    borderRadius: theme.borderRadius,
    border: `1px solid ${theme.borderColor}`,
    padding: '20px',
    fontFamily: theme.fontFamily,
    ...style,
  };

  return (
    <div className={`p01-subscription-card ${className}`} style={cardStyles}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '16px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Merchant Icon */}
          <div style={{
            width: '40px',
            height: '40px',
            borderRadius: '10px',
            backgroundColor: theme.primaryColor + '20',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <SubscriptionIcon color={theme.primaryColor} />
          </div>

          {/* Merchant Name */}
          <div>
            <h4 style={{
              color: theme.textColor,
              fontSize: '16px',
              fontWeight: 600,
              margin: 0,
            }}>
              {subscription.merchantName}
            </h4>
            {subscription.description && (
              <p style={{
                color: theme.mutedColor,
                fontSize: '13px',
                margin: '2px 0 0 0',
              }}>
                {subscription.description}
              </p>
            )}
          </div>
        </div>

        {/* Status Badge */}
        <div style={{
          padding: '4px 10px',
          borderRadius: '6px',
          backgroundColor: getStatusColor() + '20',
          color: getStatusColor(),
          fontSize: '12px',
          fontWeight: 600,
          textTransform: 'capitalize',
        }}>
          {subscription.status}
        </div>
      </div>

      {/* Details */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '16px',
        marginBottom: '16px',
      }}>
        {/* Amount */}
        <div>
          <p style={{
            color: theme.mutedColor,
            fontSize: '12px',
            margin: '0 0 4px 0',
          }}>
            Amount
          </p>
          <p style={{
            color: theme.textColor,
            fontSize: '16px',
            fontWeight: 600,
            margin: 0,
          }}>
            {subscription.amountPerPeriod} {subscription.tokenSymbol}
          </p>
          <p style={{
            color: theme.mutedColor,
            fontSize: '12px',
            margin: '2px 0 0 0',
          }}>
            per {intervalName}
          </p>
        </div>

        {/* Next Payment */}
        <div>
          <p style={{
            color: theme.mutedColor,
            fontSize: '12px',
            margin: '0 0 4px 0',
          }}>
            Next Payment
          </p>
          <p style={{
            color: theme.textColor,
            fontSize: '16px',
            fontWeight: 600,
            margin: 0,
          }}>
            {nextPayment}
          </p>
          <p style={{
            color: theme.mutedColor,
            fontSize: '12px',
            margin: '2px 0 0 0',
          }}>
            {formatDate(subscription.nextPaymentAt)}
          </p>
        </div>

        {/* Total Paid */}
        <div>
          <p style={{
            color: theme.mutedColor,
            fontSize: '12px',
            margin: '0 0 4px 0',
          }}>
            Total Paid
          </p>
          <p style={{
            color: theme.textColor,
            fontSize: '16px',
            fontWeight: 600,
            margin: 0,
          }}>
            {subscription.totalPaid} {subscription.tokenSymbol}
          </p>
          <p style={{
            color: theme.mutedColor,
            fontSize: '12px',
            margin: '2px 0 0 0',
          }}>
            {subscription.periodsPaid} payments
          </p>
        </div>
      </div>

      {/* Privacy Badge */}
      {subscription.privacySettings?.useStealthAddress && (
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 12px',
          backgroundColor: theme.primaryColor + '10',
          borderRadius: '6px',
          marginBottom: '16px',
        }}>
          <ShieldIcon color={theme.primaryColor} />
          <span style={{
            color: theme.primaryColor,
            fontSize: '12px',
            fontWeight: 500,
          }}>
            Privacy Enabled
          </span>
        </div>
      )}

      {/* Actions */}
      <div style={{
        display: 'flex',
        gap: '12px',
        borderTop: `1px solid ${theme.borderColor}`,
        paddingTop: '16px',
        marginTop: '8px',
      }}>
        {onViewDetails && (
          <button
            onClick={() => onViewDetails(subscription)}
            style={{
              flex: 1,
              padding: '10px 16px',
              backgroundColor: 'transparent',
              color: theme.textColor,
              border: `1px solid ${theme.borderColor}`,
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            View Details
          </button>
        )}

        {showCancel && subscription.status === 'active' && (
          <button
            onClick={handleCancel}
            disabled={cancelling}
            style={{
              flex: 1,
              padding: '10px 16px',
              backgroundColor: 'transparent',
              color: theme.errorColor,
              border: `1px solid ${theme.errorColor}40`,
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: cancelling ? 'not-allowed' : 'pointer',
              opacity: cancelling ? 0.6 : 1,
              transition: 'all 0.2s ease',
            }}
          >
            {cancelling ? 'Cancelling...' : 'Cancel'}
          </button>
        )}
      </div>
    </div>
  );
}

// ============ Icons ============

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
