/**
 * ProgressSteps — the checklist the wallet-creation screen ticks off.
 *
 * Colour literals replaced with tokens 2026-08-23; the shapes and the timing
 * are unchanged. The one visible change is the label face: step text was the
 * platform default at 16pt, so it did not match the body face anywhere else in
 * the app.
 */
import React, { useEffect } from 'react';
import { View, Text } from 'react-native';

import { Colors, Spacing, FontFamily, FontSize } from '../../constants/theme';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
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
}

const StepItem: React.FC<{ step: Step; index: number }> = ({ step }) => {
  const rotation = useSharedValue(0);
  const opacity = useSharedValue(step.status === 'pending' ? 0.4 : 1);

  useEffect(() => {
    if (step.status === 'in_progress') {
      rotation.value = 0;
      rotation.value = withRepeat(
        withTiming(360, { duration: 1000, easing: Easing.linear }),
        -1,
        false
      );
      opacity.value = 1;
    } else if (step.status === 'completed') {
      rotation.value = withTiming(0, { duration: 100 });
      opacity.value = withTiming(1, { duration: 300 });
    } else {
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
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: Colors.primary,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="checkmark" size={16} color={Colors.background} />
          </View>
        );
      case 'in_progress':
        return (
          <Animated.View style={spinStyle}>
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                borderWidth: 2,
                borderColor: Colors.primary,
                borderTopColor: 'transparent',
              }}
            />
          </Animated.View>
        );
      default:
        return (
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              borderWidth: 2,
              borderColor: Colors.border,
            }}
          />
        );
    }
  };

  return (
    <Animated.View
      style={[
        containerStyle,
        { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.md },
      ]}
    >
      {getIcon()}
      <Text
        style={{
          marginLeft: Spacing.lg,
          fontFamily: FontFamily.regular,
          fontSize: FontSize.md,
          color:
            step.status === 'completed'
              ? Colors.primary
              : step.status === 'in_progress'
              ? Colors.text
              : Colors.textTertiary,
        }}
      >
        {step.label}
      </Text>
    </Animated.View>
  );
};

export const ProgressSteps: React.FC<ProgressStepsProps> = ({ steps }) => {
  return (
    <View>
      {steps.map((step, index) => (
        <StepItem key={step.id} step={step} index={index} />
      ))}
    </View>
  );
};

export default ProgressSteps;
