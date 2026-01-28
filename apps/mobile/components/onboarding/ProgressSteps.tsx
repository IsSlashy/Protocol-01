import React, { useEffect } from 'react';
import { View, Text } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

export type StepStatus = 'pending' | 'in_progress' | 'completed';

export interface Step {
  id: string;
  label: string;
  status: StepStatus;
}

interface ProgressStepsProps {
  steps: Step[];
  className?: string;
}

const StepItem: React.FC<{ step: Step; index: number }> = ({ step, index }) => {
  const rotation = useSharedValue(0);
  const opacity = useSharedValue(step.status === 'pending' ? 0.4 : 1);

  useEffect(() => {
    if (step.status === 'in_progress') {
      // Start spinner animation
      rotation.value = 0; // Reset first
      rotation.value = withRepeat(
        withTiming(360, { duration: 1000, easing: Easing.linear }),
        -1,
        false
      );
      opacity.value = 1;
    } else if (step.status === 'completed') {
      // Stop animation immediately
      rotation.value = withTiming(0, { duration: 100 });
      opacity.value = withTiming(1, { duration: 300 });
    } else {
      // Pending state
      rotation.value = withTiming(0, { duration: 100 });
      opacity.value = withTiming(0.4, { duration: 300 });
    }
  }, [step.status]);

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const containerStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const getIcon = () => {
    switch (step.status) {
      case 'completed':
        return (
          <View className="w-6 h-6 rounded-full bg-[#39c5bb] items-center justify-center">
            <Ionicons name="checkmark" size={16} color="#0a0a0c" />
          </View>
        );
      case 'in_progress':
        return (
          <Animated.View style={spinStyle}>
            <View className="w-6 h-6 rounded-full border-2 border-[#39c5bb] border-t-transparent" />
          </Animated.View>
        );
      default:
        return (
          <View className="w-6 h-6 rounded-full border-2 border-[#2a2a30]" />
        );
    }
  };

  return (
    <Animated.View
      style={containerStyle}
      className="flex-row items-center py-3"
    >
      {getIcon()}
      <Text
        className={`ml-4 text-base ${
          step.status === 'completed'
            ? 'text-[#39c5bb]'
            : step.status === 'in_progress'
            ? 'text-white'
            : 'text-[#555560]'
        }`}
      >
        {step.label}
      </Text>
    </Animated.View>
  );
};

export const ProgressSteps: React.FC<ProgressStepsProps> = ({ steps, className }) => {
  return (
    <View className={`${className || ''}`}>
      {steps.map((step, index) => (
        <StepItem key={step.id} step={step} index={index} />
      ))}
    </View>
  );
};

export default ProgressSteps;
