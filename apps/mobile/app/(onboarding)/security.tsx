/**
 * Security — PIN or biometrics.
 *
 * Restyled 2026-09-13 onto the onboarding vocabulary. The two options are
 * hairline rows (title in the display face, one line under it, the teal seal
 * on the selected row) instead of icon bubbles in 16pt-radius cards with a
 * glow; the PIN step keeps the PinInput and gets the same overline/title/lede
 * head as every other screen. No red literals, no '#a0a0a0', no halo.
 *
 * ⚠️ Untouched: biometric detection, the PIN hash + vault enable/unlock, the
 * onboarding completion (p01_onboarded, temp-mnemonic cleanup, store init) and
 * the routes.
 */
import React, { useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { p01Alert } from '@/stores/alertStore';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

import { PinInput } from '../../components/onboarding';
import { GhostLink, Lede, Mono, Overline, PaperButton, Screen, Title } from '../../components/onboarding/Styx';
import { Colors, FontFamily } from '../../constants/theme';
import { useWalletStore } from '../../stores/walletStore';
import { hashPin } from '../../utils/crypto/pinHash';
import { enableVault, unlockVault } from '../../utils/crypto/noteVault';
import { useT } from '@/i18n';

type SecurityMethod = 'none' | 'pin' | 'biometrics';

export default function SecurityScreen() {
  const t = useT();
  const router = useRouter();
  const [selectedMethod, setSelectedMethod] = useState<SecurityMethod>('none');
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [isConfirming, setIsConfirming] = useState(false);
  const [pinError, setPinError] = useState(false);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const [biometricType, setBiometricType] = useState<'face' | 'fingerprint'>('fingerprint');

  React.useEffect(() => {
    checkBiometrics();
  }, []);

  const checkBiometrics = async () => {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    const supportedTypes = await LocalAuthentication.supportedAuthenticationTypesAsync();

    setBiometricsAvailable(hasHardware && isEnrolled);

    if (supportedTypes.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
      setBiometricType('face');
    } else {
      setBiometricType('fingerprint');
    }
  };

  const handleSelectMethod = useCallback(
    async (method: SecurityMethod) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setSelectedMethod(method);

      if (method === 'pin') {
        setShowPinSetup(true);
      } else if (method === 'biometrics') {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: t('onboarding.authenticateToEnable'),
          cancelLabel: t('common.cancel'),
          disableDeviceFallback: true,
        });

        if (!result.success) {
          setSelectedMethod('none');
          p01Alert(t('onboarding.authFailed'), t('onboarding.authFailedDesc'));
        }
      }
    },
    [t],
  );

  const handlePinComplete = useCallback(
    (enteredPin: string) => {
      if (!isConfirming) {
        setPin(enteredPin);
        setIsConfirming(true);
        setConfirmPin('');
      } else {
        if (enteredPin === pin) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          savePinAndContinue(enteredPin);
        } else {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          setPinError(true);
          setConfirmPin('');
          setTimeout(() => {
            setPinError(false);
            setIsConfirming(false);
            setPin('');
          }, 1500);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isConfirming, pin],
  );

  const savePinAndContinue = async (pinCode: string) => {
    try {
      const pinHash = await hashPin(pinCode);
      await SecureStore.setItemAsync('wallet_pin', pinHash);
      await SecureStore.setItemAsync('security_method', 'pin');
      // Enable note vault — shielded note receipts will be PIN-encrypted
      await enableVault();
      await unlockVault(pinHash);
      completeOnboarding();
    } catch (error) {
      p01Alert(t('common.error'), t('onboarding.failedToSavePin'));
    }
  };

  const handleContinue = useCallback(async () => {
    if (selectedMethod === 'biometrics') {
      await SecureStore.setItemAsync('security_method', 'biometrics');
      completeOnboarding();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMethod]);

  const completeOnboarding = async () => {
    await SecureStore.setItemAsync('p01_onboarded', 'true');
    // Clean up temp mnemonic from both keychain services
    await SecureStore.deleteItemAsync('p01_temp_mnemonic', { keychainService: 'protocol-01' }).catch(() => {});
    await SecureStore.deleteItemAsync('p01_temp_mnemonic').catch(() => {});
    // Initialize wallet store so the wallet screen finds the wallet
    await useWalletStore.getState().initialize();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Go directly to wallet — user just authenticated during onboarding
    // Lock screen is for app re-opens, not first-time setup
    router.replace('/(main)/(wallet)');
  };

  const resetPin = () => {
    setShowPinSetup(false);
    setSelectedMethod('none');
    setPin('');
    setConfirmPin('');
    setIsConfirming(false);
    setPinError(false);
  };

  // PIN Setup View
  if (showPinSetup) {
    return (
      <Screen>
        <Animated.View entering={FadeInDown.delay(150).duration(600)} style={{ paddingTop: 28 }}>
          <Overline>{t('onboarding.overline')}</Overline>
          <View style={{ marginTop: 12 }}>
            <Title size={30}>{isConfirming ? t('onboarding.confirmYourPin') : t('onboarding.createPin')}</Title>
          </View>
          <View style={{ marginTop: 10, marginBottom: 36 }}>
            <Lede>{isConfirming ? t('onboarding.confirmPinDesc') : t('onboarding.choosePinDesc')}</Lede>
          </View>
        </Animated.View>

        <Animated.View entering={FadeIn.delay(350).duration(600)} style={{ alignItems: 'center' }}>
          <PinInput
            length={6}
            value={isConfirming ? confirmPin : pin}
            onChange={isConfirming ? setConfirmPin : setPin}
            onComplete={handlePinComplete}
            error={pinError}
            secureEntry
          />
          {pinError ? (
            <Animated.View entering={FadeIn} style={{ marginTop: 14 }}>
              <Mono color={Colors.error} center>
                {t('onboarding.pinsDontMatch')}
              </Mono>
            </Animated.View>
          ) : null}
        </Animated.View>

        <View style={{ flex: 1 }} />
        <View style={{ paddingBottom: 20 }}>
          <GhostLink onPress={resetPin} accessibilityLabel={t('onboarding.goBack')}>
            {t('onboarding.goBack')}
          </GhostLink>
        </View>
      </Screen>
    );
  }

  // Main Security Selection View
  const canContinue = selectedMethod !== 'none' && selectedMethod !== 'pin';
  const bioTitle = biometricType === 'face' ? t('onboarding.faceId') : t('onboarding.fingerprint');
  const bioSub = biometricsAvailable ? t('onboarding.quickSecureAuth') : t('onboarding.notAvailableDevice');

  return (
    <Screen>
      <Animated.View entering={FadeInDown.delay(150).duration(600)} style={{ paddingTop: 28 }}>
        <Overline>{t('onboarding.overline')}</Overline>
        <View style={{ marginTop: 12 }}>
          <Title size={30}>{t('onboarding.secureWallet')}</Title>
        </View>
        <View style={{ marginTop: 10, marginBottom: 28 }}>
          <Lede>{t('onboarding.secureWalletDesc')}</Lede>
        </View>
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(350).duration(600)} style={styles.list}>
        <OptionRow
          title={t('onboarding.pinCode')}
          sub={t('onboarding.sixDigitCode')}
          selected={selectedMethod === 'pin'}
          onPress={() => handleSelectMethod('pin')}
        />
        <OptionRow
          title={bioTitle}
          sub={bioSub}
          selected={selectedMethod === 'biometrics'}
          disabled={!biometricsAvailable}
          onPress={() => handleSelectMethod('biometrics')}
        />
      </Animated.View>

      <View style={{ flex: 1 }} />
      <Animated.View entering={FadeInUp.delay(600).duration(600)} style={{ paddingBottom: 24 }}>
        <PaperButton label={t('onboarding.continue')} onPress={handleContinue} disabled={!canContinue} />
      </Animated.View>
    </Screen>
  );
}

