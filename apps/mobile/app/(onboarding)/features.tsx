import React, { useState, useRef, useMemo } from 'react';
import { View, Text, TouchableOpacity, Dimensions, FlatList } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  interpolate,
  withSpring,
  FadeIn,
  type SharedValue,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useT } from '@/i18n';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface Feature {
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  description: string;
  color: string;
}

const AnimatedFlatList = Animated.createAnimatedComponent(FlatList<Feature>);

export default function FeaturesScreen() {
  const t = useT();
  const router = useRouter();
  const scrollX = useSharedValue(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const flatListRef = useRef<FlatList<Feature>>(null);
  const FEATURES = useMemo(() => [
    {
      id: '1',
      icon: 'eye-off' as const,
      title: t('onboarding.stealthWallet'),
      subtitle: t('onboarding.invisibleTransfers'),
      description: t('onboarding.stealthWalletDesc'),
      color: '#39c5bb',
    },
    {
      id: '2',
      icon: 'water' as const,
      title: t('onboarding.privateStreams'),
      subtitle: t('onboarding.streamingPayments'),
      description: t('onboarding.privateStreamsDesc'),
      color: '#ff77a8',
    },
    {
      id: '3',
      icon: 'people' as const,
      title: t('onboarding.encryptedSocial'),
      subtitle: t('onboarding.privateContacts'),
      description: t('onboarding.encryptedSocialDesc'),
      color: '#3b82f6',
    },
    {
      id: '4',
      icon: 'hardware-chip' as const,
      title: t('onboarding.aiAgent'),
      subtitle: t('onboarding.yourAssistant'),
      description: t('onboarding.aiAgentDesc'),
      color: '#f97316',
    },
  ], [t]);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollX.value = event.contentOffset.x;
    },
  });

  const handleScroll = (event: any) => {
    const index = Math.round(event.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setCurrentIndex(index);
  };

  const handleSkip = () => {
    router.replace('/(onboarding)/create-wallet');
  };

  const handleNext = () => {
    if (currentIndex < FEATURES.length - 1) {
      flatListRef.current?.scrollToIndex({ index: currentIndex + 1, animated: true });
    } else {
      router.replace('/(onboarding)/create-wallet');
    }
  };

  const renderFeatureSlide = ({ item, index }: { item: Feature; index: number }) => {
    return <FeatureSlide feature={item} index={index} scrollX={scrollX} />;
  };

  return (
    <SafeAreaView className="flex-1 bg-[#0a0a0c]">
      {/* Skip Button */}
      <Animated.View entering={FadeIn.delay(300)} className="absolute top-16 right-6 z-10">
        <TouchableOpacity onPress={handleSkip} activeOpacity={0.7}>
          <Text className="text-[#a0a0a0] text-base font-medium">{t('onboarding.skip')}</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Feature Carousel */}
      <View className="flex-1 justify-center">
        <AnimatedFlatList
          ref={flatListRef}
          data={FEATURES}
          renderItem={renderFeatureSlide}
          keyExtractor={(item) => item.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={scrollHandler}
          onMomentumScrollEnd={handleScroll}
          scrollEventThrottle={16}
          bounces={false}
        />
      </View>

      {/* Bottom Section */}
      <View className="px-8 pb-8">
        {/* Dots Indicator */}
        <View className="flex-row justify-center items-center mb-8">
          {FEATURES.map((_, index) => (
            <PaginationDot
              key={index}
              index={index}
              scrollX={scrollX}
              color={FEATURES[index].color}
            />
          ))}
        </View>

        {/* Next/Continue Button */}
        <TouchableOpacity
          onPress={handleNext}
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
          <Text className="text-white text-lg font-bold">
            {currentIndex === FEATURES.length - 1 ? t('onboarding.continue') : t('onboarding.next')}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

interface FeatureSlideProps {
  feature: Feature;
  index: number;
  scrollX: SharedValue<number>;
}

function FeatureSlide({ feature, index, scrollX }: FeatureSlideProps) {
  const animatedStyle = useAnimatedStyle(() => {
    const inputRange = [
      (index - 1) * SCREEN_WIDTH,
      index * SCREEN_WIDTH,
      (index + 1) * SCREEN_WIDTH,
    ];

    const scale = interpolate(scrollX.value, inputRange, [0.8, 1, 0.8]);
    const opacity = interpolate(scrollX.value, inputRange, [0.4, 1, 0.4]);
    const translateY = interpolate(scrollX.value, inputRange, [30, 0, 30]);

    return {
      transform: [{ scale }, { translateY }],
      opacity,
    } as any;
  });

  return (
    <Animated.View
      style={[{ width: SCREEN_WIDTH }, animatedStyle as any]}
      className="flex-1 items-center justify-center px-8"
    >
      {/* Icon container with glow */}
      <View
        className="w-32 h-32 rounded-full items-center justify-center mb-10"
        style={{
          backgroundColor: `${feature.color}15`,
          borderWidth: 2,
          borderColor: `${feature.color}40`,
          shadowColor: feature.color,
          shadowOpacity: 0.4,
          shadowRadius: 30,
          shadowOffset: { width: 0, height: 0 },
          elevation: 10,
        }}
      >
        <Ionicons name={feature.icon} size={56} color={feature.color} />
      </View>

      {/* Title */}
      <Text
        className="text-3xl font-bold text-white text-center mb-2"
        style={{
          textShadowColor: feature.color,
          textShadowOffset: { width: 0, height: 0 },
          textShadowRadius: 15,
        }}
      >
        {feature.title}
      </Text>

      {/* Subtitle */}
      <Text
        className="text-lg font-medium text-center mb-4"
        style={{ color: feature.color }}
      >
        {feature.subtitle}
      </Text>

      {/* Description */}
      <Text className="text-base text-[#a0a0a0] text-center leading-6 px-4">
        {feature.description}
      </Text>
    </Animated.View>
  );
}

interface PaginationDotProps {
  index: number;
  scrollX: SharedValue<number>;
  color: string;
}

function PaginationDot({ index, scrollX, color }: PaginationDotProps) {
  const animatedStyle = useAnimatedStyle(() => {
    const inputRange = [
      (index - 1) * SCREEN_WIDTH,
      index * SCREEN_WIDTH,
      (index + 1) * SCREEN_WIDTH,
    ];

    const width = interpolate(scrollX.value, inputRange, [8, 24, 8]);
    const opacity = interpolate(scrollX.value, inputRange, [0.3, 1, 0.3]);

    return {
      width,
      opacity,
      backgroundColor: color,
    };
  });

  return (
    <Animated.View
      style={animatedStyle as any}
      className="h-2 rounded-full mx-1"
    />
  );
}
