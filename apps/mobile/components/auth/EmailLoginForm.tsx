/**
 * P-01 Email Login Form Component
 *
 * Email/Phone authentication with OTP verification.
 * Styled with P-01 cyberpunk design.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

// P-01 Colors
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  cyanBright: '#00ffe5',
  pink: '#ff2d7a',
  pinkDim: 'rgba(255, 45, 122, 0.15)',
  void: '#0a0a0c',
  surface: '#151518',
  border: '#2a2a30',
  textPrimary: '#ffffff',
  textSecondary: '#888892',
  error: '#ff3366',
};

type AuthMode = 'email' | 'phone';
type AuthStep = 'input' | 'otp';

interface EmailLoginFormProps {
  mode?: AuthMode;
  onSubmit: (value: string) => Promise<void>;
  onVerifyOtp: (otp: string) => Promise<void>;
  onBack?: () => void;
  onResendOtp?: () => Promise<void>;
}

export function EmailLoginForm({
  mode = 'email',
  onSubmit,
  onVerifyOtp,
  onBack,
  onResendOtp,
}: EmailLoginFormProps) {
  const [step, setStep] = useState<AuthStep>('input');
  const [value, setValue] = useState('');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);

  const otpRefs = useRef<(TextInput | null)[]>([]);
  const inputShake = useSharedValue(0);

  // Countdown timer for resend
  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [countdown]);

  const shakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: inputShake.value }],
  }));

  const triggerShake = () => {
    inputShake.value = withSequence(
      withTiming(-10, { duration: 50 }),
      withTiming(10, { duration: 50 }),
      withTiming(-10, { duration: 50 }),
      withTiming(10, { duration: 50 }),
      withTiming(0, { duration: 50 })
    );
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  };

  const validateInput = (): boolean => {
    if (mode === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        setError('Please enter a valid email address');
        triggerShake();
        return false;
      }
    } else {
      const phoneRegex = /^\+?[\d\s-]{10,}$/;
      if (!phoneRegex.test(value)) {
        setError('Please enter a valid phone number');
        triggerShake();
        return false;
      }
    }
    return true;
  };

  const handleSubmit = async () => {
    if (!value.trim()) {
      setError(`Please enter your ${mode === 'email' ? 'email' : 'phone number'}`);
      triggerShake();
      return;
    }

    if (!validateInput()) return;

    setLoading(true);
    setError(null);

    try {
      await onSubmit(value);
      setStep('otp');
      setCountdown(60);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      setError(err.message || 'Failed to send verification code');
      triggerShake();
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (index: number, digit: string) => {
    if (!/^\d*$/.test(digit)) return;

    const newOtp = [...otp];
    newOtp[index] = digit;
    setOtp(newOtp);

    // Auto-focus next input
    if (digit && index < 5) {
      otpRefs.current[index + 1]?.focus();
    }

    // Auto-submit when complete
    if (newOtp.every(d => d) && newOtp.join('').length === 6) {
      handleVerifyOtp(newOtp.join(''));
    }
  };

  const handleOtpKeyPress = (index: number, key: string) => {
    if (key === 'Backspace' && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  const handleVerifyOtp = async (code: string) => {
    setLoading(true);
    setError(null);

    try {
      await onVerifyOtp(code);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      setError(err.message || 'Invalid verification code');
      setOtp(['', '', '', '', '', '']);
      otpRefs.current[0]?.focus();
      triggerShake();
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (countdown > 0 || !onResendOtp) return;

    setLoading(true);
    try {
      await onResendOtp();
      setCountdown(60);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      setError(err.message || 'Failed to resend code');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      {/* Header */}
      <View style={styles.header}>
        {onBack && (
          <TouchableOpacity onPress={onBack} style={styles.backButton}>
            <Ionicons name="arrow-back" size={24} color={P01.cyan} />
          </TouchableOpacity>
        )}
        <View style={styles.headerText}>
          <Text style={styles.title}>
            {step === 'input'
              ? mode === 'email'
                ? 'Enter your email'
                : 'Enter your phone'
              : 'Verify your code'}
          </Text>
          <Text style={styles.subtitle}>
            {step === 'input'
              ? `We'll send you a verification code`
              : `Code sent to ${value}`}
          </Text>
        </View>
      </View>

      {step === 'input' ? (
        /* Email/Phone Input Step */
        <Animated.View
          entering={FadeInDown.duration(400)}
          style={styles.inputContainer}
        >
          <Animated.View style={shakeStyle}>
            <View style={[styles.inputWrapper, error && styles.inputError]}>
              <Ionicons
                name={mode === 'email' ? 'mail' : 'phone-portrait'}
                size={20}
                color={error ? P01.error : P01.cyan}
                style={styles.inputIcon}
              />
              <TextInput
                value={value}
                onChangeText={(text) => {
                  setValue(text);
                  setError(null);
                }}
                placeholder={mode === 'email' ? 'you@example.com' : '+1 234 567 8900'}
                placeholderTextColor={P01.textSecondary}
                keyboardType={mode === 'email' ? 'email-address' : 'phone-pad'}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                style={styles.input}
              />
            </View>
          </Animated.View>

          {error && (
            <Animated.Text
              entering={FadeIn}
              style={styles.errorText}
            >
              {error}
            </Animated.Text>
          )}

          <TouchableOpacity
            onPress={handleSubmit}
            disabled={loading}
            activeOpacity={0.8}
            style={[styles.submitButton, loading && styles.submitButtonDisabled]}
          >
            {loading ? (
              <ActivityIndicator color={P01.void} />
            ) : (
              <>
                <Text style={styles.submitButtonText}>CONTINUE</Text>
                <Ionicons name="arrow-forward" size={20} color={P01.void} />
              </>
            )}
          </TouchableOpacity>
        </Animated.View>
      ) : (
        /* OTP Verification Step */
        <Animated.View
          entering={FadeInDown.duration(400)}
          style={styles.otpContainer}
        >
          <Animated.View style={[styles.otpInputs, shakeStyle]}>
            {otp.map((digit, index) => (
              <TextInput
                key={index}
                ref={(ref: TextInput | null) => { otpRefs.current[index] = ref; }}
                value={digit}
                onChangeText={(text) => handleOtpChange(index, text)}
                onKeyPress={({ nativeEvent }) =>
                  handleOtpKeyPress(index, nativeEvent.key)
                }
                keyboardType="number-pad"
                maxLength={1}
                style={[
                  styles.otpInput,
                  digit && styles.otpInputFilled,
                  error && styles.otpInputError,
                ]}
                autoFocus={index === 0}
              />
            ))}
          </Animated.View>

          {error && (
            <Animated.Text
              entering={FadeIn}
              style={styles.errorText}
            >
              {error}
            </Animated.Text>
          )}

          <TouchableOpacity
            onPress={handleResend}
            disabled={countdown > 0 || loading}
            style={styles.resendButton}
          >
            <Text
              style={[
                styles.resendText,
                countdown > 0 && styles.resendTextDisabled,
              ]}
            >
              {countdown > 0
                ? `Resend code in ${countdown}s`
                : 'Resend code'}
            </Text>
          </TouchableOpacity>

          {loading && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color={P01.cyan} />
              <Text style={styles.loadingText}>Verifying...</Text>
            </View>
          )}
        </Animated.View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 32,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: P01.surface,
    borderWidth: 1,
    borderColor: P01.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  headerText: {
    flex: 1,
  },
  title: {
    color: P01.textPrimary,
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    color: P01.textSecondary,
    fontSize: 15,
  },
  inputContainer: {
    flex: 1,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: P01.surface,
    borderWidth: 1,
    borderColor: P01.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  inputError: {
    borderColor: P01.error,
  },
  inputIcon: {
    marginRight: 12,
  },
  input: {
    flex: 1,
    color: P01.textPrimary,
    fontSize: 16,
    paddingVertical: 16,
  },
  errorText: {
    color: P01.error,
    fontSize: 13,
    marginBottom: 16,
    marginLeft: 4,
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: P01.cyan,
    paddingVertical: 16,
    borderRadius: 12,
    gap: 8,
    shadowColor: P01.cyan,
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  submitButtonDisabled: {
    opacity: 0.7,
  },
  submitButtonText: {
    color: P01.void,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
  },
  otpContainer: {
    flex: 1,
    alignItems: 'center',
  },
  otpInputs: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 24,
  },
  otpInput: {
    width: 48,
    height: 56,
    backgroundColor: P01.surface,
    borderWidth: 1,
    borderColor: P01.border,
    borderRadius: 12,
    color: P01.textPrimary,
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
  },
  otpInputFilled: {
    borderColor: P01.cyan,
    backgroundColor: P01.cyanDim,
  },
  otpInputError: {
    borderColor: P01.error,
  },
  resendButton: {
    padding: 12,
  },
  resendText: {
    color: P01.cyan,
    fontSize: 14,
    fontWeight: '600',
  },
  resendTextDisabled: {
    color: P01.textSecondary,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10, 10, 12, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  loadingText: {
    color: P01.textPrimary,
    fontSize: 16,
    marginTop: 16,
  },
});

export default EmailLoginForm;
