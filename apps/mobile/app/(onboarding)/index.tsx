import React, { useEffect } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Logo } from '../../components/onboarding';
import { useAuth } from '@/providers/PrivyProvider';

export default function WelcomeScreen() {
  const router = useRouter();
  const { isReady, isAuthenticated, hasWallet } = useAuth();

  // Redirect if already authenticated with wallet
  useEffect(() => {
    if (isReady && isAuthenticated && hasWallet) {
      try {
        router.replace('/(main)/(wallet)');
      } catch (err) {
        console.error('[Onboarding] Navigation error:', err);
      }
    }
  }, [isReady, isAuthenticated, hasWallet, router]);

  const handleGetStarted = () => {
    router.replace('/(auth)/login');
  };

  const handleImportWallet = () => {
    router.replace('/(auth)/import');
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#0a0a0c' }}>
      <LinearGradient
        colors={['rgba(57,197,187,0.03)', 'transparent', 'rgba(57,197,187,0.02)']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />

      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 }}>
        <Animated.View entering={FadeIn.delay(300).duration(800)} style={{ alignItems: 'center', marginBottom: 32 }}>
          <Logo size={140} showText={true} animated={true} />
        </Animated.View>

        <Animated.View entering={FadeInUp.delay(600).duration(600)} style={{ marginTop: 24, alignItems: 'center' }}>
          <Text style={{ color: '#ff2d7a', fontSize: 12, fontWeight: 'bold', letterSpacing: 6, marginBottom: 8 }}>
            [ SYSTEM STATUS ]
          </Text>
          <Text style={{ color: 'white', fontSize: 24, fontWeight: '900', letterSpacing: 2, textAlign: 'center' }}>
            UNTRACEABLE
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
            <View style={{ width: 8, height: 8, backgroundColor: '#39c5bb', marginRight: 8 }} />
            <Text style={{ color: '#555560', fontSize: 12, letterSpacing: 4 }}>
              READY
            </Text>
          </View>
        </Animated.View>
      </View>

      <View style={{ paddingHorizontal: 32, paddingBottom: 32 }}>
        <Animated.View entering={FadeInDown.delay(900).duration(600)}>
          <TouchableOpacity
            onPress={handleGetStarted}
            activeOpacity={0.8}
            style={{
              backgroundColor: '#39c5bb',
              paddingVertical: 16,
              borderRadius: 12,
              alignItems: 'center',
              elevation: 8,
            }}
          >
            <Text style={{ color: 'white', fontSize: 18, fontWeight: 'bold', letterSpacing: 1 }}>
              GET STARTED
            </Text>
          </TouchableOpacity>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(1100).duration(600)} style={{ marginTop: 24, alignItems: 'center' }}>
          <TouchableOpacity onPress={handleImportWallet} activeOpacity={0.7}>
            <Text style={{ color: '#a0a0a0', fontSize: 16 }}>
              Already have a wallet?{' '}
              <Text style={{ color: '#39c5bb', fontWeight: '500' }}>Import</Text>
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}
