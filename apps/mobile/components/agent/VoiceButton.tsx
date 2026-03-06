import React, { useEffect, useState } from 'react';
import { Pressable, View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import { Colors, FontSize, FontFamily } from '@/constants/theme';
import * as VoiceService from '@/services/ai/voiceService';

interface VoiceButtonProps {
  isRecording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  disabled?: boolean;
}

export const VoiceButton: React.FC<VoiceButtonProps> = ({
  isRecording,
  onStartRecording,
  onStopRecording,
  disabled = false,
}) => {
  const [duration, setDuration] = useState(0);
  const pulseScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(0);

  // Pulse animation when recording
  useEffect(() => {
    if (isRecording) {
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.3, { duration: 800 }),
          withTiming(1, { duration: 800 })
        ),
        -1,
        true
      );
      pulseOpacity.value = withRepeat(
        withSequence(
          withTiming(0.6, { duration: 800 }),
          withTiming(0.1, { duration: 800 })
        ),
        -1,
        true
      );
    } else {
      cancelAnimation(pulseScale);
      cancelAnimation(pulseOpacity);
      pulseScale.value = 1;
      pulseOpacity.value = 0;
      setDuration(0);
    }
  }, [isRecording]);

  // Duration timer
  useEffect(() => {
    if (!isRecording) return;
    const interval = setInterval(() => {
      setDuration(VoiceService.getRecordingDuration());
    }, 1000);
    return () => clearInterval(interval);
  }, [isRecording]);

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
    opacity: pulseOpacity.value,
  }));

  const formatDuration = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      {/* Pulse ring */}
      {isRecording && (
        <Animated.View
          style={[
            {
              position: 'absolute',
              width: 52,
              height: 52,
              borderRadius: 26,
              backgroundColor: Colors.error,
            },
            ringStyle,
          ]}
        />
      )}

      <Pressable
        onPressIn={() => {
          if (!disabled && !isRecording) onStartRecording();
        }}
        onPressOut={() => {
          if (isRecording) onStopRecording();
        }}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={isRecording ? 'Stop recording' : 'Start voice recording'}
        accessibilityHint={isRecording ? 'Release to stop recording' : 'Press and hold to record a voice message'}
        accessibilityState={{ disabled }}
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isRecording ? Colors.error : Colors.primaryDim,
        }}
      >
        <Ionicons
          name={isRecording ? 'mic' : 'mic-outline'}
          size={22}
          color={isRecording ? Colors.text : Colors.primaryMuted}
        />
      </Pressable>

      {/* Timer */}
      {isRecording && duration > 0 && (
        <Text
          style={{
            position: 'absolute',
            bottom: -18,
            color: Colors.error,
            fontSize: FontSize.xs,
            fontFamily: FontFamily.mono,
          }}
        >
          {formatDuration(duration)}
        </Text>
      )}
    </View>
  );
};

export default VoiceButton;
