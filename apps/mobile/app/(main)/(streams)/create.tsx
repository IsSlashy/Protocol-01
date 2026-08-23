/**
 * Personal payment streams — parked.
 *
 * ⛔ FOUNDER RULING 2026-08-23: merchant subscriptions are the product.
 * Paying a person on a schedule — salary, allowance, rent — is parked, and so
 * is subscribing on somebody else's behalf. This screen used to build that
 * stream: an address field, an amount, a cadence, a "Private mode" switch that
 * handed off to the ZK vault, and a first payment fired on submit.
 *
 * 🎯 WHY THE ROUTE SURVIVES THE FEATURE. `/(main)/(streams)/create` is reachable
 * from deep links, from the extension's phone-pairing handoff, and from any
 * install still running an older tab bar. Deleting the file turns each of those
 * into a router crash; deleting only the SURFACE turns them into a sentence
 * that says what happened and offers the thing we do want people to do. That is
 * the difference between parking a feature and dropping one.
 *
 * ⚠️ The stream-building logic is gone from here rather than hidden behind a
 * flag. It is one `git show` away, and a hundred and forty lines of unreachable
 * payment code sitting in a screen is how a parked feature quietly half-ships.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { Header } from '@/components/common';
import { Button } from '@/components/ui';
import { Colors, FontFamily, FontSize, Spacing, Layout } from '@/constants/theme';

export default function CreatePersonalStreamScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View style={st.container}>
      <Header showBack transparent />

      <View style={[st.body, { paddingBottom: insets.bottom + Spacing['3xl'] }]}>
        <Text style={st.title}>Paying a person is parked</Text>

        <Text style={st.body_}>
          Styx is built around subscribing to a merchant with a shielded note. Scheduling
          payments to an individual was a second product sharing this screen, and it is set
          aside until the first one is finished.
        </Text>

        <Text style={st.body_}>
          Nothing you already created is affected. Existing schedules keep running and stay in
          your subscription list.
        </Text>

        <View style={st.actions}>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              router.replace('/(main)/(discover)' as any);
            }}
          >
            Browse merchants
          </Button>
          <Button variant="ghost" size="md" fullWidth onPress={() => router.back()}>
            Back to my subscriptions
          </Button>
        </View>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  body: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Layout.screenPadding,
    gap: Spacing.md,
  },
  title: {
    fontFamily: FontFamily.display,
    fontSize: FontSize['3xl'],
    color: Colors.text,
    marginBottom: Spacing.xs,
  },
  body_: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    lineHeight: 23,
    color: Colors.textSecondary,
  },
  actions: {
    marginTop: Spacing['3xl'],
    gap: Spacing.md,
  },
});
