import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card } from '../ui/Card';

type PrivacyLevel = 'standard' | 'enhanced' | 'maximum';

interface PrivacyOption {
  level: PrivacyLevel;
  title: string;
  description: string;
  features: string[];
  icon: keyof typeof Ionicons.glyphMap;
  fee: string;
}

interface PrivacySelectorProps {
  selected: PrivacyLevel;
  onSelect: (level: PrivacyLevel) => void;
}

const privacyOptions: PrivacyOption[] = [
  {
    level: 'standard',
    title: 'Standard',
    description: 'Basic privacy for everyday transactions',
    features: ['Encrypted amounts', 'Hidden balances'],
    icon: 'shield-outline',
    fee: '~0.001',
  },
  {
    level: 'enhanced',
    title: 'Enhanced',
    description: 'Additional privacy with mixing',
    features: ['Encrypted amounts', 'Hidden balances', 'Transaction mixing', 'Delayed execution'],
    icon: 'shield-half-outline',
    fee: '~0.005',
  },
  {
    level: 'maximum',
    title: 'Maximum',
    description: 'Full privacy with zero-knowledge proofs',
    features: [
      'Full ZK encryption',
      'Hidden sender/receiver',
      'Multi-hop routing',
      'Decoy transactions',
    ],
    icon: 'shield-checkmark',
    fee: '~0.01',
  },
];

export const PrivacySelector: React.FC<PrivacySelectorProps> = ({
  selected,
  onSelect,
}) => {
  return (
    <View className="px-4">
      <View className="flex-row items-center mb-4">
        <Ionicons name="lock-closed" size={20} color="#39c5bb" />
        <Text className="text-white font-semibold text-lg ml-2">
          Privacy Level
        </Text>
      </View>

      <View className="gap-3">
        {privacyOptions.map((option) => {
          const isSelected = selected === option.level;

          return (
            <TouchableOpacity
              key={option.level}
              onPress={() => onSelect(option.level)}
              activeOpacity={0.7}
            >
              <Card
                variant={isSelected ? 'glass' : 'outlined'}
                padding="md"
                className={isSelected ? 'border border-p01-cyan' : ''}
                style={
                  isSelected
                    ? {
                        shadowColor: '#39c5bb',
                        shadowOpacity: 0.2,
                        shadowRadius: 10,
                        shadowOffset: { width: 0, height: 0 },
                        elevation: 6,
                      }
                    : undefined
                }
              >
                <View className="flex-row items-start">
                  <View
                    className={`
                      w-12 h-12 rounded-full items-center justify-center
                      ${isSelected ? 'bg-p01-cyan/20' : 'bg-p01-surface'}
                    `}
                  >
                    <Ionicons
                      name={option.icon}
                      size={24}
                      color={isSelected ? '#39c5bb' : '#888892'}
                    />
                  </View>

                  <View className="flex-1 ml-3">
                    <View className="flex-row items-center justify-between">
                      <Text className="text-white font-semibold text-base">
                        {option.title}
                      </Text>
                      {isSelected && (
                        <View className="w-6 h-6 rounded-full bg-p01-cyan items-center justify-center">
                          <Ionicons name="checkmark" size={16} color="#0a0a0c" />
                        </View>
                      )}
                    </View>
                    <Text className="text-p01-text-secondary text-sm mt-1">
                      {option.description}
                    </Text>

                    <View className="flex-row flex-wrap mt-3 gap-2">
                      {option.features.map((feature, index) => (
                        <View
                          key={index}
                          className={`
                            px-2 py-1 rounded-md
                            ${isSelected ? 'bg-p01-cyan/10' : 'bg-p01-surface'}
                          `}
                        >
                          <Text
                            className={`
                              text-xs
                              ${isSelected ? 'text-p01-cyan' : 'text-p01-text-secondary'}
                            `}
                          >
                            {feature}
                          </Text>
                        </View>
                      ))}
                    </View>

                    <View className="flex-row items-center mt-3">
                      <Ionicons
                        name="flash-outline"
                        size={14}
                        color="#888892"
                      />
                      <Text className="text-p01-text-secondary text-xs ml-1">
                        Est. fee: {option.fee} AZTEC
                      </Text>
                    </View>
                  </View>
                </View>
              </Card>
            </TouchableOpacity>
          );
        })}
      </View>

      <View className="mt-4 p-3 bg-p01-surface/50 rounded-xl flex-row items-start">
        <Ionicons name="information-circle" size={18} color="#3b82f6" />
        <Text className="text-p01-text-secondary text-xs ml-2 flex-1">
          Higher privacy levels require more computational resources and incur
          higher network fees. Choose based on your transaction sensitivity.
        </Text>
      </View>
    </View>
  );
};

export default PrivacySelector;
