import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card } from '../ui/Card';

type ExecutionStatus = 'pending' | 'executing' | 'success' | 'failed';

interface ExecutionStep {
  id: string;
  label: string;
  description?: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
}

interface ExecutionProgressProps {
  title?: string;
  status: ExecutionStatus;
  steps: ExecutionStep[];
  progress: number;
  estimatedTime?: string;
  txHash?: string;
  error?: string;
  className?: string;
}

const StepIndicator: React.FC<{ status: ExecutionStep['status'] }> = ({ status }) => {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (status === 'active') {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.3,
            duration: 600,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      animation.start();
      return () => animation.stop();
    }
  }, [status]);

  if (status === 'completed') {
    return (
      <View className="w-6 h-6 rounded-full bg-p01-cyan items-center justify-center">
        <Ionicons name="checkmark" size={14} color="#0a0a0c" />
      </View>
    );
  }

  if (status === 'failed') {
    return (
      <View className="w-6 h-6 rounded-full bg-red-500 items-center justify-center">
        <Ionicons name="close" size={14} color="#ffffff" />
      </View>
    );
  }

  if (status === 'active') {
    return (
      <Animated.View
        style={{ transform: [{ scale: pulseAnim }] }}
        className="w-6 h-6 rounded-full border-2 border-p01-cyan items-center justify-center"
      >
        <View className="w-2 h-2 rounded-full bg-p01-cyan" />
      </Animated.View>
    );
  }

  return (
    <View className="w-6 h-6 rounded-full border-2 border-p01-border items-center justify-center">
      <View className="w-2 h-2 rounded-full bg-p01-border" />
    </View>
  );
};

export const ExecutionProgress: React.FC<ExecutionProgressProps> = ({
  title = 'Executing Transaction',
  status,
  steps,
  progress,
  estimatedTime,
  txHash,
  error,
  className,
}) => {
  const progressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: progress,
      duration: 500,
      easing: Easing.out(Easing.ease),
      useNativeDriver: false,
    }).start();
  }, [progress]);

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  const statusConfig = {
    pending: { color: '#888892', icon: 'time-outline' as const },
    executing: { color: '#39c5bb', icon: 'flash' as const },
    success: { color: '#39c5bb', icon: 'checkmark-circle' as const },
    failed: { color: '#ef4444', icon: 'close-circle' as const },
  };

  const currentStatus = statusConfig[status];

  return (
    <Card
      variant="glass"
      padding="md"
      className={`my-2 ${className || ''}`}
      style={{
        borderWidth: 1,
        borderColor:
          status === 'executing'
            ? 'rgba(57, 197, 187, 0.3)'
            : status === 'failed'
            ? 'rgba(239, 68, 68, 0.3)'
            : 'rgba(42, 42, 48, 0.5)',
      }}
    >
      <View className="flex-row items-center justify-between mb-4">
        <View className="flex-row items-center">
          <View
            className="w-10 h-10 rounded-full items-center justify-center mr-3"
            style={{ backgroundColor: `${currentStatus.color}20` }}
          >
            <Ionicons name={currentStatus.icon} size={22} color={currentStatus.color} />
          </View>
          <View>
            <Text className="text-white font-semibold">{title}</Text>
            {estimatedTime && status === 'executing' && (
              <Text className="text-p01-text-secondary text-xs mt-0.5">
                Est. {estimatedTime} remaining
              </Text>
            )}
          </View>
        </View>
        <Text className="font-bold" style={{ color: currentStatus.color }}>
          {progress}%
        </Text>
      </View>

      <View className="h-2 bg-p01-surface rounded-full mb-4 overflow-hidden">
        <Animated.View
          style={{
            width: progressWidth,
            height: '100%',
            backgroundColor: currentStatus.color,
            borderRadius: 100,
          }}
        />
      </View>

      <View className="gap-3">
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1;

          return (
            <View key={step.id} className="flex-row items-start">
              <View className="items-center mr-3">
                <StepIndicator status={step.status} />
                {!isLast && (
                  <View
                    className="w-0.5 h-4 mt-1"
                    style={{
                      backgroundColor:
                        step.status === 'completed' ? '#39c5bb' : '#2a2a30',
                    }}
                  />
                )}
              </View>

              <View className="flex-1 pt-0.5">
                <Text
                  className={`
                    ${step.status === 'completed' ? 'text-white' : ''}
                    ${step.status === 'active' ? 'text-p01-cyan font-medium' : ''}
                    ${step.status === 'pending' ? 'text-p01-text-secondary' : ''}
                    ${step.status === 'failed' ? 'text-red-500' : ''}
                  `}
                >
                  {step.label}
                </Text>
                {step.description && (
                  <Text className="text-p01-text-secondary text-xs mt-0.5">
                    {step.description}
                  </Text>
                )}
              </View>
            </View>
          );
        })}
      </View>

      {txHash && (
        <View className="flex-row items-center mt-4 pt-4 border-t border-p01-border">
          <Ionicons name="link-outline" size={14} color="#888892" />
          <Text className="text-p01-text-secondary text-xs ml-2 font-mono">
            {txHash.slice(0, 8)}...{txHash.slice(-8)}
          </Text>
        </View>
      )}

      {error && (
        <View className="flex-row items-start mt-4 pt-4 border-t border-red-500/30">
          <Ionicons name="alert-circle" size={16} color="#ef4444" />
          <Text className="text-red-400 text-sm ml-2 flex-1">{error}</Text>
        </View>
      )}
    </Card>
  );
};

export default ExecutionProgress;
