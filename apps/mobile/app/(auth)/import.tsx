import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { importWallet, validateMnemonic } from '../../services/solana/wallet';

export default function ImportWalletScreen() {
  const router = useRouter();
  const [mnemonic, setMnemonic] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleImport = async () => {
    const normalizedMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    const words = normalizedMnemonic.split(' ').filter(w => w.length > 0);

    // Validate word count
    if (words.length !== 12 && words.length !== 24) {
      setError('Please enter a valid 12 or 24 word recovery phrase');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    // Validate mnemonic
    if (!validateMnemonic(normalizedMnemonic)) {
      setError('Invalid recovery phrase. Please check your words.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    setError(null);
    setIsLoading(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const walletInfo = await importWallet(normalizedMnemonic);

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Mark as onboarded and go to security setup
      await SecureStore.setItemAsync('p01_onboarded', 'true');

      Alert.alert(
        'Wallet Imported!',
        `Your wallet has been successfully imported.\n\nAddress: ${walletInfo.publicKey.slice(0, 8)}...${walletInfo.publicKey.slice(-8)}`,
        [
          {
            text: 'Set Up Security',
            onPress: () => router.replace('/(onboarding)/security'),
          },
        ]
      );
    } catch (err: any) {
      console.error('Import error:', err);
      setError(err.message || 'Failed to import wallet');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <Ionicons name="arrow-back" size={24} color="#ffffff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Import Wallet</Text>
          <View style={styles.backButton} />
        </View>

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Icon */}
          <Animated.View entering={FadeInDown.delay(100)} style={styles.iconContainer}>
            <View style={styles.iconCircle}>
              <Ionicons name="key-outline" size={40} color="#39c5bb" />
            </View>
          </Animated.View>

          {/* Title */}
          <Animated.View entering={FadeInDown.delay(200)} style={styles.titleContainer}>
            <Text style={styles.title}>Enter Recovery Phrase</Text>
            <Text style={styles.subtitle}>
              Enter your 12 or 24 word recovery phrase to restore your wallet
            </Text>
          </Animated.View>

          {/* Input */}
          <Animated.View entering={FadeInDown.delay(300)} style={styles.inputContainer}>
            <TextInput
              style={[styles.input, error && styles.inputError]}
              placeholder="Enter your recovery phrase..."
              placeholderTextColor="#555560"
              value={mnemonic}
              onChangeText={(text) => {
                setMnemonic(text);
                setError(null);
              }}
              multiline
              numberOfLines={4}
              autoCapitalize="none"
              autoCorrect={false}
              textAlignVertical="top"
            />
            {error && <Text style={styles.errorText}>{error}</Text>}
          </Animated.View>

          {/* Tips */}
          <Animated.View entering={FadeInDown.delay(400)} style={styles.tipsContainer}>
            <Text style={styles.tipsTitle}>Tips:</Text>
            <View style={styles.tipRow}>
              <Ionicons name="checkmark-circle" size={16} color="#39c5bb" />
              <Text style={styles.tipText}>Words should be separated by spaces</Text>
            </View>
            <View style={styles.tipRow}>
              <Ionicons name="checkmark-circle" size={16} color="#39c5bb" />
              <Text style={styles.tipText}>Check spelling carefully</Text>
            </View>
            <View style={styles.tipRow}>
              <Ionicons name="checkmark-circle" size={16} color="#39c5bb" />
              <Text style={styles.tipText}>Use lowercase letters only</Text>
            </View>
          </Animated.View>

          {/* Warning */}
          <Animated.View entering={FadeInDown.delay(500)} style={styles.warningContainer}>
            <Ionicons name="shield-checkmark" size={20} color="#39c5bb" />
            <Text style={styles.warningText}>
              Your recovery phrase is encrypted and stored securely on your device.
              We never have access to your keys.
            </Text>
          </Animated.View>
        </ScrollView>

        {/* Import Button */}
        <View style={styles.bottomSection}>
          <TouchableOpacity
            onPress={handleImport}
            disabled={!mnemonic.trim() || isLoading}
            style={[
              styles.importButton,
              (!mnemonic.trim() || isLoading) && styles.importButtonDisabled,
            ]}
          >
            {isLoading ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.importButtonText}>Import Wallet</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0c',
  },
  keyboardView: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#0f0f12',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  iconContainer: {
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 24,
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(0, 255, 136, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  titleContainer: {
    alignItems: 'center',
    marginBottom: 32,
  },
  title: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    color: '#888892',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  inputContainer: {
    marginBottom: 24,
  },
  input: {
    backgroundColor: '#0f0f12',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2a2a30',
    padding: 16,
    color: '#ffffff',
    fontSize: 16,
    minHeight: 120,
    lineHeight: 24,
  },
  inputError: {
    borderColor: '#ff4444',
  },
  errorText: {
    color: '#ff4444',
    fontSize: 13,
    marginTop: 8,
  },
  tipsContainer: {
    backgroundColor: '#0f0f12',
    borderRadius: 16,
    padding: 16,
    marginBottom: 24,
  },
  tipsTitle: {
    color: '#888892',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 12,
  },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  tipText: {
    color: '#888892',
    fontSize: 14,
  },
  warningContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(0, 255, 136, 0.1)',
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  warningText: {
    flex: 1,
    color: '#888892',
    fontSize: 13,
    lineHeight: 20,
  },
  bottomSection: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    paddingBottom: 32,
  },
  importButton: {
    backgroundColor: '#39c5bb',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  importButtonDisabled: {
    backgroundColor: '#333333',
  },
  importButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
