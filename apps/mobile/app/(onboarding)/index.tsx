import React from 'react';
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

export default function WelcomeScreen() {
  const router = useRouter();

  const handleGetStarted = () => {
    router.replace('/(onboarding)/features');
  };

  const handleImportWallet = () => {
    // Navigate to import wallet flow
    router.replace('/(auth)/import');
  };

  return (
    <SafeAreaView className="flex-1 bg-[#0a0a0c]">
      {/* Background gradient overlay */}
      <LinearGradient
        colors={['rgba(57,197,187,0.03)', 'transparent', 'rgba(57,197,187,0.02)']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        className="absolute inset-0"
      />

      <View className="flex-1 justify-center items-center px-8">
        {/* Logo Section */}
        <Animated.View
          entering={FadeIn.delay(300).duration(800)}
          className="items-center mb-8"
        >
          <Logo size={140} showText={true} animated={true} />
        </Animated.View>

        {/* Tagline - ULTRAKILL style */}
        <Animated.View
          entering={FadeInUp.delay(600).duration(600)}
          className="mt-6 items-center"
        >
          <Text className="text-[#ff2d7a] text-xs font-bold tracking-[6px] mb-2">
            [ SYSTEM STATUS ]
          </Text>
          <Text className="text-white text-2xl font-black tracking-wider text-center">
            UNTRACEABLE
          </Text>
          <View className="flex-row items-center mt-2">
            <View className="w-2 h-2 bg-[#39c5bb] mr-2" />
            <Text className="text-[#555560] text-xs tracking-[4px] font-mono">
              READY
            </Text>
          </View>
        </Animated.View>
      </View>

      {/* Bottom Section */}
      <View className="px-8 pb-8">
        {/* Get Started Button */}
        <Animated.View entering={FadeInDown.delay(900).duration(600)}>
          <TouchableOpacity
            onPress={handleGetStarted}
            activeOpacity={0.8}
            className="bg-[#39c5bb] py-4 rounded-xl items-center"
            style={{
              shadowColor: '#39c5bb',
              shadowOpacity: 0.4,
              shadowRadius: 20,
              shadowOffset: { width: 0, height: 4 },
              elevation: 8,
            }}
          >
            <Text className="text-white text-lg font-bold tracking-wide">
              GET STARTED
            </Text>
          </TouchableOpacity>
        </Animated.View>

        {/* Import Wallet Link */}
        <Animated.View
          entering={FadeInDown.delay(1100).duration(600)}
          className="mt-6 items-center"
        >
          <TouchableOpacity onPress={handleImportWallet} activeOpacity={0.7}>
            <Text className="text-[#a0a0a0] text-base">
              Already have a wallet?{' '}
              <Text className="text-[#39c5bb] font-medium">Import</Text>
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}
