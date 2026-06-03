/**
 * Connect Ledger (mobile, Nano X / BLE) — spec §3 S5 / UI-5.
 *
 * Flow: check support → BLE on → scan → pick device → connectLedger (confirms
 * address on-device, builds the WalletSigner, persists the hardware wallet) →
 * prompt to back up (the Ledger phrase does NOT regenerate the random spending
 * seed, so a backup is the only recovery path) → done.
 *
 * Coexistence: scan/connect run under the shared `bleLock` (services/ledger/*),
 * so they never race the BLE note-sharing subsystem (spec §1C, Finding #12).
 *
 * Blind-sign: P01 pool ix require "Allow blind sign" ON. We surface the
 * actionable explainer at first sign (signer.ts pre-flight + LedgerReviewSheet),
 * and again here as a heads-up after connect.
 *
 * Ordering reminder (spec §1C, Finding #13): the proof must be built and the ix
 * assembled with a FRESH blockhash BEFORE the device is prompted — that ordering
 * lives in the denominated-pool flow (signAndSend → walletSigner), not here.
 *
 * NOTE: real Nano X validation on RN 0.81.5 × ble-plx 3.5.1 is deferred to device
 * testing (no device build is run as part of this change).
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { p01Alert } from '@/stores/alertStore';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { useWalletStore } from '@/stores/walletStore';
import {
  isLedgerBleSupported,
  observeBleState,
  listenForDevices,
  type LedgerDevice,
} from '@/services/ledger/transport';

type Phase = 'checking' | 'unsupported' | 'ble-off' | 'scanning' | 'connecting' | 'connected';

export default function ConnectLedgerScreen() {
  const router = useRouter();
  const connectLedger = useWalletStore((s) => s.connectLedger);

  const [phase, setPhase] = useState<Phase>('checking');
  const [devices, setDevices] = useState<LedgerDevice[]>([]);
  const [connectedPubkey, setConnectedPubkey] = useState<string | null>(null);
  const scanStopRef = useRef<null | (() => void)>(null);

  // Capability + BLE state gating.
  useEffect(() => {
    let stateSub: { unsubscribe: () => void } | null = null;
    let cancelled = false;

    (async () => {
      const supported = await isLedgerBleSupported();
      if (cancelled) return;
      if (!supported) {
        setPhase('unsupported');
        return;
      }
      stateSub = observeBleState((e) => {
        if (cancelled) return;
        // Only advance state pre-connect; don't yank the user out of connecting/connected.
        setPhase((prev) => {
          if (prev === 'connecting' || prev === 'connected') return prev;
          return e.available ? 'scanning' : 'ble-off';
        });
      });
    })();

    return () => {
      cancelled = true;
      try { stateSub?.unsubscribe(); } catch {}
      try { scanStopRef.current?.(); } catch {}
    };
  }, []);

  // Start scanning whenever we enter the scanning phase.
  useEffect(() => {
    if (phase !== 'scanning') return;
    let active = true;
    setDevices([]);

    (async () => {
      try {
        const handle = await listenForDevices(
          (d) => {
            if (!active) return;
            setDevices((prev) => (prev.some((x) => x.id === d.id) ? prev : [...prev, d]));
          },
          (err) => {
            if (!active) return;
            p01Alert('Bluetooth error', err.message);
          },
        );
        scanStopRef.current = handle.stop;
      } catch (err: any) {
        if (active) p01Alert('Scan failed', err?.message ?? 'Could not start scanning.');
      }
    })();

    return () => {
      active = false;
      try { scanStopRef.current?.(); } catch {}
      scanStopRef.current = null;
    };
  }, [phase]);

  const handlePick = useCallback(
    async (device: LedgerDevice) => {
      // Stop scanning before connecting (frees the radio for the open()).
      try { scanStopRef.current?.(); } catch {}
      scanStopRef.current = null;

      setPhase('connecting');
      try {
        const pubkey = await connectLedger(device.id);
        setConnectedPubkey(pubkey);
        setPhase('connected');
      } catch (err: any) {
        setPhase('scanning');
        p01Alert('Connection failed', err?.message ?? 'Could not connect to the Ledger.');
      }
    },
    [connectLedger],
  );

  const goBackup = useCallback(() => {
    router.push('/(main)/(settings)/backup');
  }, [router]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Animated.View entering={FadeInDown.delay(50).duration(300)} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={20} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Connect Ledger</Text>
        <View style={{ width: 40 }} />
      </Animated.View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 80 }} showsVerticalScrollIndicator={false}>
        {/* Intro */}
        <Animated.View entering={FadeInDown.delay(100).duration(300)} style={styles.card}>
          <View style={styles.cardRow}>
            <View style={styles.cardIcon}>
              <Ionicons name="hardware-chip-outline" size={22} color={P01Colors.cyan} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Ledger Nano X</Text>
              <Text style={styles.cardBody}>
                Connect over Bluetooth. Only the Nano X has Bluetooth; Nano S / S Plus are not supported.
              </Text>
            </View>
          </View>
        </Animated.View>

        {/* Phase content */}
        {phase === 'checking' && (
          <View style={styles.centerBlock}>
            <ActivityIndicator color={P01Colors.cyan} />
            <Text style={styles.muted}>Checking Bluetooth support…</Text>
          </View>
        )}

        {phase === 'unsupported' && (
          <View style={styles.noticeCard}>
            <Ionicons name="close-circle-outline" size={22} color="#ef4444" />
            <Text style={styles.noticeText}>
              Bluetooth LE is not available on this device/build. Ledger pairing needs a BLE-capable phone.
            </Text>
          </View>
        )}

        {phase === 'ble-off' && (
          <View style={styles.noticeCard}>
            <Ionicons name="bluetooth-outline" size={22} color="#eab308" />
            <Text style={styles.noticeText}>
              Turn on Bluetooth, then unlock your Ledger and open the Solana app.
            </Text>
          </View>
        )}

        {phase === 'scanning' && (
          <>
            <Text style={styles.sectionTitle}>NEARBY DEVICES</Text>
            <View style={styles.scanRow}>
              <ActivityIndicator color={P01Colors.cyan} size="small" />
              <Text style={styles.muted}>Scanning… keep your Ledger unlocked with the Solana app open.</Text>
            </View>
            {devices.map((d) => (
              <TouchableOpacity key={d.id} style={styles.deviceRow} onPress={() => handlePick(d)} activeOpacity={0.7}>
                <View style={styles.cardIcon}>
                  <Ionicons name="bluetooth" size={18} color={P01Colors.cyan} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.deviceName}>{d.name || 'Ledger device'}</Text>
                  <Text style={styles.deviceId}>{d.id.slice(0, 12)}…</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
              </TouchableOpacity>
            ))}
          </>
        )}

        {phase === 'connecting' && (
          <View style={styles.centerBlock}>
            <ActivityIndicator color={P01Colors.cyan} />
            <Text style={styles.muted}>Confirm the address on your Ledger…</Text>
          </View>
        )}

        {phase === 'connected' && (
          <>
            <View style={styles.successCard}>
              <Ionicons name="checkmark-circle" size={22} color="#22c55e" />
              <View style={{ flex: 1, marginLeft: Spacing.md }}>
                <Text style={styles.successTitle}>Ledger connected</Text>
                <Text style={styles.cardBody}>
                  {connectedPubkey ? `${connectedPubkey.slice(0, 6)}…${connectedPubkey.slice(-6)}` : ''}
                </Text>
              </View>
            </View>

            {/* Blind-sign heads-up */}
            <View style={styles.noticeCard}>
              <Ionicons name="warning-outline" size={20} color="#eab308" />
              <Text style={styles.noticeText}>
                Protocol 01 uses a custom Solana program. Enable "Allow blind sign" in your Ledger's
                Solana app (Settings) so transactions can be signed.
              </Text>
            </View>

            {/* Backup prompt — mandatory-ish for hardware */}
            <View style={[styles.noticeCard, { borderColor: '#ef4444', borderWidth: 1 }]}>
              <Ionicons name="shield-outline" size={20} color="#ef4444" />
              <Text style={styles.noticeText}>
                Your private-note key for this hardware wallet is stored only on this phone. The Ledger
                seed does NOT restore it. Create an encrypted backup now or you can lose your notes.
              </Text>
            </View>

            <TouchableOpacity style={styles.primaryButton} onPress={goBackup} activeOpacity={0.85}>
              <Ionicons name="download-outline" size={18} color={Colors.background} />
              <Text style={styles.primaryButtonText}>Back up now</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.secondaryButton} onPress={() => router.replace('/(main)/(wallet)' as any)} activeOpacity={0.7}>
              <Text style={styles.secondaryButtonText}>Go to wallet</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: '#0f0f12',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { color: Colors.text, fontSize: 18, fontFamily: FontFamily.semibold },

  sectionTitle: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    letterSpacing: 1,
    paddingHorizontal: Spacing.lg,
    marginTop: Spacing.lg,
    marginBottom: Spacing.sm,
  },

  card: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    backgroundColor: '#0f0f12',
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
  },
  cardRow: { flexDirection: 'row', alignItems: 'flex-start', padding: Spacing.lg, gap: Spacing.md },
  cardIcon: {
    width: 38,
    height: 38,
    borderRadius: BorderRadius.md,
    backgroundColor: P01Colors.cyanDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { color: Colors.text, fontSize: 16, fontFamily: FontFamily.medium, marginBottom: 2 },
  cardBody: { color: Colors.textSecondary, fontSize: 13, lineHeight: 18 },

  centerBlock: { alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing['3xl'], gap: Spacing.md },
  muted: { color: Colors.textSecondary, fontSize: 13, textAlign: 'center', paddingHorizontal: Spacing.lg },

  scanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
  },

  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
    padding: Spacing.md,
    backgroundColor: '#0f0f12',
    borderRadius: BorderRadius.lg,
  },
  deviceName: { color: Colors.text, fontSize: 15, fontFamily: FontFamily.medium },
  deviceId: { color: Colors.textTertiary, fontSize: 12, fontFamily: FontFamily.mono, marginTop: 2 },

  noticeCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    padding: Spacing.lg,
    backgroundColor: '#0f0f12',
    borderRadius: BorderRadius.lg,
  },
  noticeText: { flex: 1, color: Colors.textSecondary, fontSize: 13, lineHeight: 19 },

  successCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    padding: Spacing.lg,
    backgroundColor: 'rgba(34,197,94,0.08)',
    borderRadius: BorderRadius.lg,
  },
  successTitle: { color: '#22c55e', fontSize: 16, fontFamily: FontFamily.semibold },

  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.lg,
    paddingVertical: Spacing.md + 2,
    borderRadius: BorderRadius.md,
    backgroundColor: P01Colors.cyan,
  },
  primaryButtonText: { color: Colors.background, fontFamily: FontFamily.semibold, fontSize: 16 },
  secondaryButton: {
    alignItems: 'center',
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.sm,
    paddingVertical: Spacing.md + 2,
    borderRadius: BorderRadius.md,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  secondaryButtonText: { color: Colors.text, fontFamily: FontFamily.semibold, fontSize: 16 },
});
