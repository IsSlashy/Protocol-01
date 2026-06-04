// ═══════════════════════════════════════════════════════════════════════════
// PrivacyReceiptRN — React Native port of apps/mugen/components/PrivacyReceipt.
// Renders the 4 composable privacy layers (L1, L8, L9, L11) + an optional
// claim-match card for the taker flow. Uses @expo/vector-icons/MaterialIcons
// (lucide-react-native is not in the mobile package.json — fallback chosen
// to avoid adding a new dep).
// ═══════════════════════════════════════════════════════════════════════════

import { MaterialIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import CopyLink from './CopyLink';
import { GojoColors, Mono } from './SharedStyles';

// ─── Public props ───────────────────────────────────────────────────────────

export interface PrivacyReceiptThreshold {
  signaturesCount: number;
  threshold: number;
  totalSigners: number;
  signers: {
    region: string;
    port: number;
    signerPubkey: string;
    signedAt: number;
  }[];
  txHashHex: string;
}

export interface PrivacyReceiptMatchedOrder {
  makerNoncePubkey: string;
  cryptoAmountLamports: number;
  fiatAmountCents: number;
  fiatCurrency: 'EUR' | 'USD';
  paymentMethods: number;
  mpcTxSignature: string;
}

export interface PrivacyReceiptClaimResult {
  tokenEscrow?: boolean;
  escrowPDA?: string;
  vaultPDA?: string;
  orderPDA?: string;
  reputationPDA?: string;
  txSignature?: string;
  feeSplit?: Record<string, string>;
  fallbackReason?: string;
}

export interface PrivacyReceiptProps {
  operation: 'submit' | 'take';
  computationOffset?: string;
  txSignature: string;
  threshold?: PrivacyReceiptThreshold;
  matched?: boolean;
  fiatCurrency?: 'EUR' | 'USD';
  matchedOrder?: PrivacyReceiptMatchedOrder;
  takerNoncePubkey?: string;
  onClaim?: (takerWallet: string) => Promise<void>;
  claimInFlight?: boolean;
  claimResult?: PrivacyReceiptClaimResult;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const PAYMENT_METHOD_LABELS: readonly { label: string; bit: number }[] = [
  { label: 'SEPA', bit: 1 },
  { label: 'Revolut', bit: 2 },
  { label: 'Wise', bit: 4 },
  { label: 'Cash', bit: 8 },
  { label: 'Zelle', bit: 16 },
];

function decodePaymentMethods(mask: number): string {
  const hits = PAYMENT_METHOD_LABELS.filter((m) => (mask & m.bit) !== 0).map(
    (m) => m.label,
  );
  return hits.length > 0 ? hits.join(' · ') : `0x${mask.toString(16)}`;
}

function formatRelative(tsSeconds: number, nowMs: number): string {
  if (nowMs === 0) return '—';
  const ms = tsSeconds < 1e12 ? tsSeconds * 1000 : tsSeconds;
  const diff = Math.max(0, nowMs - ms);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function shortenPubkey(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

// ─── Layer row ──────────────────────────────────────────────────────────────

type IconName = keyof typeof MaterialIcons.glyphMap;

interface LayerRowProps {
  layerKey: string;
  title: string;
  accent: string;
  icon: IconName;
  description: string;
  prominent?: boolean;
  children?: React.ReactNode;
}

function LayerRow({
  layerKey,
  title,
  accent,
  icon,
  description,
  prominent = false,
  children,
}: LayerRowProps): React.ReactElement {
  return (
    <View
      style={[
        styles.layer,
        {
          borderColor: `${accent}${prominent ? '88' : '44'}`,
          backgroundColor: prominent ? `${accent}14` : GojoColors.bgCardFilled,
        },
      ]}
    >
      <View
        style={[
          styles.layerIcon,
          {
            backgroundColor: `${accent}22`,
            borderColor: `${accent}55`,
            width: prominent ? 34 : 30,
            height: prominent ? 34 : 30,
          },
        ]}
      >
        <MaterialIcons name={icon} size={16} color={accent} />
      </View>
      <View style={styles.layerBody}>
        <View style={styles.layerHeader}>
          <Text style={[styles.layerTag, { color: accent }]}>{layerKey}</Text>
          <Text style={[styles.layerTitle, prominent && { fontSize: 14 }]}>
            {title}
          </Text>
          {prominent ? (
            <View
              style={[
                styles.proofBadge,
                { borderColor: `${accent}55`, backgroundColor: `${accent}1f` },
              ]}
            >
              <MaterialIcons name="check-circle" size={9} color={accent} />
              <Text style={[styles.proofBadgeText, { color: accent }]}>
                ON-CHAIN PROOF
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.layerDesc}>{description}</Text>
        {children ? <View style={styles.layerDetail}>{children}</View> : null}
      </View>
    </View>
  );
}

// ─── Signer pill ────────────────────────────────────────────────────────────

interface SignerPillProps {
  region: string;
  signerPubkey: string;
  signedAt: number;
  nowMs: number;
}

function SignerPill({
  region,
  signerPubkey,
  signedAt,
  nowMs,
}: SignerPillProps): React.ReactElement {
  return (
    <View style={styles.signerPill}>
      <MaterialIcons name="check-circle" size={10} color={GojoColors.successLight} />
      <Text style={styles.signerRegion}>{region}</Text>
      <Text style={styles.signerKey}>{shortenPubkey(signerPubkey)}</Text>
      <Text style={styles.signerTime}>· {formatRelative(signedAt, nowMs)}</Text>
    </View>
  );
}

// ─── Claim match card ───────────────────────────────────────────────────────

interface ClaimCardProps {
  matchedOrder: PrivacyReceiptMatchedOrder;
  takerNoncePubkey: string;
  fiatCurrency: 'EUR' | 'USD';
  onClaim?: (takerWallet: string) => Promise<void>;
  claimInFlight?: boolean;
  claimResult?: PrivacyReceiptClaimResult;
}

function ClaimCard({
  matchedOrder,
  fiatCurrency,
  onClaim,
  claimInFlight,
  claimResult,
}: ClaimCardProps): React.ReactElement {
  const methods = decodePaymentMethods(matchedOrder.paymentMethods);
  const crypto = (matchedOrder.cryptoAmountLamports / 1e9).toFixed(6);
  const fiat = (matchedOrder.fiatAmountCents / 100).toFixed(2);

  // Success state
  if (claimResult) {
    return (
      <View style={styles.claimSuccessCard}>
        <View style={styles.claimHeader}>
          <MaterialIcons name="check-circle" size={16} color={GojoColors.successLight} />
          <Text style={styles.claimSuccessTitle}>
            {claimResult.tokenEscrow ? 'Token escrow active' : 'Escrow ready'}
          </Text>
        </View>
        {claimResult.escrowPDA ? (
          <RefRow label="escrow" value={claimResult.escrowPDA} type="address" />
        ) : null}
        {claimResult.vaultPDA ? (
          <RefRow label="vault" value={claimResult.vaultPDA} type="address" />
        ) : null}
        {claimResult.orderPDA ? (
          <RefRow label="order" value={claimResult.orderPDA} type="address" />
        ) : null}
        {claimResult.txSignature ? (
          <RefRow label="tx" value={claimResult.txSignature} type="tx" />
        ) : null}
        {claimResult.fallbackReason ? (
          <Text style={styles.claimFallbackText}>
            token escrow unavailable: {claimResult.fallbackReason}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.claimCard}>
      <View style={styles.claimHeader}>
        <MaterialIcons name="handshake" size={14} color={GojoColors.violetLight} />
        <Text style={styles.claimTitle}>Claim match &amp; create escrow</Text>
      </View>
      <View style={styles.claimRow}>
        <Text style={styles.claimRowLabel}>amount:</Text>
        <Text style={styles.claimRowValue}>
          {crypto} SOL ↔ {fiat} {fiatCurrency}
        </Text>
      </View>
      <View style={styles.claimRow}>
        <Text style={styles.claimRowLabel}>rails:</Text>
        <Text style={styles.claimRowValue}>{methods}</Text>
      </View>
      <View style={styles.claimRow}>
        <Text style={styles.claimRowLabel}>maker:</Text>
        <CopyLink
          value={matchedOrder.makerNoncePubkey}
          type="address"
          label="maker nonce pubkey"
        />
      </View>
      {onClaim ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Claim match and create escrow"
          disabled={claimInFlight}
          onPress={() => {
            void onClaim('');
          }}
          style={({ pressed }) => [
            styles.claimButton,
            {
              opacity: pressed || claimInFlight ? 0.7 : 1,
              backgroundColor: claimInFlight
                ? 'rgba(139,92,246,0.1)'
                : 'rgba(139,92,246,0.25)',
            },
          ]}
        >
          <MaterialIcons
            name={claimInFlight ? 'hourglass-empty' : 'handshake'}
            size={12}
            color={GojoColors.violetLight}
          />
          <Text style={styles.claimButtonText}>
            {claimInFlight ? 'Creating escrow…' : 'Claim match'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function RefRow({
  label,
  value,
  type,
}: {
  label: string;
  value: string;
  type: 'tx' | 'address';
}): React.ReactElement {
  return (
    <View style={styles.claimRow}>
      <Text style={styles.claimRowLabel}>{label}:</Text>
      <CopyLink value={value} type={type} label={label} />
    </View>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function PrivacyReceiptRN({
  operation,
  computationOffset,
  txSignature,
  threshold,
  matched,
  fiatCurrency,
  matchedOrder,
  takerNoncePubkey,
  onClaim,
  claimInFlight,
  claimResult,
}: PrivacyReceiptProps): React.ReactElement {
  const [nowMs, setNowMs] = useState(0);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const onShareReceipt = useCallback(async () => {
    const payload = {
      operation,
      matched: matched ?? null,
      txSignature,
      explorer: `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`,
      computationOffset: computationOffset ?? null,
      fiatCurrency: fiatCurrency ?? matchedOrder?.fiatCurrency ?? null,
      threshold: threshold
        ? {
            signaturesCount: threshold.signaturesCount,
            threshold: threshold.threshold,
            totalSigners: threshold.totalSigners,
            txHashHex: threshold.txHashHex,
            signers: threshold.signers,
          }
        : null,
      matchedOrder: matchedOrder ?? null,
      takerNoncePubkey: takerNoncePubkey ?? null,
      generatedAt: new Date().toISOString(),
    };
    const json = JSON.stringify(payload, null, 2);
    try {
      await Clipboard.setStringAsync(json);
      await Share.share({ message: json });
      setShared(true);
    } catch {
      // best-effort
    }
  }, [
    operation,
    matched,
    txSignature,
    computationOffset,
    fiatCurrency,
    matchedOrder,
    threshold,
    takerNoncePubkey,
  ]);

  useEffect(() => {
    if (!shared) return;
    const t = setTimeout(() => setShared(false), 1500);
    return () => clearTimeout(t);
  }, [shared]);

  const heading =
    operation === 'submit'
      ? 'Private order submitted'
      : matched
        ? 'Private match found'
        : 'Blind take executed — no match';

  const subheading =
    operation === 'submit'
      ? 'Plaintext terms never left your device. Here is the privacy receipt:'
      : matched
        ? 'A match was found. Your terms stayed encrypted on the device.'
        : 'No compatible encrypted order existed. Nothing was revealed about your search.';

  const l8Description =
    operation === 'submit'
      ? 'Plaintext amount, fiat, and rails were encrypted on device before hitting Arcium.'
      : 'Your terms were encrypted on the device and submitted as a blind order.';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      accessibilityLabel="Privacy receipt"
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <View style={styles.headerIcon}>
          <MaterialIcons name="check-circle" size={16} color={GojoColors.successLight} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.headerHeading}>{heading}</Text>
          <Text style={styles.headerSubheading}>{subheading}</Text>
        </View>
      </View>

      {/* L1 */}
      <LayerRow
        layerKey="L1"
        title="Natural Variance Fiat"
        accent={GojoColors.warningLight}
        icon="euro"
        description="Off-chain fiat leg carries organic transaction noise — no chain-observable settlement on the fiat side."
      >
        <View style={styles.inlineRow}>
          <MaterialIcons name="check-circle" size={11} color={GojoColors.warningLight} />
          <Text style={[styles.mono, { color: GojoColors.warningLight }]}>
            P2P rails, no on-chain fiat trail
          </Text>
        </View>
      </LayerRow>

      {/* L8 — prominent */}
      <LayerRow
        layerKey="L8"
        title="Arcium MPC"
        accent={GojoColors.violetLight}
        icon="memory"
        description={l8Description}
        prominent
      >
        {computationOffset ? (
          <View style={styles.inlineRow}>
            <Text style={styles.monoLabel}>offset:</Text>
            <Text
              style={[styles.mono, { color: GojoColors.violetLight }]}
              numberOfLines={1}
            >
              {computationOffset}
            </Text>
          </View>
        ) : null}
        <View style={styles.inlineRow}>
          <Text style={styles.monoLabel}>tx:</Text>
          <CopyLink value={txSignature} type="tx" label="MPC tx signature" />
        </View>
      </LayerRow>

      {/* L9 */}
      <LayerRow
        layerKey="L9"
        title="FROST Quorum"
        accent={GojoColors.blueLight}
        icon="hub"
        description="A 2-of-3 distributed signer network approved the MPC transaction before the relayer signed it. No single node can front-run or censor."
      >
        {threshold ? (
          <View style={{ gap: 6 }}>
            <View style={styles.inlineRow}>
              <MaterialIcons name="verified-user" size={11} color={GojoColors.successLight} />
              <Text style={[styles.mono, { color: GojoColors.successLight }]}>
                {threshold.signaturesCount}-of-{threshold.totalSigners} approved · threshold{' '}
                {threshold.threshold}
              </Text>
            </View>
            <View style={styles.signerPillWrap}>
              {threshold.signers.map((s) => (
                <SignerPill
                  key={s.signerPubkey}
                  region={s.region}
                  signerPubkey={s.signerPubkey}
                  signedAt={s.signedAt}
                  nowMs={nowMs}
                />
              ))}
            </View>
          </View>
        ) : (
          <Text style={styles.mutedMono}>threshold metadata not returned</Text>
        )}
      </LayerRow>

      {/* L11 */}
      <LayerRow
        layerKey="L11"
        title="Post-Quantum Crypto"
        accent={GojoColors.blueLight}
        icon="lock"
        description="Underlying Protocol 01 primitives are hash-based (Poseidon + Blake3 STARKs) — resistant to Shor-class quantum attacks on elliptic curves."
      >
        <View
          style={[
            styles.pqPill,
            {
              backgroundColor: 'rgba(96,165,250,0.1)',
              borderColor: 'rgba(96,165,250,0.3)',
            },
          ]}
        >
          <MaterialIcons name="check-circle" size={10} color={GojoColors.blueLight} />
          <Text style={[styles.pqPillText, { color: GojoColors.blueLight }]}>
            QUANTUM-SAFE PATH ACTIVE
          </Text>
        </View>
      </LayerRow>

      {/* Attack-surface callout */}
      <View style={styles.footerCallout}>
        <MaterialIcons
          name="verified-user"
          size={14}
          color={GojoColors.violetLight}
          style={{ marginTop: 2 }}
        />
        <Text style={styles.footerCalloutText}>
          To defeat this transaction, an attacker would need to simultaneously compromise{' '}
          <Text style={styles.footerBold}>Arcium MPC</Text>,{' '}
          <Text style={styles.footerBold}>2 of 3 geodistributed FROST signers</Text>,
          AND break{' '}
          <Text style={styles.footerBold}>post-quantum STARK commitments</Text>. Each
          layer failing alone leaks nothing.
        </Text>
      </View>

      {/* Claim-match card (take + match) */}
      {operation === 'take' && matched === true && matchedOrder && takerNoncePubkey ? (
        <ClaimCard
          matchedOrder={matchedOrder}
          takerNoncePubkey={takerNoncePubkey}
          fiatCurrency={fiatCurrency ?? matchedOrder.fiatCurrency}
          onClaim={onClaim}
          claimInFlight={claimInFlight}
          claimResult={claimResult}
        />
      ) : null}

      {/* Share receipt */}
      <View style={styles.shareRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={shared ? 'Receipt shared' : 'Share receipt as JSON'}
          onPress={onShareReceipt}
          style={({ pressed }) => [
            styles.shareBtn,
            {
              opacity: pressed ? 0.7 : 1,
              borderColor: shared ? GojoColors.borderSuccess : GojoColors.border,
              backgroundColor: shared
                ? 'rgba(34,197,94,0.1)'
                : 'rgba(139,92,246,0.08)',
            },
          ]}
        >
          <MaterialIcons
            name={shared ? 'check' : 'share'}
            size={11}
            color={shared ? GojoColors.successLight : GojoColors.violetLight}
          />
          <Text
            style={[
              styles.shareBtnText,
              { color: shared ? GojoColors.successLight : GojoColors.violetLight },
            ]}
          >
            {shared ? 'SHARED' : 'SHARE RECEIPT JSON'}
          </Text>
        </Pressable>
      </View>

      {/* Explorer open-link */}
      <Pressable
        accessibilityRole="link"
        onPress={() => {
          void Linking.openURL(
            `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`,
          );
        }}
        style={styles.explorerLink}
      >
        <MaterialIcons name="open-in-new" size={11} color={GojoColors.blueLight} />
        <Text style={styles.explorerLinkText}>Open in Solana Explorer</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: GojoColors.bg,
  },
  content: {
    padding: 14,
    gap: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.3)',
    backgroundColor: 'rgba(139,92,246,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
  },
  headerHeading: {
    color: GojoColors.white,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  headerSubheading: {
    color: '#a5b4fc',
    fontSize: 12,
    marginTop: 2,
  },
  layer: {
    flexDirection: 'row',
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  layerIcon: {
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  layerBody: {
    flex: 1,
    gap: 4,
  },
  layerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  layerTag: {
    fontFamily: Mono,
    fontSize: 10,
    letterSpacing: 1.5,
  },
  layerTitle: {
    color: GojoColors.white,
    fontSize: 13,
    fontWeight: '700',
  },
  layerDesc: {
    color: GojoColors.mutedLight,
    fontSize: 12,
    lineHeight: 17,
  },
  layerDetail: {
    marginTop: 4,
    gap: 6,
  },
  proofBadge: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  proofBadgeText: {
    fontFamily: Mono,
    fontSize: 9,
    letterSpacing: 1,
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  mono: {
    fontFamily: Mono,
    fontSize: 11,
    color: GojoColors.text,
  },
  monoLabel: {
    fontFamily: Mono,
    fontSize: 11,
    color: GojoColors.subtle,
  },
  mutedMono: {
    fontFamily: Mono,
    fontSize: 11,
    color: GojoColors.mutedLight,
  },
  signerPillWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  signerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.25)',
    backgroundColor: 'rgba(34,197,94,0.1)',
  },
  signerRegion: {
    fontFamily: Mono,
    fontSize: 9,
    color: GojoColors.successLight,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  signerKey: {
    fontFamily: Mono,
    fontSize: 9,
    color: '#a7f3d0',
  },
  signerTime: {
    fontFamily: Mono,
    fontSize: 9,
    color: '#6ee7b7',
    opacity: 0.8,
  },
  pqPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  pqPillText: {
    fontFamily: Mono,
    fontSize: 9,
    letterSpacing: 1,
  },
  footerCallout: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(139,92,246,0.3)',
    backgroundColor: 'rgba(139,92,246,0.08)',
  },
  footerCalloutText: {
    flex: 1,
    color: GojoColors.violetLight,
    fontSize: 12,
    lineHeight: 17,
  },
  footerBold: {
    color: GojoColors.white,
    fontWeight: '700',
  },
  claimCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(139,92,246,0.4)',
    backgroundColor: 'rgba(139,92,246,0.06)',
    padding: 14,
    gap: 8,
  },
  claimSuccessCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.4)',
    backgroundColor: 'rgba(34,197,94,0.08)',
    padding: 14,
    gap: 6,
  },
  claimHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  claimTitle: {
    color: GojoColors.white,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  claimSuccessTitle: {
    color: GojoColors.successLight,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  claimRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  claimRowLabel: {
    fontFamily: Mono,
    fontSize: 11,
    color: GojoColors.mutedLight,
    minWidth: 60,
  },
  claimRowValue: {
    fontFamily: Mono,
    fontSize: 11,
    color: GojoColors.text,
    flex: 1,
  },
  claimButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(139,92,246,0.45)',
    marginTop: 4,
  },
  claimButtonText: {
    color: GojoColors.violetLight,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  claimFallbackText: {
    fontFamily: Mono,
    fontSize: 10,
    color: GojoColors.errorLight,
    marginTop: 4,
  },
  shareRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
  },
  shareBtnText: {
    fontFamily: Mono,
    fontSize: 10,
    letterSpacing: 1,
  },
  explorerLink: {
    alignSelf: 'flex-end',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  explorerLinkText: {
    fontFamily: Mono,
    fontSize: 10,
    color: GojoColors.blueLight,
  },
});
