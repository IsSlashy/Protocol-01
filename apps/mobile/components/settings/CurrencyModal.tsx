import React from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Currency, CURRENCY_SYMBOLS } from '../../stores/settingsStore';

interface CurrencyModalProps {
  visible: boolean;
  currentCurrency: Currency;
  onSelect: (currency: Currency) => void;
  onClose: () => void;
}

const CURRENCIES: { code: Currency; name: string }[] = [
  { code: 'USD', name: 'US Dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British Pound' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'CHF', name: 'Swiss Franc' },
];

export const CurrencyModal: React.FC<CurrencyModalProps> = ({
  visible,
  currentCurrency,
  onSelect,
  onClose,
}) => {
  const handleSelect = (currency: Currency) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSelect(currency);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        className="flex-1 bg-black/70 justify-end"
        activeOpacity={1}
        onPress={onClose}
      >
        <TouchableOpacity activeOpacity={1}>
          <View className="bg-p01-surface rounded-t-3xl pb-8">
            {/* Header */}
            <View className="flex-row items-center justify-between px-5 py-4 border-b border-p01-border">
              <Text className="text-white text-lg font-semibold">Select Currency</Text>
              <TouchableOpacity
                onPress={onClose}
                className="w-8 h-8 rounded-full bg-p01-elevated items-center justify-center"
              >
                <Ionicons name="close" size={18} color="#888892" />
              </TouchableOpacity>
            </View>

            {/* Currency List */}
            <ScrollView className="max-h-96">
              {CURRENCIES.map((item) => {
                const isSelected = item.code === currentCurrency;
                return (
                  <TouchableOpacity
                    key={item.code}
                    className={`flex-row items-center justify-between px-5 py-4 ${
                      isSelected ? 'bg-p01-cyan/10' : ''
                    }`}
                    onPress={() => handleSelect(item.code)}
                    activeOpacity={0.7}
                  >
                    <View className="flex-row items-center">
                      <View
                        className={`w-10 h-10 rounded-full items-center justify-center mr-3 ${
                          isSelected ? 'bg-p01-cyan/20' : 'bg-p01-elevated'
                        }`}
                      >
                        <Text
                          className={`text-lg font-bold ${
                            isSelected ? 'text-p01-cyan' : 'text-white'
                          }`}
                        >
                          {CURRENCY_SYMBOLS[item.code]}
                        </Text>
                      </View>
                      <View>
                        <Text className={`text-base font-medium ${isSelected ? 'text-p01-cyan' : 'text-white'}`}>
                          {item.code}
                        </Text>
                        <Text className="text-p01-gray text-sm">{item.name}</Text>
                      </View>
                    </View>
                    {isSelected && (
                      <Ionicons name="checkmark-circle" size={24} color="#39c5bb" />
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

export default CurrencyModal;
