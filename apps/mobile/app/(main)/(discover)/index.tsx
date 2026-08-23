/**
 * Discover: the merchants you can subscribe to, privately.
 *
 * 🎯 WHY THIS REPLACED THE AGENT TAB
 * ──────────────────────────────────
 * The fourth tab was an on-device AI assistant. Founder ruling 2026-08-23:
 * nobody was going to use it, and a tab is the most expensive space in the app.
 * What a tab has to earn is a reason to open the wallet when you are not
 * already sending money, and a chat box is not that.
 *
 * This is. It reads the on-chain service registry through the hook that already
 * exists (`useServiceRegistry`, backed by `p01_registry`, one of the ten
 * programs live on devnet), and turns an empty wallet into a place with
 * something to do. It is also the only screen that answers, without a paragraph
 * of explanation, the question the product exists for: what can I pay for
 * without handing over a name?
 *
 * ⛔ IT IS NOT A MARKETPLACE. It does not rank, promote, or take a cut of
 * placement. It lists what the registry contains, in the order the chain
 * returns it, and shows `verified` because it is a field on the account, not
 * because we conferred it. A directory that quietly sorts by who paid is what
 * every app store became; it would be a strange first move for a privacy
 * protocol.
 *
 * ⚠️ Mirrors apps/extension/src/popup/pages/Discover.tsx deliberately. The two
 * surfaces should not disagree about what a merchant listing looks like.
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  useServiceRegistry,
  formatInterval,
  formatPriceSOL,
  iconKeyToIonicons,
  type ServiceEntry,
} from '../../../services/solana/serviceRegistry';
import {
  Colors,
  Spacing,
  FontFamily,
  FontSize,
  BorderRadius,
  Layout,
} from '../../../constants/theme';

export default function DiscoverScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { services, loading, refreshing, error, refresh } = useServiceRegistry();
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    // Inactive entries are merchants who switched themselves off. Listing one
    // sends somebody into a subscribe flow that cannot complete.
    const live = services.filter((s) => s.active);
    const q = query.trim().toLowerCase();
    if (!q) return live;
    return live.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q),
    );
  }, [services, query]);

  const openMerchant = (s: ServiceEntry) => {
    router.push({
      pathname: '/(main)/(streams)/subscribe',
      params: { service: s.pda.toBase58() },
    });
  };

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.md }]}>
        <Text style={styles.title}>Discover</Text>
        <Pressable
          onPress={() => void refresh()}
          disabled={refreshing}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Refresh the merchant list"
          style={styles.iconButton}
        >
          <Ionicons
            name="refresh"
            size={20}
            color={refreshing ? Colors.textTertiary : Colors.textSecondary}
          />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.body,
          { paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing.xl },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={Colors.primary}
          />
        }
      >
        <Text style={styles.lede}>
          Subscribe without an account. The merchant is paid on a schedule and never receives a
          name, an email or a card number.
        </Text>

        {services.length > 3 && (
          <View style={styles.searchRow}>
            <Ionicons name="search" size={16} color={Colors.textTertiary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search merchants"
              placeholderTextColor={Colors.textTertiary}
              accessibilityLabel="Search merchants"
              style={styles.searchInput}
            />
          </View>
        )}

        {loading && services.length === 0 && (
          <View style={styles.centered}>
            <ActivityIndicator color={Colors.primary} />
          </View>
        )}

        {/* 🚨 An unreachable registry and an empty one look identical on screen
            and need opposite reactions: retry, or go register a merchant. */}
        {error && (
          <View style={styles.warnPanel}>
            <Text style={styles.warnTitle}>The registry could not be read.</Text>
            <Text style={styles.warnBody}>{error}</Text>
            <Pressable
              onPress={() => void refresh()}
              accessibilityRole="button"
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Try again</Text>
            </Pressable>
          </View>
        )}

        {!loading && !error && shown.length === 0 && (
          <View style={styles.empty}>
            <Ionicons name="compass-outline" size={24} color={Colors.textTertiary} />
            <Text style={styles.emptyTitle}>{query ? 'No match' : 'No merchants yet'}</Text>
            <Text style={styles.emptyBody}>
              {query
                ? 'Nothing in the registry matches that.'
                : 'The registry on this network has no active merchant. Anyone can register one.'}
            </Text>
            {query.length > 0 && (
              <Pressable
                onPress={() => setQuery('')}
                accessibilityRole="button"
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>Clear search</Text>
              </Pressable>
            )}
          </View>
        )}

        {shown.map((s, i) => (
          <Pressable
            key={s.pda.toBase58()}
            onPress={() => openMerchant(s)}
            accessibilityRole="button"
            accessibilityLabel={`${s.name}, ${formatPriceSOL(s.priceAtomic)} ${formatInterval(s.intervalSlots)}`}
            style={({ pressed }) => [
              styles.row,
              i > 0 && styles.rowDivider,
              pressed && styles.rowPressed,
            ]}
          >
            <View style={styles.avatar}>
              <Ionicons
                name={iconKeyToIonicons(s.iconKey) as never}
                size={18}
                color={Colors.primary}
              />
            </View>

            <View style={styles.rowMain}>
              <View style={styles.rowTitleLine}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {s.name || s.slug}
                </Text>
                {/* Reported, never conferred: `verified` is a field on the
                    account this row was decoded from. */}
                {s.verified && (
                  <Ionicons
                    name="shield-checkmark"
                    size={13}
                    color={Colors.primary}
                    accessibilityLabel="Verified in the registry"
                  />
                )}
              </View>
              <Text style={styles.rowSub} numberOfLines={1}>
                {s.category || 'uncategorised'}
                {s.subscriberCount > 0n ? ` · ${s.subscriberCount.toString()} subscribed` : ''}
              </Text>
            </View>

            <View style={styles.rowRight}>
              <Text style={styles.rowPrice}>{formatPriceSOL(s.priceAtomic)}</Text>
              <Text style={styles.rowInterval}>{formatInterval(s.intervalSlots)}</Text>
            </View>
          </Pressable>
        ))}

        {shown.length > 0 && (
          <View style={styles.footNote}>
            <Text style={styles.footNoteText}>
              Paying here funds a subscription account derived from a secret, not from your
              wallet. The merchant sees a payment, not a subscriber.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Layout.screenPadding,
    paddingBottom: Spacing.md,
  },
  title: {
    fontFamily: FontFamily.display,
    fontSize: FontSize['2xl'],
    color: Colors.text,
    letterSpacing: -0.5,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { paddingHorizontal: Layout.screenPadding, gap: Spacing.lg },
  lede: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    lineHeight: 20,
    color: Colors.textSecondary,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    minHeight: 44,
    paddingHorizontal: Spacing.md,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: {
    flex: 1,
    color: Colors.text,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    paddingVertical: Spacing.sm,
  },
  centered: { paddingVertical: Spacing['3xl'], alignItems: 'center' },
  warnPanel: {
    borderWidth: 1,
    borderColor: Colors.warningDim,
    backgroundColor: Colors.warningDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  warnTitle: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: Colors.text },
  warnBody: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textSecondary },
  empty: { alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing['3xl'] },
  emptyTitle: { fontFamily: FontFamily.displayMedium, fontSize: FontSize.lg, color: Colors.text },
  emptyBody: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    maxWidth: 260,
  },
  secondaryButton: {
    minHeight: 44,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
  },
  secondaryButtonText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 64,
    paddingVertical: Spacing.md,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: Colors.borderSoft },
  rowPressed: { opacity: 0.6 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowTitle: { fontFamily: FontFamily.medium, fontSize: FontSize.md, color: Colors.text },
  rowSub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  rowRight: { alignItems: 'flex-end' },
  rowPrice: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
    color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  rowInterval: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textTertiary },
  footNote: {
    borderTopWidth: 1,
    borderTopColor: Colors.borderSoft,
    paddingTop: Spacing.md,
  },
  footNoteText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    lineHeight: 18,
    color: Colors.textSecondary,
  },
});
