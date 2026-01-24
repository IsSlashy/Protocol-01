import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Button } from '@/components/ui/Button';
import {
  AuthQRPayload,
  authenticateWithService,
  checkSubscription,
  SubscriptionStatus,
} from '@/services/auth/p01Auth';
import { getPublicKey } from '@/services/solana/wallet';

type AuthState = 'loading' | 'ready' | 'authenticating' | 'success' | 'error';

export default function AuthConfirmScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    payload: string;
    serviceName: string;
    serviceLogo?: string;
    requiresSubscription: string;
    isExpired: string;
  }>();

  const [state, setState] = useState<AuthState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(null);

  // Parse payload
  const payload: AuthQRPayload | null = params.payload
    ? JSON.parse(params.payload)
    : null;
  const serviceName = params.serviceName || 'Service';
  const serviceLogo = params.serviceLogo;
  const requiresSubscription = params.requiresSubscription === '1';
  const isExpired = params.isExpired === '1';

  // Load initial data
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      // Get wallet address
      const wallet = await getPublicKey();
      setWalletAddress(wallet);

      // Check subscription if required
      if (requiresSubscription && payload?.mint) {
        const status = await checkSubscription(payload.mint);
        setSubscription(status);
      }

      setState('ready');
    } catch (err) {
      console.error('[AuthConfirm] Load error:', err);
      setState('error');
      setError('Erreur de chargement');
    }
  };

  const handleConfirm = async () => {
    if (!payload) {
      setError('Données invalides');
      return;
    }

    setState('authenticating');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const result = await authenticateWithService({
        payload,
        isExpired,
        requiresSubscription,
        serviceName,
        serviceLogo,
      });

      if (result.success) {
        setState('success');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        // Auto-close after success
        setTimeout(() => {
          router.back();
        }, 2000);
      } else {
        setState('error');
        setError(result.error || 'Authentification échouée');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } catch (err: any) {
      setState('error');
      setError(err.message || 'Erreur inattendue');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const handleCancel = () => {
    router.back();
  };

  // Session expired
  if (isExpired) {
    return (
      <SafeAreaView className="flex-1 bg-p01-void">
        <View className="flex-1 items-center justify-center px-6">
          <View className="w-20 h-20 bg-red-500/20 rounded-full items-center justify-center mb-6">
            <Ionicons name="time-outline" size={40} color="#ef4444" />
          </View>
          <Text className="text-white text-xl font-bold mb-2">
            Session Expirée
          </Text>
          <Text className="text-p01-text-muted text-center mb-8">
            Cette demande de connexion a expiré. Veuillez scanner un nouveau QR code.
          </Text>
          <Button onPress={handleCancel} variant="outline" fullWidth>
            Retour
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  // Loading state
  if (state === 'loading') {
    return (
      <SafeAreaView className="flex-1 bg-p01-void items-center justify-center">
        <ActivityIndicator size="large" color="#39c5bb" />
        <Text className="text-white mt-4">Chargement...</Text>
      </SafeAreaView>
    );
  }

  // Success state
  if (state === 'success') {
    return (
      <SafeAreaView className="flex-1 bg-p01-void">
        <View className="flex-1 items-center justify-center px-6">
          <LinearGradient
            colors={['#39c5bb', '#00ffe5']}
            className="w-24 h-24 rounded-full items-center justify-center mb-6"
          >
            <Ionicons name="checkmark" size={48} color="#0a0a0a" />
          </LinearGradient>
          <Text className="text-white text-2xl font-bold mb-2">
            Connecté !
          </Text>
          <Text className="text-p01-text-muted text-center">
            Vous êtes maintenant connecté à {serviceName}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // Error state
  if (state === 'error') {
    return (
      <SafeAreaView className="flex-1 bg-p01-void">
        <View className="flex-row items-center justify-between px-5 py-4">
          <TouchableOpacity
            onPress={handleCancel}
            className="w-10 h-10 bg-p01-surface rounded-full items-center justify-center"
          >
            <Ionicons name="close" size={24} color="#ffffff" />
          </TouchableOpacity>
          <Text className="text-white text-lg font-semibold">Erreur</Text>
          <View className="w-10" />
        </View>

        <View className="flex-1 items-center justify-center px-6">
          <View className="w-20 h-20 bg-red-500/20 rounded-full items-center justify-center mb-6">
            <Ionicons name="alert-circle" size={40} color="#ef4444" />
          </View>
          <Text className="text-white text-xl font-bold mb-2">
            Échec de connexion
          </Text>
          <Text className="text-p01-text-muted text-center mb-8">
            {error}
          </Text>
          <View className="w-full gap-3">
            <Button onPress={loadData} fullWidth>
              Réessayer
            </Button>
            <Button onPress={handleCancel} variant="outline" fullWidth>
              Annuler
            </Button>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // Ready state - show confirmation UI
  return (
    <SafeAreaView className="flex-1 bg-p01-void">
      {/* Header */}
      <View className="flex-row items-center justify-between px-5 py-4">
        <TouchableOpacity
          onPress={handleCancel}
          className="w-10 h-10 bg-p01-surface rounded-full items-center justify-center"
        >
          <Ionicons name="close" size={24} color="#ffffff" />
        </TouchableOpacity>
        <Text className="text-white text-lg font-semibold">
          Connexion
        </Text>
        <View className="w-10" />
      </View>

      {/* Content */}
      <View className="flex-1 px-6 pt-8">
        {/* Service Info */}
        <View className="items-center mb-8">
          {serviceLogo ? (
            <Image
              source={{ uri: serviceLogo }}
              className="w-20 h-20 rounded-2xl mb-4"
              resizeMode="cover"
            />
          ) : (
            <LinearGradient
              colors={['#39c5bb', '#ff77a8']}
              className="w-20 h-20 rounded-2xl items-center justify-center mb-4"
            >
              <Ionicons name="apps" size={36} color="#ffffff" />
            </LinearGradient>
          )}
          <Text className="text-white text-2xl font-bold mb-2">
            {serviceName}
          </Text>
          <Text className="text-p01-text-muted text-center">
            souhaite accéder à votre compte
          </Text>
        </View>

        {/* Wallet Info */}
        <View className="bg-p01-surface rounded-2xl p-5 mb-4">
          <View className="flex-row items-center mb-3">
            <View className="w-10 h-10 bg-p01-cyan/20 rounded-full items-center justify-center mr-3">
              <Ionicons name="wallet-outline" size={20} color="#39c5bb" />
            </View>
            <View className="flex-1">
              <Text className="text-p01-text-muted text-xs mb-1">WALLET</Text>
              <Text className="text-white font-mono text-sm">
                {walletAddress
                  ? `${walletAddress.slice(0, 8)}...${walletAddress.slice(-8)}`
                  : 'Loading...'}
              </Text>
            </View>
          </View>
        </View>

        {/* Subscription Status */}
        {requiresSubscription && (
          <View className="bg-p01-surface rounded-2xl p-5 mb-4">
            <View className="flex-row items-center">
              <View
                className={`w-10 h-10 rounded-full items-center justify-center mr-3 ${
                  subscription?.active ? 'bg-green-500/20' : 'bg-red-500/20'
                }`}
              >
                <Ionicons
                  name={subscription?.active ? 'checkmark-circle' : 'close-circle'}
                  size={20}
                  color={subscription?.active ? '#22c55e' : '#ef4444'}
                />
              </View>
              <View className="flex-1">
                <Text className="text-p01-text-muted text-xs mb-1">
                  ABONNEMENT
                </Text>
                <Text
                  className={`font-semibold ${
                    subscription?.active ? 'text-green-500' : 'text-red-500'
                  }`}
                >
                  {subscription?.active ? 'Actif' : 'Non actif'}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Permissions */}
        <View className="bg-p01-surface rounded-2xl p-5">
          <Text className="text-p01-text-muted text-xs mb-3">
            CETTE APPLICATION POURRA :
          </Text>
          <View className="gap-3">
            <View className="flex-row items-center">
              <Ionicons
                name="finger-print-outline"
                size={18}
                color="#39c5bb"
                style={{ marginRight: 12 }}
              />
              <Text className="text-white flex-1">
                Vérifier votre identité wallet
              </Text>
            </View>
            {requiresSubscription && (
              <View className="flex-row items-center">
                <Ionicons
                  name="card-outline"
                  size={18}
                  color="#39c5bb"
                  style={{ marginRight: 12 }}
                />
                <Text className="text-white flex-1">
                  Vérifier votre statut d'abonnement
                </Text>
              </View>
            )}
          </View>
        </View>
      </View>

      {/* Bottom Actions */}
      <View className="px-6 pb-6 gap-3">
        {state === 'authenticating' ? (
          <View className="bg-p01-cyan rounded-xl py-4 items-center flex-row justify-center">
            <ActivityIndicator color="#0a0a0a" style={{ marginRight: 8 }} />
            <Text className="text-p01-void font-semibold">
              Authentification...
            </Text>
          </View>
        ) : (
          <>
            <Button
              onPress={handleConfirm}
              fullWidth
              size="lg"
              disabled={requiresSubscription && !subscription?.active}
            >
              <View className="flex-row items-center">
                <Ionicons
                  name="finger-print"
                  size={20}
                  color="#0a0a0a"
                  style={{ marginRight: 8 }}
                />
                <Text className="text-p01-void font-semibold text-lg">
                  Confirmer avec Biométrie
                </Text>
              </View>
            </Button>
            <TouchableOpacity
              onPress={handleCancel}
              className="py-3 items-center"
            >
              <Text className="text-p01-text-muted">Annuler</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
