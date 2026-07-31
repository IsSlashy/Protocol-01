/**
 * LicenseKeyCard — persistent license key display for a subscription.
 *
 * Shown on the subscription detail screen. Visible as long as the subscription
 * is active or paused; greyed out and labelled "EXPIRED" when cancelled or
 * completed. The key is deterministic and re-derived on every render from
 * on-chain identifiers, so there is no local state to keep in sync.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { licenseKeyForSubscription, licenseScopeForStream, type LicenseStreamRecord } from '@/services/license/derive';
import { loadVaultSubscriberSecret } from '@/stores/subscriptionVaultStore';

export interface LicenseKeyCardProps {
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  /**
   * The persisted subscription record, passed WHOLE.
   *
   * Deliberately not decomposed into `serviceId` + `retailerAddress` props:
   * choosing which field feeds the HKDF is the decision that broke in
   * production, and a per-field prop list hands that decision back to every
   * caller. `licenseScopeForStream` owns it, and it is unit-tested.
   */
  stream: LicenseStreamRecord;
  /** Service display name (e.g. "Disney+"). Shown in the eyebrow label. */
  serviceName?: string;
  /** SubscriberVault PDA — present for private (ZK vault) subscriptions. */
  vaultAddress?: string;
  /** User wallet pubkey base58 — present for classic subscriptions. */
  walletPubkey?: string;
}

export function LicenseKeyCard(props: LicenseKeyCardProps) {
  const [copied, setCopied] = useState(false);
  const [licenseKey, setLicenseKey] = useState<string | null>(null);

  // Commitment scheme: the displayed key is encodeLicenseKey(licenseSecret),
  // where licenseSecret = HKDF(subscriber master note secret, serviceId). The
  // chain only holds blake3(licenseSecret); the key is the preimage, so it must
  // be re-derived locally from the SecureStore-held note secret (NOT from the
  // public vault PDA). Private (ZK) vaults only — classic license keys are
  // deferred (no deterministic classic signer wired yet).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Private path requires the per-vault subscriber secret.
      if (!props.vaultAddress) {
        // Classic path is deferred under the commitment scheme — no key shown.
        if (!cancelled) setLicenseKey(null);
        return;
      }
      try {
        const secretDecimal = await loadVaultSubscriberSecret(props.vaultAddress);
        if (!secretDecimal) {
          if (!cancelled) setLicenseKey(null);
          return;
        }
        // Shares licenseServiceTag with the subscribe screens that posted
        // license_commitment, so the two cannot resolve the service tag
        // differently. Anything else shows a key the merchant must reject.
        const key = licenseKeyForSubscription(secretDecimal, licenseScopeForStream(props.stream));
        if (!cancelled) setLicenseKey(key);
      } catch {
        if (!cancelled) setLicenseKey(null);
      }
    })();
    return () => { cancelled = true; };
  }, [props.vaultAddress, props.stream.licenseServiceTag, props.stream.serviceId, props.stream.recipientAddress]);

  if (!licenseKey) return null;

  const onCopy = async () => {
    await Clipboard.setStringAsync(licenseKey);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isActive = props.status === 'active';
  const isPaused = props.status === 'paused';
  const statusLabel = isActive ? 'ACTIVE' : isPaused ? 'PAUSED' : 'EXPIRED';
  const statusColor = isActive
    ? P01Colors.cyan
    : isPaused
      ? P01Colors.yellow
      : Colors.textSecondary;

  return (
    <View style={[styles.card, !isActive && styles.cardInactive]}>
      <View style={styles.header}>
        <Text style={styles.eyebrow} numberOfLines={1}>
          LICENSE KEY{props.serviceName ? ` · ${props.serviceName.toUpperCase()}` : ''}
        </Text>
        <View
          style={[
            styles.statusPill,
            { backgroundColor: `${statusColor}22`, borderColor: `${statusColor}55` },
          ]}
        >
          <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>
      </View>

      <TouchableOpacity onPress={onCopy} activeOpacity={0.7} style={styles.keyContainer}>
        <Text
          style={[styles.keyText, !isActive && { opacity: 0.5 }]}
          selectable
          adjustsFontSizeToFit
          numberOfLines={1}
        >
          {licenseKey}
        </Text>
      </TouchableOpacity>

      <View style={styles.footer}>
        <Text style={styles.footerText} numberOfLines={2}>
          {isActive
            ? 'Paste this key in your merchant app. Validated on-chain, no PII attached.'
            : isPaused
              ? 'Subscription paused. Resume to reactivate this key.'
              : 'Key disabled. Subscribe again to renew.'}
        </Text>
        <TouchableOpacity onPress={onCopy} style={styles.copyBtn}>
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={16}
            color={copied ? P01Colors.cyan : Colors.textSecondary}
          />
          <Text style={[styles.copyBtnText, copied && { color: P01Colors.cyan }]}>
            {copied ? 'COPIED' : 'COPY'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#0e1a18',
    borderColor: 'rgba(57, 197, 187, 0.4)',
    borderWidth: 1,
    borderLeftWidth: 3,
    borderLeftColor: P01Colors.cyan,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  cardInactive: {
    borderLeftColor: Colors.textSecondary,
    opacity: 0.85,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  eyebrow: {
    fontFamily: FontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    color: P01Colors.cyan,
    flexShrink: 1,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
  },
  statusText: {
    fontFamily: FontFamily.mono,
    fontSize: 9,
    letterSpacing: 1.5,
    fontWeight: '700',
  },
  keyContainer: {
    paddingVertical: 14,
    paddingHorizontal: 8,
    backgroundColor: '#0a0a0c',
    borderRadius: 6,
    alignItems: 'center',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.15)',
  },
  keyText: {
    fontFamily: FontFamily.mono,
    fontSize: 16,
    letterSpacing: 1.1,
    color: '#00ffe5',
    fontWeight: '600',
    textAlign: 'center',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  footerText: {
    fontFamily: FontFamily.regular,
    fontSize: 11,
    color: Colors.textSecondary,
    flex: 1,
    lineHeight: 16,
  },
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    backgroundColor: 'rgba(57, 197, 187, 0.08)',
  },
  copyBtnText: {
    fontFamily: FontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
});
