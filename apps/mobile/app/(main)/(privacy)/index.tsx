import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { useShieldedStore } from '@/stores/shieldedStore';
import { useConfidentialStore } from '@/stores/confidentialStore';
import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useArcium } from '@/providers/ArciumProvider';
import { useArciumStore } from '@/stores/arciumStore';
import { Colors, FontFamily, Spacing, P01Colors } from '@/constants/theme';
import { useT } from '@/i18n';

// ─── Human-readable action buttons ─────────────────────────────
const ACTION_CONFIGS = [
  { key: 'deposit', i18nKey: 'privacy.deposit', icon: 'arrow-down-circle' as const, route: '/(main)/(privacy)/denominated-shield', color: P01Colors.cyan, bg: P01Colors.cyanDim },
  { key: 'withdraw', i18nKey: 'privacy.withdraw', icon: 'arrow-up-circle' as const, route: '/(main)/(privacy)/denominated-unshield', color: P01Colors.pink, bg: P01Colors.pinkDim },
  { key: 'send', i18nKey: 'common.send', icon: 'paper-plane' as const, route: '/(main)/(privacy)/denominated-transfer', color: '#8B8BFF', bg: 'rgba(139, 139, 255, 0.12)' },
  { key: 'receive', i18nKey: 'common.receive', icon: 'download' as const, route: '/(main)/(privacy)/receive-note', color: '#8B8BFF', bg: 'rgba(139, 139, 255, 0.12)' },
] as const;

// ─── Protection indicators (simple, no jargon) ─────────────────
function ProtectionBadge({ icon, label, active }: { icon: string; label: string; active: boolean }) {
  return (
    <View style={[s.badge, active && s.badgeActive]}>
      <Ionicons name={icon as any} size={12} color={active ? P01Colors.cyan : Colors.textTertiary} />
      <Text style={[s.badgeLabel, active && s.badgeLabelActive]}>{label}</Text>
    </View>
  );
}

