import React from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Spacing, P01Colors } from '@/constants/theme';
import PrivacyActionButton from './PrivacyActionButton';

interface ShieldedActionsProps {
  shieldedBalance: number;
  isLoadingProver: boolean;
  onShield: () => void;
  onUnshield: () => void;
  onTransfer: () => void;
  onRecover: () => void;
}

export default function ShieldedActions({
  shieldedBalance,
  isLoadingProver,
  onShield,
  onUnshield,
  onTransfer,
  onRecover,
}: ShieldedActionsProps) {
  return (
    <Animated.View entering={FadeInDown.delay(200)} style={styles.container}>
      <PrivacyActionButton
        icon="arrow-down"
        label="Shield"
        color={P01Colors.cyan}
        dimColor={P01Colors.cyanDim}
        onPress={onShield}
      />
      <PrivacyActionButton
        icon="arrow-up"
        label="Unshield"
        color={P01Colors.pink}
        dimColor={P01Colors.pinkDim}
        onPress={onUnshield}
        disabled={shieldedBalance <= 0}
        loading={isLoadingProver}
      />
      <PrivacyActionButton
        icon="flash"
        label="Transfer"
        color={P01Colors.blue}
        dimColor={P01Colors.blueDim}
        onPress={onTransfer}
        disabled={shieldedBalance <= 0}
        loading={isLoadingProver}
      />
      <PrivacyActionButton
        icon="scan"
        label="Recover"
        color={P01Colors.green}
        dimColor={P01Colors.greenDim}
        onPress={onRecover}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    marginVertical: Spacing.lg,
  },
});
