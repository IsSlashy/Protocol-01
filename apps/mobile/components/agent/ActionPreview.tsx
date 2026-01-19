import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';

type ActionType = 'send' | 'swap' | 'stream' | 'stake' | 'bridge';
type ActionStatus = 'preview' | 'pending' | 'confirmed' | 'failed';

interface ActionPreviewProps {
  type: ActionType;
  status?: ActionStatus;
  title: string;
  description?: string;
  details: {
    label: string;
    value: string;
    highlight?: boolean;
  }[];
  estimatedFee?: string;
  privacyLevel?: 'standard' | 'enhanced' | 'maximum';
  onConfirm?: () => void;
  onCancel?: () => void;
  onModify?: () => void;
  className?: string;
}

const actionConfig: Record<ActionType, { icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  send: { icon: 'arrow-up-circle', color: '#39c5bb' },
  swap: { icon: 'swap-horizontal', color: '#3b82f6' },
  stream: { icon: 'water', color: '#ff77a8' },
  stake: { icon: 'layers', color: '#f97316' },
  bridge: { icon: 'git-network', color: '#14b8a6' },
};

const statusConfig: Record<ActionStatus, { label: string; color: string }> = {
  preview: { label: 'Preview', color: '#888892' },
  pending: { label: 'Pending', color: '#eab308' },
  confirmed: { label: 'Confirmed', color: '#39c5bb' },
  failed: { label: 'Failed', color: '#ef4444' },
};

export const ActionPreview: React.FC<ActionPreviewProps> = ({
  type,
  status = 'preview',
  title,
  description,
  details,
  estimatedFee,
  privacyLevel,
  onConfirm,
  onCancel,
  onModify,
  className,
}) => {
  const config = actionConfig[type];
  const statusInfo = statusConfig[status];

  return (
    <Card variant="glass" padding="md" className={`my-2 ${className || ''}`}>
      <View className="flex-row items-start justify-between mb-4">
        <View className="flex-row items-center">
          <View
            className="w-10 h-10 rounded-full items-center justify-center"
            style={{ backgroundColor: `${config.color}20` }}
          >
            <Ionicons name={config.icon} size={22} color={config.color} />
          </View>
          <View className="ml-3">
            <Text className="text-white font-semibold text-base">{title}</Text>
            {description && (
              <Text className="text-p01-text-secondary text-sm mt-0.5">
                {description}
              </Text>
            )}
          </View>
        </View>

        <View
          className="px-2 py-1 rounded-lg"
          style={{ backgroundColor: `${statusInfo.color}20` }}
        >
          <Text className="text-xs font-medium" style={{ color: statusInfo.color }}>
            {statusInfo.label}
          </Text>
        </View>
      </View>

      <View className="bg-p01-surface/50 rounded-xl p-3 mb-4">
        {details.map((detail, index) => (
          <View
            key={index}
            className={`flex-row items-center justify-between ${
              index < details.length - 1 ? 'mb-2 pb-2 border-b border-p01-border' : ''
            }`}
          >
            <Text className="text-p01-text-secondary text-sm">
              {detail.label}
            </Text>
            <Text
              className={`font-medium ${
                detail.highlight ? 'text-p01-cyan' : 'text-white'
              }`}
            >
              {detail.value}
            </Text>
          </View>
        ))}
      </View>

      {(estimatedFee || privacyLevel) && (
        <View className="flex-row items-center justify-between mb-4">
          {estimatedFee && (
            <View className="flex-row items-center">
              <Ionicons name="flash-outline" size={14} color="#888892" />
              <Text className="text-p01-text-secondary text-xs ml-1">
                Est. fee: {estimatedFee}
              </Text>
            </View>
          )}
          {privacyLevel && (
            <View className="flex-row items-center">
              <Ionicons name="shield-checkmark" size={14} color="#39c5bb" />
              <Text className="text-p01-cyan text-xs ml-1 capitalize">
                {privacyLevel} Privacy
              </Text>
            </View>
          )}
        </View>
      )}

      {status === 'preview' && (onConfirm || onCancel || onModify) && (
        <View className="flex-row gap-2">
          {onCancel && (
            <TouchableOpacity
              onPress={onCancel}
              className="flex-1 py-3 bg-p01-surface border border-p01-border rounded-xl items-center"
            >
              <Text className="text-p01-text-secondary font-medium">
                Cancel
              </Text>
            </TouchableOpacity>
          )}
          {onModify && (
            <TouchableOpacity
              onPress={onModify}
              className="flex-1 py-3 bg-p01-surface border border-p01-border rounded-xl items-center"
            >
              <Text className="text-white font-medium">Modify</Text>
            </TouchableOpacity>
          )}
          {onConfirm && (
            <TouchableOpacity
              onPress={onConfirm}
              className="flex-1 py-3 bg-p01-cyan rounded-xl items-center"
              style={{
                shadowColor: '#39c5bb',
                shadowOpacity: 0.3,
                shadowRadius: 10,
                shadowOffset: { width: 0, height: 4 },
                elevation: 8,
              }}
            >
              <Text className="text-p01-void font-semibold">Confirm</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </Card>
  );
};

export default ActionPreview;
