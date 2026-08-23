/**
 * Shield — the private balance, and everything you can do with it.
 *
 * 🎯 WHY THIS SCREEN CHANGED, AND WHAT IT REPLACES
 * ───────────────────────────────────────────────
 * This was a dashboard that pointed at other screens. The tab named after an
 * action did not perform it: the Deposit tile opened a picker, the picker
 * opened a confirm sheet, the sheet opened a success card with a Done button.
 * Four surfaces to create one note.
 *
 * The picker is inline here now, exactly as it is on the Chrome extension's
 * Shield page. Tab, denomination, one press.
 *
 * ⚠️ THE PRESS STILL LANDS ON `denominated-shield`, DELIBERATELY. That screen
 * carries the one disclosure that may never be collapsed away — who signs the
 * deposit, which differs between SOL (a one-time key) and USDC (your wallet) —
 * and `app/privacy-claims.test.ts` pins it there, per token, on purpose. So the
 * choice is made here and the screen that states the consequence executes it.
 * It is no longer a picker pointing at a picker; the denomination arrives
 * already chosen and that screen has exactly one button.
 *
 * 🚨 AND IT NAMES THE PATH THE PRODUCT IS ABOUT. A shielded note is not the
 * point; subscribing with one is. Nothing on this screen used to say so — a
 * note sat in a collapsed list with a chevron. Every mature note now carries
 * "Subscribe with this note", on the object it applies to.
 *
 * ⚠️ THE WAIT IS PROTOCOL-LEVEL AND THIS SCREEN SAYS SO, from the moment the
 * note exists. The old list said "Maturing..." and left the user to discover
 * the length of it as a greyed-out button on another screen.
 *
 * ⛔ LEGACY V1 IS SHOWN AND NEVER SUMMED. It sits in its own row, outside the
 * headline, labelled with what it is.
 *
 * ⛔ REMOVED, and why:
 *   - the "Protection" badge pair ("On-device proofs", "Encrypted"). Two pills
 *     that carried no decision, spending the one accent colour the system has
 *     on decoration. The measured sentence underneath them survives, because
 *     it is the honest half.
 *   - the Private Send feature card, NEW badge and all. Personal payments are
 *     parked (founder, 2026-08-23) and the privacy router is a personal
 *     payment. The route stays registered; it is simply not a destination from
 *     the Shield tab any more, the same way the Agent tab was retired.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { RelayerHealthDot } from '@/components/RelayerHealthDot';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { useShieldedStore } from '@/stores/shieldedStore';
import { useConfidentialStore } from '@/stores/confidentialStore';
import { useDenominatedPoolStore, type StoredNote } from '@/stores/denominatedPoolStore';
import { useSubscriptionVaultStore } from '@/stores/subscriptionVaultStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { Button } from '@/components/ui/Button';
import {
  Colors,
  FontFamily,
  FontSize,
  Spacing,
  BorderRadius,
  Layout,
} from '@/constants/theme';
import { useT } from '@/i18n';

/** The denominations a person is plausibly depositing today. */
const DENOMINATIONS = [0.1, 1, 10] as const;

/**
 * ⚠️ Only the 1 SOL pool takes new deposits. Founder decision 2026-08-21: one
 * denomination, because a crowd does not add across pools, it splits. The
 * others are shown and refused WITH the reason rather than hidden — a
 * denomination that simply vanishes reads as a bug to someone holding a note
 * in it.
 */
const OPEN_DENOMINATION = 1;

/**
 * The maturity estimate, and it is an ESTIMATE — the label says so.
 *
 * These are the same constants `denominated-notes.tsx` computes with: the
 * pool's own epoch is 7200 slots (services/denominatedPool/index.ts:78), the
 * store's fallback delay is `epochDelay 1 + dynamicDelay 2`, and a slot is
 * ~500ms. The real per-pool delay is read from `poolCache` when the pool has
 * been fetched; the fallback only fills in before that.
 *
 * ⚠️ `note.status` stays the truth. This clock decides what the countdown
 * READS, never whether a note is spendable — that is the store's call, made
 * against the chain.
 */
