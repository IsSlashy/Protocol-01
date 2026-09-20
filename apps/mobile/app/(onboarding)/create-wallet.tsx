/**
 * Creating the wallet — the crossing.
 *
 * The one moment the app has that no other wallet has, and the one worth
 * filming: the keys are born on this phone, and the river shows it. The
 * StyxRiver under the screen starts at its resting drift and QUICKENS with each
 * step (flow 0.15 → 1.0), so the current itself is the progress indicator. In
 * the middle, the mark assembles the way the brand's Wordmark is composed: the
 * serif S fades in as the keypair is generated, a scrambling base58 line
 * settles character by character into the wallet's real address as it is
 * stored, and when the last step lands the teal diagonal CUTS across the S,
 * the same cut the logo carries, with a heavy haptic. Then the backup screen.
 *
 * What this replaced, 2026-09-13: a 24pt Inter-Bold title, a rounded cyan
 * progress pill, an icon-spinner checklist in a 16pt-radius card and the line
 * "Encrypted with military-grade security", which named nothing this code does.
 *
 * ⚠️ The creation logic — createWallet(), the temp-mnemonic SecureStore write
 * with its verify-and-retry, the step timing and the haptics — is unchanged.
 * Only what is drawn moved. The address shown is the PUBLIC key; the mnemonic
 * never reaches this screen's render tree.
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { p01Alert } from '@/stores/alertStore';
import { useRouter } from 'expo-router';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Line } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';

import { Colors, FontFamily } from '../../constants/theme';
import { Hairline, Lede, Mono, Overline, Screen, Title } from '../../components/onboarding/Styx';
import { createWallet } from '../../services/solana/wallet';
import { useT } from '@/i18n';

const STEP_DURATION = 800;
const MARK = 168;
/* The cut, in the Wordmark's own viewBox: (27.5,4.5) → (4.5,27.5), 23·√2 long. */
const CUT_LENGTH = 23 * Math.SQRT2;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const AnimatedLine = Animated.createAnimatedComponent(Line);

type Status = 'pending' | 'in_progress' | 'completed';
type Step = { id: string; label: string; status: Status };

