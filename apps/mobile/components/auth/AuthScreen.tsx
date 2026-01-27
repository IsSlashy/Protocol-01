/**
 * P-01 Auth Screen Component
 *
 * Main authentication screen with Privy integration.
 * Features P-01 cyberpunk design with glitch effects and animations.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  SlideInRight,
  SlideOutLeft,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { Logo } from '../onboarding/Logo';
import { PrivyLoginButton, AuthDivider, SocialLoginGrid } from './PrivyLoginButton';
import { EmailLoginForm } from './EmailLoginForm';

// P-01 Colors
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  cyanBright: '#00ffe5',
  pink: '#ff2d7a',
  pinkDim: 'rgba(255, 45, 122, 0.15)',
  void: '#0a0a0c',
  surface: '#151518',
  surfaceElevated: '#1a1a1f',
  border: '#2a2a30',
  textPrimary: '#ffffff',
  textSecondary: '#888892',
  textTertiary: '#555560',
};

const { width: SCREEN_WIDTH } = Dimensions.get('window');

type AuthMode = 'main' | 'email' | 'phone';
type LoginMethod = 'email' | 'sms' | 'google' | 'apple' | 'twitter' | 'wallet';

interface AuthScreenProps {
  onLogin: (method: LoginMethod, value?: string) => Promise<void>;
  onVerifyOtp: (otp: string) => Promise<void>;
  onCreateWallet?: () => void;
  onImportWallet?: () => void;
  loading?: LoginMethod | null;
}

export function AuthScreen({
  onLogin,
  onVerifyOtp,
  onCreateWallet,
  onImportWallet,
  loading,
}: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('main');
  const [submittedValue, setSubmittedValue] = useState('');

  const handleEmailPress = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMode('email');
  }, []);

  const handlePhonePress = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMode('phone');
  }, []);

  const handleBack = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMode('main');
  }, []);

  const handleEmailSubmit = useCallback(async (email: string) => {
    setSubmittedValue(email);
    await onLogin('email', email);
  }, [onLogin]);

  const handlePhoneSubmit = useCallback(async (phone: string) => {
    setSubmittedValue(phone);
    await onLogin('sms', phone);
  }, [onLogin]);

  const handleSocialLogin = useCallback(async (method: LoginMethod) => {
    await onLogin(method);
  }, [onLogin]);

  return (
    <SafeAreaView style={styles.container}>
      {/* Background Effects */}
      <LinearGradient
        colors={['rgba(57,197,187,0.03)', 'transparent', 'rgba(255,45,122,0.02)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      {/* Decorative grid lines */}
      <View style={styles.gridOverlay}>
        {[...Array(8)].map((_, i) => (
          <View
            key={i}
            style={[
              styles.gridLine,
              { left: (SCREEN_WIDTH / 8) * i },
            ]}
          />
        ))}
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {mode === 'main' ? (
          /* Main Auth Screen */
          <Animated.View
            entering={FadeIn.duration(400)}
            exiting={SlideOutLeft.duration(300)}
            style={styles.mainContent}
          >
            {/* Logo Section */}
            <Animated.View
              entering={FadeInDown.delay(100).duration(600)}
              style={styles.logoSection}
            >
              <Logo size={100} showText={false} animated />

              <View style={styles.titleContainer}>
                <Text style={styles.systemLabel}>[ AUTHENTICATION ]</Text>
                <Text style={styles.title}>CONNECT</Text>
                <View style={styles.statusIndicator}>
                  <View style={styles.statusDot} />
                  <Text style={styles.statusText}>SECURE CHANNEL</Text>
                </View>
              </View>
            </Animated.View>

            {/* Login Options */}
            <Animated.View
              entering={FadeInUp.delay(300).duration(600)}
              style={styles.loginOptions}
            >
              {/* Email Login */}
              <PrivyLoginButton
                method="email"
                onPress={handleEmailPress}
                loading={loading === 'email'}
              />

              {/* Phone Login */}
              <PrivyLoginButton
                method="sms"
                onPress={handlePhonePress}
                loading={loading === 'sms'}
              />

              <AuthDivider />

              {/* Social Login */}
              <SocialLoginGrid
                onGooglePress={() => handleSocialLogin('google')}
                onApplePress={() => handleSocialLogin('apple')}
                onTwitterPress={() => handleSocialLogin('twitter')}
                loading={loading}
              />

              <AuthDivider />

              {/* Wallet Connection */}
              <PrivyLoginButton
                method="wallet"
                onPress={() => handleSocialLogin('wallet')}
                loading={loading === 'wallet'}
                variant="outline"
              />
            </Animated.View>

            {/* Bottom Actions */}
            <Animated.View
              entering={FadeInUp.delay(500).duration(600)}
              style={styles.bottomActions}
            >
              {onCreateWallet && (
                <TouchableOpacity
                  onPress={onCreateWallet}
                  activeOpacity={0.7}
                  style={styles.textButton}
                >
                  <Text style={styles.textButtonLabel}>
                    New here?{' '}
                    <Text style={styles.textButtonHighlight}>Create wallet</Text>
                  </Text>
                </TouchableOpacity>
              )}

              {onImportWallet && (
                <TouchableOpacity
                  onPress={onImportWallet}
                  activeOpacity={0.7}
                  style={styles.textButton}
                >
                  <Text style={styles.textButtonLabel}>
                    Have a seed phrase?{' '}
                    <Text style={styles.textButtonHighlight}>Import</Text>
                  </Text>
                </TouchableOpacity>
              )}
            </Animated.View>

            {/* Terms */}
            <Text style={styles.terms}>
              By continuing, you agree to our{' '}
              <Text style={styles.termsLink}>Terms of Service</Text>
              {' '}and{' '}
              <Text style={styles.termsLink}>Privacy Policy</Text>
            </Text>
          </Animated.View>
        ) : (
          /* Email/Phone Form */
          <Animated.View
            entering={SlideInRight.duration(300)}
            exiting={FadeOut.duration(200)}
            style={styles.formContent}
          >
            <EmailLoginForm
              mode={mode === 'email' ? 'email' : 'phone'}
              onSubmit={mode === 'email' ? handleEmailSubmit : handlePhoneSubmit}
              onVerifyOtp={onVerifyOtp}
              onBack={handleBack}
              onResendOtp={async () => {
                await onLogin(mode === 'email' ? 'email' : 'sms', submittedValue);
              }}
            />
          </Animated.View>
        )}
      </ScrollView>

      {/* Security Badge */}
      <View style={styles.securityBadge}>
        <Ionicons name="shield-checkmark" size={14} color={P01.cyan} />
        <Text style={styles.securityText}>End-to-end encrypted</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: P01.void,
  },
  gridOverlay: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  gridLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(57, 197, 187, 0.03)',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 40,
  },
  mainContent: {
    flex: 1,
  },
  formContent: {
    flex: 1,
    paddingTop: 20,
  },
  logoSection: {
    alignItems: 'center',
    marginBottom: 40,
  },
  titleContainer: {
    alignItems: 'center',
    marginTop: 24,
  },
  systemLabel: {
    color: P01.pink,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 4,
    marginBottom: 8,
  },
  title: {
    color: P01.textPrimary,
    fontSize: 32,
    fontWeight: '900',
    letterSpacing: 4,
  },
  statusIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  statusDot: {
    width: 6,
    height: 6,
    backgroundColor: P01.cyan,
    marginRight: 8,
  },
  statusText: {
    color: P01.textTertiary,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 3,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  loginOptions: {
    marginBottom: 24,
  },
  bottomActions: {
    alignItems: 'center',
    marginTop: 8,
    gap: 12,
  },
  textButton: {
    padding: 8,
  },
  textButtonLabel: {
    color: P01.textSecondary,
    fontSize: 14,
  },
  textButtonHighlight: {
    color: P01.cyan,
    fontWeight: '600',
  },
  terms: {
    color: P01.textTertiary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 24,
    lineHeight: 18,
  },
  termsLink: {
    color: P01.textSecondary,
    textDecorationLine: 'underline',
  },
  securityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 6,
  },
  securityText: {
    color: P01.textTertiary,
    fontSize: 12,
    fontWeight: '500',
  },
});

export default AuthScreen;