const SLOTS_PER_EPOCH = 7200;
const SLOT_MS = 500;
const FALLBACK_DELAY_EPOCHS = 3;

function fmtLeft(ms: number): string {
  const mins = Math.ceil(ms / 60_000);
  if (mins <= 1) return 'under a minute';
  if (mins < 60) return `~${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest > 0 ? `~${hrs}h ${rest}m` : `~${hrs}h`;
}

export default function PrivacyDashboard() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [denomination, setDenomination] = useState<number>(OPEN_DENOMINATION);
  const [now, setNow] = useState(() => Date.now());

  const { shieldedBalance, notes } = useShieldedStore();
  const { balances: confidentialBalances, pendingCredits } = useConfidentialStore();
  const {
    getActiveNotes,
    poolCache,
    isLoading: denomLoading,
    progress: denomProgress,
    isProving,
    refreshAllPools,
    resetOperationState: resetDenomOp,
  } = useDenominatedPoolStore();
  const {
    isLoading: subLoading,
    progress: subProgress,
    resetOperationState: resetSubOp,
  } = useSubscriptionVaultStore();

  const isLoading = denomLoading || subLoading;
  const progress = denomProgress ?? subProgress;
  const resetAnyStuckOp = useCallback(() => {
    resetDenomOp();
    resetSubOp();
  }, [resetDenomOp, resetSubOp]);
  const { initialize: initSettings } = useSettingsStore();

  useEffect(() => { initSettings(); }, []);

  // One minute is the resolution a countdown in hours needs; anything faster
  // re-renders the whole list to move nothing a user can see.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // ─── Computed values ──────────────────────────────────────
  const activeNotes = getActiveNotes();
  const matureNotes = activeNotes.filter(n => n.status === 'mature');
  const pendingNotes = activeNotes.filter(n => n.status !== 'mature');
  const privateBalance = activeNotes.reduce((sum, n) => sum + n.denomination, 0);

  const readyIn = useCallback(
    (note: StoredNote): string | null => {
      const cached = poolCache[note.poolPDA];
      const epochs = cached
        ? Number(cached.info.epochDelay) + cached.info.dynamicDelay
        : FALLBACK_DELAY_EPOCHS;
      const left = note.shieldedAt + epochs * SLOTS_PER_EPOCH * SLOT_MS - now;
      return left > 0 ? fmtLeft(left) : null;
    },
    [poolCache, now],
  );

  // Legacy funds detection. V1 money is real and it is NOT part of the
  // headline: the two were summed into one "Shielded Balance" once, and the
  // total was presented as spendable when half of it has no exit.
  const confidentialSolBalance = (confidentialBalances['11111111111111111111111111111111'] || 0) / 1e9;
  const pendingCount = pendingCredits['11111111111111111111111111111111'] || 0;
  const hasShieldedFunds = shieldedBalance > 0 || notes.filter(n => Number(n.amount) > 0).length > 0;
  const hasConfidentialFunds = confidentialSolBalance > 0 || pendingCount > 0;
  const hasLegacyFunds = hasShieldedFunds || hasConfidentialFunds;

  const onRefresh = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await refreshAllPools?.().catch(() => {});
  }, [refreshAllPools]);

  const closed = denomination !== OPEN_DENOMINATION;

  const balanceLabel = useMemo(
    () => (privateBalance < 1 ? privateBalance.toFixed(4) : privateBalance.toFixed(2)),
    [privateBalance],
  );

  return (
    <SafeAreaView style={s.screen} edges={['top']}>
      {/* ─── Header ──────────────────────────────────────── */}
      <View style={s.header}>
        <Text style={s.headerTitle} accessibilityRole="header">
          {t('privacy.shield')}
        </Text>
        <View style={s.headerRight}>
          <RelayerHealthDot />
          <TouchableOpacity
            style={s.headerBtn}
            onPress={() => router.push('/(main)/(settings)')}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            <Ionicons name="settings-outline" size={20} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {isLoading && progress && (
        <View style={s.progressBanner}>
          <View style={s.progressDot} />
          <Text style={s.progressText} numberOfLines={2}>
            {isProving ? `${progress} (proving)` : progress}
          </Text>
          <TouchableOpacity
            style={s.progressCancel}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              resetAnyStuckOp();
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel stuck operation"
          >
            <Ionicons name="close" size={18} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[
          s.scrollContent,
          { paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing['2xl'] },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={onRefresh} tintColor={Colors.primary} />
        }
      >
        {/* ─── 1. The headline. V1 is deliberately not in this number. ── */}
        <View style={s.hero}>
          <Text style={s.heroLabel}>Private balance</Text>
          <View style={s.heroRow}>
            <Text style={s.heroValue}>{balanceLabel}</Text>
            <Text style={s.heroUnit}>SOL</Text>
          </View>
          {activeNotes.length > 0 ? (
            <Text style={s.heroMeta}>
              {matureNotes.length} ready to spend
              {pendingNotes.length > 0 ? `, ${pendingNotes.length} still maturing` : ''}
            </Text>
          ) : null}
        </View>

        {/* ─── 2. Shield, inline. This is the old picker screen, merged. ── */}
        <View style={s.panel}>
          <Text style={s.panelLabel}>Add to it</Text>

          <View style={s.chips}>
            {DENOMINATIONS.map((d) => {
              const isOpen = d === OPEN_DENOMINATION;
              const selected = denomination === d;
              return (
                <TouchableOpacity
                  key={d}
                  style={[s.chip, selected && s.chipSelected]}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setDenomination(d);
                  }}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${d} SOL${isOpen ? '' : ', closed to new deposits'}`}
                >
                  <Text style={[s.chipAmount, selected && s.chipAmountSelected]}>{d} SOL</Text>
                  {!isOpen && <Text style={s.chipNote}>closed</Text>}
                </TouchableOpacity>
              );
            })}
          </View>

          {closed ? (
            /* Refused with the reason, not hidden. */
            <Text style={s.chipRefusal}>
              This pool is closed to new deposits. Every deposit lands in the 1 SOL pool so the
              crowd stays in one place instead of splitting across six. Notes you already hold
              here stay spendable.
            </Text>
          ) : (
            <Text style={s.panelHint}>
              One press deposits {OPEN_DENOMINATION} SOL plus network fees. The next screen says
              who signs it before anything is sent.
            </Text>
          )}

          <Button
            variant="primary"
            size="lg"
            fullWidth
            disabled={closed}
            style={s.panelAction}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              router.push({
                pathname: '/(main)/(privacy)/denominated-shield' as any,
                params: { denomination: String(denomination) },
              });
            }}
            accessibilityLabel={`Shield ${denomination} SOL`}
          >
            {`Shield ${denomination} SOL`}
          </Button>
        </View>

        {/* ─── 3. What else you can do with a private balance ── */}
        <Text style={s.sectionTitle}>Move it</Text>
        <View style={s.actions}>
          {[
            {
              key: 'withdraw',
              label: t('privacy.withdraw'),
              icon: 'arrow-up-outline' as const,
              route: '/(main)/(privacy)/denominated-unshield',
              disabled: matureNotes.length === 0,
            },
            {
              key: 'send',
              label: t('common.send'),
              icon: 'paper-plane-outline' as const,
              route: '/(main)/(privacy)/denominated-transfer',
              disabled: matureNotes.length === 0,
            },
            {
              key: 'receive',
              label: t('common.receive'),
              icon: 'download-outline' as const,
              route: '/(main)/(privacy)/receive-note',
              disabled: false,
            },
            {
              key: 'all',
              label: t('privacy.myNotes'),
              icon: 'file-tray-full-outline' as const,
              route: '/(main)/(privacy)/denominated-notes',
              disabled: false,
            },
          ].map((a) => (
            <TouchableOpacity
              key={a.key}
              style={[s.action, a.disabled && s.actionDisabled]}
              disabled={a.disabled}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push(a.route as any);
              }}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              accessibilityState={{ disabled: a.disabled }}
            >
              <Ionicons name={a.icon} size={20} color={Colors.primary} />
              {/* Icon plus LABEL, never icon alone: an unlabelled icon in a
                  wallet is a guess about someone's money. */}
              <Text style={s.actionLabel} numberOfLines={1}>{a.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ─── 4. The notes, each carrying its own next step ── */}
        <Text style={s.sectionTitle}>{t('privacy.myNotes')}</Text>

        {activeNotes.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyTitle}>{t('privacy.noNotes')}</Text>
            <Text style={s.emptyBody}>
              Shield {OPEN_DENOMINATION} SOL above. A note is what lets you subscribe to a
              merchant without your wallet signing for it.
            </Text>
          </View>
        ) : (
          <View style={s.notes}>
            {activeNotes.slice(0, 6).map((note, i) => {
              const ready = note.status === 'mature';
              const left = ready ? null : readyIn(note);
              return (
                <View key={note.id} style={[s.note, i > 0 && s.noteDivided]}>
                  <View style={s.noteHead}>
                    {/* Amount and state. Never a leaf index: a person does not
                        hold "leaf #12", they hold 1 SOL. */}
                    <Text style={s.noteAmount}>
                      {note.denomination} {note.token}
                    </Text>
                    <View style={[s.pill, ready ? s.pillGood : s.pillWarn]}>
                      <Text style={[s.pillText, ready ? s.pillTextGood : s.pillTextWarn]}>
                        {ready ? t('common.ready') : (left ?? t('privacy.maturing'))}
                      </Text>
                    </View>
                  </View>

                  {ready ? (
                    <>
                      {note.source === 'received' && (
                        <Text style={s.noteReason}>Received from someone else.</Text>
                      )}
                      {/* 🎯 THE PATH. On the note, not in a footnote. */}
                      <Button
                        variant="primary"
                        size="sm"
                        fullWidth
                        style={s.noteAction}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          router.push({
                            pathname: '/(main)/(privacy)/subscribe-private' as any,
                            params: { noteId: note.id },
                          });
                        }}
                        accessibilityLabel={`Subscribe with this ${note.denomination} ${note.token} note`}
                      >
                        Subscribe with this note
                      </Button>
                    </>
                  ) : (
                    /* The countdown is in the pill; the reason is here. The
                       wait is on chain, and the old copy ("Maturing...") let
                       the user read it as a spinner that was taking its time. */
                    <Text style={s.noteReason}>
                      A fresh note waits out the pool's delay before it can be spent. The chain
                      enforces that, so no screen can shorten it.
                    </Text>
                  )}
                </View>
              );
            })}

            {activeNotes.length > 6 && (
              <TouchableOpacity
                style={s.notesMore}
                onPress={() => router.push('/(main)/(privacy)/denominated-notes' as any)}
                accessibilityRole="button"
                accessibilityLabel={t('privacy.viewAllNotes')}
              >
                <Text style={s.notesMoreText}>
                  {t('privacy.viewAllNotes')} ({activeNotes.length})
                </Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.primary} />
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ─── 5. Legacy funds. Shown, named, never summed above. ── */}
        {hasLegacyFunds && (
          <View style={s.legacy}>
            <View style={s.legacyMain}>
              <Text style={s.legacyTitle}>Money in the retired V1 modules</Text>
              <Text style={s.legacyBody}>
                {hasShieldedFunds && `${shieldedBalance.toFixed(4)} SOL in the shielded wallet`}
                {hasShieldedFunds && hasConfidentialFunds && ' · '}
                {hasConfidentialFunds && `${confidentialSolBalance.toFixed(4)} SOL in confidential balance`}
                . It is not part of the balance above.
              </Text>
            </View>
            <Button
              variant="secondary"
              size="sm"
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push(
                  hasShieldedFunds
                    ? '/(main)/(privacy)/shielded'
                    : '/(main)/(privacy)/confidential',
                );
              }}
              accessibilityLabel="Withdraw legacy funds"
            >
              {t('privacy.withdraw')}
            </Button>
          </View>
        )}

        {/*
          'No private data ever leaves your device' was false as written. The
          proof is uploaded to the chain along with its public inputs, and
          `publicInputs[1]` of the C1 proof IS the note commitment
          (services/denominatedPool/index.ts:3192) — the same value the deposit
          published, which is why a deposit and its withdrawal can be matched.
          What is true is the narrower claim: no secret is sent to a server,
          because the witness never leaves the phone.
        */}
        <Text style={s.footnote}>
          Proofs are generated on your phone, so your note's secrets are never sent to a server.
          The proof itself goes on chain and carries the same note commitment your deposit
          published, so a deposit and its withdrawal can still be matched.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────
