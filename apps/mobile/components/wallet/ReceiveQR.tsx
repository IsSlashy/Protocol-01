import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Share } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Toast } from '../ui/Toast';

interface ReceiveQRProps {
  address: string;
  networkName?: string;
  onRequestAmount?: () => void;
}

export const ReceiveQR: React.FC<ReceiveQRProps> = ({
  address,
  networkName = 'Aztec Network',
  onRequestAmount,
}) => {
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');

  const formatAddress = (addr: string): string => {
    if (addr.length <= 20) return addr;
    return `${addr.slice(0, 10)}...${addr.slice(-10)}`;
  };

  const handleCopy = async () => {
    await Clipboard.setStringAsync(address);
    setToastMessage('Address copied to clipboard');
    setShowToast(true);
  };

  const handleShare = async () => {
    try {
      await Share.share({
        message: `My ${networkName} address: ${address}`,
      });
    } catch (error) {
      console.error('Error sharing:', error);
    }
  };

  return (
    <View className="flex-1 items-center px-4">
      <Card variant="glass" padding="lg" className="w-full items-center mb-6">
        <View className="flex-row items-center mb-4">
          <View className="w-2 h-2 rounded-full bg-p01-cyan mr-2" />
          <Text className="text-p01-text-secondary text-sm">
            {networkName}
          </Text>
        </View>

        <View
          className="p-4 bg-white rounded-2xl mb-6"
          style={{
            shadowColor: '#39c5bb',
            shadowOpacity: 0.2,
            shadowRadius: 20,
            shadowOffset: { width: 0, height: 0 },
            elevation: 10,
          }}
        >
          <QRCode
            value={address}
            size={200}
            backgroundColor="white"
            color="#0a0a0c"
            logo={require('../../assets/p01-logo.png')}
            logoSize={40}
            logoBackgroundColor="white"
            logoMargin={5}
            logoBorderRadius={10}
          />
        </View>

        <Text className="text-p01-text-secondary text-sm mb-2">
          Your Wallet Address
        </Text>

        <TouchableOpacity
          onPress={handleCopy}
          className="flex-row items-center bg-p01-surface px-4 py-3 rounded-xl"
          activeOpacity={0.7}
        >
          <Text className="text-white font-mono text-sm mr-2">
            {formatAddress(address)}
          </Text>
          <Ionicons name="copy-outline" size={18} color="#39c5bb" />
        </TouchableOpacity>
      </Card>

      <View className="w-full flex-row gap-3 mb-6">
        <Button
          variant="secondary"
          size="md"
          className="flex-1"
          icon={<Ionicons name="copy-outline" size={18} color="#39c5bb" />}
          onPress={handleCopy}
        >
          Copy
        </Button>
        <Button
          variant="secondary"
          size="md"
          className="flex-1"
          icon={<Ionicons name="share-outline" size={18} color="#39c5bb" />}
          onPress={handleShare}
        >
          Share
        </Button>
      </View>

      {onRequestAmount && (
        <TouchableOpacity
          onPress={onRequestAmount}
          className="flex-row items-center"
        >
          <Ionicons name="add-circle-outline" size={20} color="#39c5bb" />
          <Text className="text-p01-cyan font-medium ml-2">
            Request specific amount
          </Text>
        </TouchableOpacity>
      )}

      <Card variant="outlined" padding="md" className="w-full mt-6">
        <View className="flex-row items-start">
          <Ionicons name="shield-checkmark" size={20} color="#39c5bb" />
          <View className="flex-1 ml-3">
            <Text className="text-white font-medium mb-1">
              Privacy Protected
            </Text>
            <Text className="text-p01-text-secondary text-sm">
              Transactions to this address are shielded by default. Your balance
              and transaction history remain private.
            </Text>
          </View>
        </View>
      </Card>

      <Toast
        visible={showToast}
        type="success"
        title="Copied!"
        message={toastMessage}
        onDismiss={() => setShowToast(false)}
        duration={2000}
      />
    </View>
  );
};

export default ReceiveQR;