export default function PrivacyDashboard() {
  const t = useT();
  const router = useRouter();
  const [notesExpanded, setNotesExpanded] = useState(false);

  const { shieldedBalance, notes } = useShieldedStore();
  const {
    balances: confidentialBalances,
    pendingCredits,
  } = useConfidentialStore();
  const { notes: denomNotes, getActiveNotes, isLoading, refreshAllPools } = useDenominatedPoolStore();
  const {
    shieldedWalletEnabled,
    confidentialBalanceEnabled,
    initialize: initSettings,
  } = useSettingsStore();
  const { isMpcActive } = useArcium();
  const { } = useArciumStore();

  useEffect(() => { initSettings(); }, []);

  // ─── Computed values ──────────────────────────────────────
  const activeNotes = getActiveNotes();
  const matureNotes = activeNotes.filter(n => n.status === 'mature');
  const pendingNotes = activeNotes.filter(n => n.status === 'pending');
  const privateBalance = activeNotes.reduce((sum, n) => sum + n.denomination, 0);
  const matureBalance = matureNotes.reduce((sum, n) => sum + n.denomination, 0);

  // Legacy funds detection
  const confidentialSolBalance = (confidentialBalances['11111111111111111111111111111111'] || 0) / 1e9;
  const pendingCount = pendingCredits['11111111111111111111111111111111'] || 0;
  const hasShieldedFunds = shieldedBalance > 0 || notes.filter(n => Number(n.amount) > 0).length > 0;
  const hasConfidentialFunds = confidentialSolBalance > 0 || pendingCount > 0;
  const hasLegacyFunds = hasShieldedFunds || hasConfidentialFunds;

  const onRefresh = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await refreshAllPools?.().catch(() => {});
  }, [refreshAllPools]);

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      {/* ─── Header ──────────────────────────────────────── */}
      <View style={s.header}>
        <Text style={s.headerTitle} accessibilityRole="header">{t('privacy.title')}</Text>
        <TouchableOpacity
          style={s.headerBtn}
          onPress={() => router.push('/(main)/(settings)')}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
          <Ionicons name="settings-outline" size={20} color={Colors.text} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={onRefresh} tintColor={Colors.primary} />
        }
      >
        {/* ─── 1. HERO: Private Balance ────────────────── */}
        <Animated.View entering={FadeIn.duration(400)}>
          <View style={s.heroCard}>
            <View style={s.heroTop}>
              <View style={s.heroIconWrap}>
                <Ionicons name="shield-checkmark" size={22} color={P01Colors.cyan} />
              </View>
              <Text style={s.heroLabel}>{t('privacy.shieldedBalance')}</Text>
            </View>

            <Text style={s.heroBalance}>
              {privateBalance < 1
                ? privateBalance.toFixed(4)
                : privateBalance.toFixed(2)}{' '}
              <Text style={s.heroUnit}>SOL</Text>
            </Text>

            {activeNotes.length > 0 && (
              <View style={s.heroMeta}>
                {matureNotes.length > 0 && (
                  <View style={s.heroChip}>
                    <View style={[s.heroDot, { backgroundColor: P01Colors.cyan }]} />
                    <Text style={s.heroChipText}>
                      {matureNotes.length} ready
                    </Text>
                  </View>
                )}
                {pendingNotes.length > 0 && (
                  <View style={s.heroChip}>
                    <View style={[s.heroDot, { backgroundColor: P01Colors.yellow }]} />
                    <Text style={s.heroChipText}>
                      {pendingNotes.length} maturing
                    </Text>
                  </View>
                )}
              </View>
            )}

            {activeNotes.length === 0 && (
              <Text style={s.heroEmpty}>
                {t('privacy.noNotesDesc')}
              </Text>
            )}
          </View>
        </Animated.View>

        {/* ─── 2. QUICK ACTIONS ────────────────────────── */}
        <Animated.View entering={FadeInDown.delay(100).duration(300)}>
          <View style={s.actionsGrid}>
            {ACTION_CONFIGS.map((action) => (
              <TouchableOpacity
                key={action.key}
                style={[s.actionBtn, { backgroundColor: action.bg }]}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  router.push(action.route as any);
                }}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={t(action.i18nKey)}
              >
                <Ionicons name={action.icon} size={24} color={action.color} />
                <Text style={[s.actionLabel, { color: action.color }]}>
                  {t(action.i18nKey)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Animated.View>

        {/* ─── 3. PRIVACY ROUTER (feature card) ────────── */}
        <Animated.View entering={FadeInDown.delay(200).duration(300)}>
          <TouchableOpacity
            style={s.featureCard}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push('/(main)/(privacy)/private-send' as any);
            }}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Private Send"
          >
            <View style={s.featureLeft}>
              <View style={s.featureIcon}>
                <Ionicons name="git-branch-outline" size={20} color={P01Colors.cyan} />
              </View>
              <View style={s.featureInfo}>
                <View style={s.featureTitleRow}>
                  <Text style={s.featureTitle}>{t('privacy.privateSend')}</Text>
                  <View style={s.newBadge}>
                    <Text style={s.newBadgeText}>NEW</Text>
                  </View>
                </View>
                <Text style={s.featureDesc}>
                  Route through multiple wallets with time delays
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
          </TouchableOpacity>
        </Animated.View>

        {/* ─── 4. YOUR NOTES (collapsible) ─────────────── */}
        {activeNotes.length > 0 && (
          <Animated.View entering={FadeInDown.delay(300).duration(300)}>
            <TouchableOpacity
              style={s.notesHeader}
              onPress={() => {
                Haptics.selectionAsync();
                setNotesExpanded(!notesExpanded);
              }}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={`Your notes, ${activeNotes.length} total`}
            >
              <Text style={s.sectionTitle}>{t('privacy.myNotes')}</Text>
              <View style={s.notesHeaderRight}>
                <Text style={s.notesCount}>{activeNotes.length}</Text>
                <Ionicons
                  name={notesExpanded ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={Colors.textTertiary}
                />
              </View>
            </TouchableOpacity>

            {notesExpanded && (
              <View style={s.notesList}>
                {activeNotes.slice(0, 8).map((note, i) => (
                  <View key={note.id} style={s.noteRow}>
                    <View style={[
                      s.noteStatus,
                      { backgroundColor: note.status === 'mature' ? P01Colors.cyanDim : P01Colors.yellowDim },
                    ]}>
                      <Ionicons
                        name={note.status === 'mature' ? 'checkmark-circle' : 'time'}
                        size={14}
                        color={note.status === 'mature' ? P01Colors.cyan : P01Colors.yellow}
                      />
                    </View>
                    <View style={s.noteInfo}>
                      <Text style={s.noteAmount}>{note.denomination} SOL</Text>
                      <Text style={s.noteStatusText}>
                        {note.status === 'mature' ? 'Ready to use' : 'Maturing...'}
                      </Text>
                    </View>
                  </View>
                ))}
                {activeNotes.length > 8 && (
                  <Text style={s.notesMore}>+{activeNotes.length - 8} more</Text>
                )}
                <TouchableOpacity
                  style={s.notesViewAll}
                  onPress={() => router.push('/(main)/(privacy)/denominated-notes' as any)}
                  accessibilityRole="button"
                  accessibilityLabel="View all notes"
                >
                  <Text style={s.notesViewAllText}>{t('privacy.viewAllNotes')}</Text>
                  <Ionicons name="chevron-forward" size={14} color={P01Colors.cyan} />
                </TouchableOpacity>
              </View>
            )}
          </Animated.View>
        )}

        {/* ─── 5. PROTECTION STATUS ────────────────────── */}
        <Animated.View entering={FadeInDown.delay(400).duration(300)}>
          <Text style={[s.sectionTitle, { marginBottom: 10 }]}>Protection</Text>
          <View style={s.badgesRow}>
            <ProtectionBadge icon="hardware-chip" label="On-device proofs" active />
            <ProtectionBadge icon="lock-closed" label="Encrypted" active />
            <ProtectionBadge icon="people" label="MPC" active={isMpcActive} />
          </View>
          <Text style={s.protectionHint}>
            All proofs are generated on your phone. No private data ever leaves your device.
          </Text>
        </Animated.View>

        {/* ─── 6. LEGACY FUNDS WARNING ─────────────────── */}
        {hasLegacyFunds && (
          <Animated.View entering={FadeInDown.delay(500).duration(300)}>
            <View style={s.legacyCard}>
              <Ionicons name="alert-circle" size={18} color={P01Colors.yellow} />
              <View style={s.legacyInfo}>
                <Text style={s.legacyTitle}>Legacy funds detected</Text>
                <Text style={s.legacyDesc}>
                  {hasShieldedFunds && `${shieldedBalance.toFixed(4)} SOL in Shielded Wallet`}
                  {hasShieldedFunds && hasConfidentialFunds && ' · '}
                  {hasConfidentialFunds && `${confidentialSolBalance.toFixed(4)} SOL in Confidential Balance`}
                </Text>
              </View>
              <TouchableOpacity
                style={s.legacyBtn}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  if (hasShieldedFunds) {
                    router.push('/(main)/(privacy)/shielded');
                  } else {
                    router.push('/(main)/(privacy)/confidential');
                  }
                }}
                accessibilityRole="button"
                accessibilityLabel="Withdraw legacy funds"
              >
                <Text style={s.legacyBtnText}>Withdraw</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 24,
    fontFamily: FontFamily.bold,
  },
  headerBtn: {
    width: 40,
    height: 40,
    borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Scroll
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 120,
  },

  // 1. Hero
  heroCard: {
    backgroundColor: '#0f0f12',
    borderRadius: 24,
    padding: 24,
    marginBottom: Spacing.lg,
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  heroIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: P01Colors.cyanDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroLabel: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  heroBalance: {
    fontSize: 40,
    fontFamily: FontFamily.bold,
    color: Colors.text,
    letterSpacing: -1,
  },
  heroUnit: {
    fontSize: 20,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  heroMeta: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 12,
  },
  heroChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  heroDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  heroChipText: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  heroEmpty: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 8,
  },

  // 2. Actions
  actionsGrid: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: Spacing.lg,
  },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 16,
    borderRadius: 16,
  },
  actionLabel: {
    fontSize: 12,
    fontFamily: FontFamily.semibold,
  },

  // 3. Feature card
  featureCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f0f12',
    borderRadius: 16,
    padding: 16,
    marginBottom: Spacing.lg,
  },
  featureLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  featureIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: P01Colors.cyanDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureInfo: { flex: 1 },
  featureTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  featureTitle: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  featureDesc: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  newBadge: {
    backgroundColor: P01Colors.cyanDim,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  newBadgeText: {
    color: P01Colors.cyan,
    fontSize: 9,
    fontFamily: FontFamily.bold,
  },

  // 4. Notes
  sectionTitle: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
    marginBottom: 4,
  },
  notesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    marginBottom: 4,
  },
  notesHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  notesCount: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
    backgroundColor: Colors.surfaceSecondary,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    overflow: 'hidden',
  },
  notesList: {
    backgroundColor: '#0f0f12',
    borderRadius: 16,
    padding: 12,
    marginBottom: Spacing.lg,
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  noteStatus: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteInfo: { flex: 1 },
  noteAmount: {
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  noteStatusText: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginTop: 1,
  },
  notesMore: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    paddingVertical: 6,
  },
  notesViewAll: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingTop: 10,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.04)',
  },
  notesViewAllText: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: P01Colors.cyan,
  },

  // 5. Protection
  badgesRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#0f0f12',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  badgeActive: {
    backgroundColor: P01Colors.cyanDim,
  },
  badgeLabel: {
    fontSize: 11,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
  },
  badgeLabelActive: {
    color: P01Colors.cyan,
  },
  protectionHint: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 17,
    marginBottom: Spacing.lg,
  },

  // 6. Legacy
  legacyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: P01Colors.yellowDim,
    borderRadius: 14,
    padding: 14,
    marginBottom: Spacing.lg,
  },
  legacyInfo: { flex: 1 },
  legacyTitle: {
    fontSize: 13,
    fontFamily: FontFamily.semibold,
    color: P01Colors.yellow,
  },
  legacyDesc: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  legacyBtn: {
    backgroundColor: 'rgba(255, 204, 0, 0.2)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  legacyBtnText: {
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    color: P01Colors.yellow,
  },
});