const s = StyleSheet.create({
  // Transparent on purpose: the tab layout paints Colors.background once,
  // behind every tab. See app/(main)/(privacy)/_layout.tsx.
  screen: { flex: 1, backgroundColor: 'transparent' },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  headerTitle: {
    color: Colors.text,
    fontSize: FontSize['2xl'],
    fontFamily: FontFamily.display,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  headerBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Progress banner (deposit / withdraw / subscribe in flight)
  progressBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.xl,
    marginBottom: Spacing.md,
    paddingLeft: Spacing.lg,
    paddingRight: Spacing.xs,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primaryDim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.primaryMuted,
  },
  progressDot: {
    width: 6,
    height: 6,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.primary,
  },
  progressText: {
    flex: 1,
    color: Colors.text,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },
  progressCancel: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Scroll
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl },

  // 1. Headline
  hero: { marginTop: Spacing.sm, marginBottom: Spacing['3xl'] },
  heroLabel: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  heroValue: {
    fontSize: FontSize['4xl'],
    fontFamily: FontFamily.display,
    color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  heroUnit: {
    fontSize: FontSize.lg,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  heroMeta: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: Spacing.sm,
  },

  // 2. Deposit panel
  panel: {
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    padding: Spacing.lg,
    marginBottom: Spacing['3xl'],
  },
  panelLabel: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  chips: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  chip: {
    flex: 1,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  chipSelected: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryDim,
  },
  chipAmount: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  chipAmountSelected: { color: Colors.text },
  chipNote: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  chipRefusal: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.yellow,
    lineHeight: 19,
    marginTop: Spacing.md,
  },
  panelHint: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 19,
    marginTop: Spacing.md,
  },
  panelAction: { marginTop: Spacing.lg },

  // 3. Move it
  sectionTitle: {
    fontSize: FontSize.lg,
    fontFamily: FontFamily.displayMedium,
    color: Colors.text,
    marginBottom: Spacing.md,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing['3xl'],
  },
  action: {
    flex: 1,
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.xs,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  actionDisabled: { opacity: 0.4 },
  actionLabel: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },

  // 4. Notes
  notes: { marginBottom: Spacing['3xl'] },
  note: { paddingVertical: Spacing.lg },
  noteDivided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSoft,
  },
  noteAction: { marginTop: Spacing.md },
  noteHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  noteAmount: {
    fontSize: FontSize.lg,
    fontFamily: FontFamily.displayMedium,
    color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  pill: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: BorderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillGood: { borderColor: Colors.primaryMuted, backgroundColor: Colors.primaryDim },
  pillWarn: { borderColor: Colors.yellow, backgroundColor: Colors.warningDim },
  pillText: { fontSize: FontSize.xs, fontFamily: FontFamily.medium },
  pillTextGood: { color: Colors.primary },
  pillTextWarn: { color: Colors.yellow },
  noteReason: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 16,
    marginTop: Spacing.xs,
  },
  notesMore: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    minHeight: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSoft,
  },
  notesMoreText: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
    color: Colors.primary,
  },

  // Empty
  empty: {
    paddingVertical: Spacing['4xl'],
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing['3xl'],
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: FontSize.xl,
    fontFamily: FontFamily.display,
    color: Colors.text,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 21,
    marginTop: Spacing.sm,
    maxWidth: 300,
  },

  // 5. Legacy
  legacy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
    marginBottom: Spacing['3xl'],
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.yellow,
    backgroundColor: Colors.warningDim,
  },
  legacyMain: { flex: 1, minWidth: 0 },
  legacyTitle: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.medium,
    color: Colors.text,
  },
  legacyBody: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 16,
    marginTop: 2,
  },

  footnote: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 17,
  },
});