export default function CreateWalletScreen() {
  const t = useT();
  const router = useRouter();
  const [steps, setSteps] = useState<Step[]>(() => [
    { id: '1', label: t('onboarding.generatingKeypair'), status: 'pending' },
    { id: '2', label: t('onboarding.creatingSecureStorage'), status: 'pending' },
    { id: '3', label: t('onboarding.encryptingKeys'), status: 'pending' },
    { id: '4', label: t('onboarding.settingUpWallet'), status: 'pending' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [sealed, setSealed] = useState(false);

  /* the river quickens with each step; the mark and its cut arrive on cue */
  const flow = useSharedValue(0.15);
  const progress = useSharedValue(0);
  const markOpacity = useSharedValue(0);
  const cut = useSharedValue(0);

  useEffect(() => {
    startWalletCreation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startWalletCreation = async () => {
    try {
      // Step 1: Generating keypair
      updateStep(0, 'in_progress');
      flow.value = withTiming(0.35, { duration: 900 });
      markOpacity.value = withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) });
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await delay(STEP_DURATION);
      updateStep(0, 'completed');
      progress.value = withTiming(0.25, { duration: 300 });

      // Step 2: Creating secure storage
      updateStep(1, 'in_progress');
      flow.value = withTiming(0.55, { duration: 900 });
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await delay(STEP_DURATION);
      updateStep(1, 'completed');
      progress.value = withTiming(0.5, { duration: 300 });

      // Step 3: Encrypting keys - Actually create the wallet here
      updateStep(2, 'in_progress');
      flow.value = withTiming(0.75, { duration: 900 });
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      const walletInfo = await createWallet();

      if (!walletInfo.mnemonic || walletInfo.mnemonic.split(' ').length !== 12) {
        throw new Error('Invalid mnemonic generated');
      }
      setAddress(walletInfo.publicKey);

      await delay(STEP_DURATION);
      updateStep(2, 'completed');
      progress.value = withTiming(0.75, { duration: 300 });

      // Step 4: Setting up wallet
      updateStep(3, 'in_progress');
      flow.value = withTiming(1, { duration: 900 });
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      // Store mnemonic temporarily for backup screen (use same keychainService)
      const secOpts = { keychainService: 'protocol-01' };
      await SecureStore.setItemAsync('p01_temp_mnemonic', walletInfo.mnemonic, secOpts);

      // Verify it was stored correctly (retry once on failure)
      let storedMnemonic = await SecureStore.getItemAsync('p01_temp_mnemonic', secOpts);
      if (!storedMnemonic || storedMnemonic !== walletInfo.mnemonic) {
        await new Promise((r) => setTimeout(r, 300));
        await SecureStore.setItemAsync('p01_temp_mnemonic', walletInfo.mnemonic, secOpts);
        storedMnemonic = await SecureStore.getItemAsync('p01_temp_mnemonic', secOpts);
        if (!storedMnemonic || storedMnemonic !== walletInfo.mnemonic) {
          console.error('[CreateWallet] Mnemonic storage verification failed after retry');
          throw new Error('Failed to store mnemonic securely');
        }
      }

      await delay(STEP_DURATION);
      updateStep(3, 'completed');
      progress.value = withTiming(1, { duration: 300 });

      // Success: the cut crosses the S, the river holds its full current.
      cut.value = withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) });
      setSealed(true);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Navigate to backup screen using replace to avoid navigation stack issues
      setTimeout(() => {
        router.replace('/(onboarding)/backup');
      }, 1400);
    } catch (err: any) {
      console.error('[CreateWallet] Wallet creation error:', err);
      setError(err.message || t('onboarding.walletCreationFailed'));
      flow.value = withTiming(0.15, { duration: 900 });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);

      p01Alert(
        t('common.error'),
        err.message || t('onboarding.walletCreationFailed'),
        [{ text: t('common.retry'), onPress: () => startWalletCreation() }],
      );
    }
  };

  const updateStep = (index: number, status: Status) => {
    setSteps((prev) =>
      prev.map((step, idx) => ({
        ...step,
        status: idx < index ? 'completed' : idx === index ? status : step.status,
      })),
    );
  };

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const markStyle = useAnimatedStyle(() => ({ opacity: markOpacity.value }));
  const cutProps = useAnimatedProps(() => ({
    strokeDashoffset: CUT_LENGTH * (1 - cut.value),
  }));
  const progressStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  return (
    <Screen river={{ flow, dim: 0.25, touch: false }}>
      <Animated.View entering={FadeInDown.delay(150).duration(600)} style={{ paddingTop: 24 }}>
        <Overline>{t('onboarding.crossing')}</Overline>
        <View style={{ marginTop: 12 }}>
          <Title size={30}>{sealed ? t('onboarding.walletReady') : t('onboarding.creatingWallet')}</Title>
        </View>
      </Animated.View>

      {/* The mark, composed the way the Wordmark composes it, arriving in two gestures. */}
      <View style={styles.centre}>
        <Animated.View style={[styles.mark, markStyle]} accessible accessibilityLabel="Styx">
          <Text style={styles.letter} allowFontScaling={false}>
            S
          </Text>
          <Svg width={MARK} height={MARK} viewBox="0 0 32 32" style={StyleSheet.absoluteFill}>
            <AnimatedLine
              x1="27.5"
              y1="4.5"
              x2="4.5"
              y2="27.5"
              stroke={Colors.primary}
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeDasharray={[CUT_LENGTH, CUT_LENGTH]}
              animatedProps={cutProps}
            />
          </Svg>
        </Animated.View>

        <View style={{ marginTop: 28, alignItems: 'center', minHeight: 44 }}>
          <Overline>{t('onboarding.yourAddress')}</Overline>
          <View style={{ marginTop: 8 }}>
            <AddressLine address={address} />
          </View>
        </View>
      </View>

      <Animated.View entering={FadeInDown.delay(500).duration(600)} style={{ paddingBottom: 28 }}>
        <View style={{ marginBottom: 18 }}>
          <Hairline />
          <Animated.View style={[styles.progress, progressStyle]} />
        </View>
        {steps.map((s) => (
          <StepRow key={s.id} step={s} />
        ))}
        {error ? (
          <Animated.View entering={FadeIn} style={{ marginTop: 12 }}>
            <Mono color={Colors.error}>{error}</Mono>
          </Animated.View>
        ) : null}
        <View style={{ marginTop: 18 }}>
          <Lede size={13}>{t('onboarding.encryptedSecurity')}</Lede>
        </View>
      </Animated.View>
    </Screen>
  );
}