const OptionRow: React.FC<{
  title: string;
  sub: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}> = ({ title, sub, selected, disabled, onPress }) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    accessibilityRole="button"
    accessibilityLabel={`${title}, ${sub}`}
    accessibilityState={{ selected, disabled: !!disabled }}
    style={({ pressed }) => [styles.row, disabled && { opacity: 0.45 }, pressed && !disabled && { opacity: 0.7 }]}
  >
    <View style={[styles.rowSeal, selected && { backgroundColor: Colors.primary }]} />
    <View style={{ flex: 1 }}>
      <Text style={styles.rowTitle}>{title}</Text>
      <Text style={styles.rowSub}>{sub}</Text>
    </View>
    {selected ? <Text style={styles.rowTick}>{'✓'}</Text> : null}
  </Pressable>
);

const styles = StyleSheet.create({
  list: { borderTopWidth: 1, borderTopColor: Colors.border },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 76,
    paddingVertical: 14,
    paddingRight: 4,
    gap: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  rowSeal: { width: 3, alignSelf: 'stretch', backgroundColor: 'transparent' },
  rowTitle: { fontFamily: FontFamily.displayMedium, fontSize: 21, color: Colors.text, letterSpacing: -0.3 },
  rowSub: { fontFamily: FontFamily.regular, fontSize: 13, color: Colors.textSecondary, marginTop: 3 },
  rowTick: { fontFamily: FontFamily.mono, fontSize: 15, color: Colors.primary },
});
