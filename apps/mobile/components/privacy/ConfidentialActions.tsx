import React from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Spacing, P01Colors } from '@/constants/theme';
import PrivacyActionButton from './PrivacyActionButton';

interface ConfidentialActionsProps {
  confidentialBalance: number;
  onDeposit: () => void;
  onWithdraw: () => void;
  onTransfer: () => void;
}

export default function ConfidentialActions({
  confidentialBalance,
  onDeposit,
  onWithdraw,
  onTransfer,
}: ConfidentialActionsProps) {
  return (
    <Animated.View entering={FadeInDown.delay(200)} style={styles.container}>
      <PrivacyActionButton
        icon="arrow-down"
        label="Deposit"
        color={P01Colors.cyan}
        dimColor={P01Colors.cyanDim}
        onPress={onDeposit}
      />
      <PrivacyActionButton
        icon="arrow-up"
        label="Withdraw"
        color={P01Colors.pink}
        dimColor={P01Colors.pinkDim}
        onPress={onWithdraw}
        disabled={confidentialBalance <= 0}
      />
      <PrivacyActionButton
        icon="flash"
        label="Transfer"
        color={P01Colors.blue}
        dimColor={P01Colors.blueDim}
        onPress={onTransfer}
        disabled={confidentialBalance <= 0}
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