/**
 * The address, resolving. While the keys are being made the line is base58
 * noise re-rolled every 60 ms; once the public key exists, each character
 * settles left to right, 70 ms apart, into `first 6 … last 5`. Twelve glyphs,
 * mono, so nothing shifts when it lands.
 */
const AddressLine: React.FC<{ address: string | null }> = ({ address }) => {
  const [shown, setShown] = useState('');
  const settled = useRef(0);

  useEffect(() => {
    const target = address ? `${address.slice(0, 6)}…${address.slice(-5)}` : null;
    const roll = () =>
      Array.from({ length: 12 }, (_, i) =>
        target && i < settled.current ? target[i] : BASE58[Math.floor(Math.random() * BASE58.length)],
      ).join('');
    const tick = setInterval(() => {
      if (target && settled.current < target.length) settled.current += 1;
      setShown(target && settled.current >= target.length ? target : roll());
    }, target ? 70 : 60);
    return () => clearInterval(tick);
  }, [address]);

  return (
    <Text style={styles.address} allowFontScaling={false}>
      {shown}
    </Text>
  );
};

const StepRow: React.FC<{ step: Step }> = ({ step }) => {
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (step.status === 'in_progress') {
      pulse.value = withRepeat(
        withSequence(withTiming(0.25, { duration: 500 }), withTiming(1, { duration: 500 })),
        -1,
        true,
      );
    } else {
      pulse.value = withTiming(1, { duration: 200 });
    }
  }, [step.status, pulse]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));
  const done = step.status === 'completed';
  const active = step.status === 'in_progress';
  return (
    <View style={styles.stepRow}>
      <Animated.View
        style={[
          styles.dot,
          dotStyle,
          done && { backgroundColor: Colors.primary, borderColor: Colors.primary },
          active && { borderColor: Colors.primary },
        ]}
      />
      <Text
        style={[
          styles.stepLabel,
          { color: done ? Colors.textSecondary : active ? Colors.text : Colors.textTertiary },
        ]}
      >
        {step.label}
      </Text>
      {done ? <Text style={styles.tick}>{'✓'}</Text> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mark: { width: MARK, height: MARK, alignItems: 'center', justifyContent: 'center' },
  letter: {
    fontFamily: FontFamily.display,
    fontSize: MARK * 1.02,
    lineHeight: MARK * 1.02,
    color: Colors.text,
    textAlign: 'center',
  },
  address: {
    fontFamily: FontFamily.mono,
    fontSize: 17,
    letterSpacing: 1.2,
    color: Colors.text,
  },
  progress: {
    position: 'absolute',
    left: 0,
    top: -1,
    height: 3,
    backgroundColor: Colors.primary,
  },
  stepRow: { flexDirection: 'row', alignItems: 'center', minHeight: 30, gap: 12 },
  dot: {
    width: 7,
    height: 7,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: 'transparent',
  },
  stepLabel: { flex: 1, fontFamily: FontFamily.mono, fontSize: 13, letterSpacing: 0.2 },
  tick: { fontFamily: FontFamily.mono, fontSize: 13, color: Colors.primary },
});
