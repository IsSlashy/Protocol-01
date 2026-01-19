import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  withSequence,
} from 'react-native-reanimated';

type AgentAvatarSize = 'sm' | 'md' | 'lg' | 'xl';

interface AgentAvatarProps {
  size?: AgentAvatarSize;
  isActive?: boolean;
  className?: string;
}

const sizeConfig: Record<AgentAvatarSize, { container: number; icon: number; glow: number; ring: number }> = {
  sm: { container: 36, icon: 18, glow: 6, ring: 2 },
  md: { container: 52, icon: 24, glow: 10, ring: 2 },
  lg: { container: 72, icon: 32, glow: 14, ring: 3 },
  xl: { container: 100, icon: 44, glow: 20, ring: 3 },
};

export const AgentAvatar: React.FC<AgentAvatarProps> = ({
  size = 'md',
  isActive = true,
  className,
}) => {
  const config = sizeConfig[size];
  const pulseValue = useSharedValue(1);
  const glowOpacity = useSharedValue(0.3);
  const rotateValue = useSharedValue(0);

  useEffect(() => {
    if (isActive) {
      // Subtle pulse animation
      pulseValue.value = withRepeat(
        withSequence(
          withTiming(1.03, { duration: 2000 }),
          withTiming(1, { duration: 2000 })
        ),
        -1,
        true
      );

      // Glow animation
      glowOpacity.value = withRepeat(
        withSequence(
          withTiming(0.5, { duration: 2000 }),
          withTiming(0.2, { duration: 2000 })
        ),
        -1,
        true
      );
    }
  }, [isActive]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseValue.value }],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  return (
    <View className={`items-center justify-center ${className || ''}`}>
      {/* Outer glow ring */}
      {isActive && (
        <Animated.View
          style={[
            {
              position: 'absolute',
              width: config.container + config.glow * 2,
              height: config.container + config.glow * 2,
              borderRadius: (config.container + config.glow * 2) / 2,
            },
            glowStyle,
          ]}
        >
          <LinearGradient
            colors={['#39c5bb', '#ff77a8']}
            style={{
              width: '100%',
              height: '100%',
              borderRadius: (config.container + config.glow * 2) / 2,
            }}
          />
        </Animated.View>
      )}

      {/* Main avatar container */}
      <Animated.View
        style={[
          {
            width: config.container,
            height: config.container,
            borderRadius: config.container / 2,
            overflow: 'hidden',
          },
          isActive ? animatedStyle : undefined,
        ]}
      >
        <LinearGradient
          colors={isActive ? ['#151518', '#0a0a0c'] : ['#151518', '#151518']}
          style={{
            width: '100%',
            height: '100%',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: config.container / 2,
            borderWidth: config.ring,
            borderColor: isActive ? '#39c5bb' : '#2a2a30',
          }}
        >
          {/* AI Icon */}
          <Ionicons
            name="sparkles"
            size={config.icon}
            color={isActive ? '#39c5bb' : '#555560'}
          />
        </LinearGradient>
      </Animated.View>

      {/* Status indicator */}
      <View
        style={{
          position: 'absolute',
          bottom: -2,
          right: -2,
          width: config.container * 0.28,
          height: config.container * 0.28,
          borderRadius: config.container * 0.14,
          backgroundColor: isActive ? '#22c55e' : '#555560',
          borderWidth: 2,
          borderColor: '#0a0a0c',
        }}
      />
    </View>
  );
};

export default AgentAvatar;
