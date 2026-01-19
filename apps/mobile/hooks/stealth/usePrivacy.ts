/**
 * usePrivacy - Privacy level management and recommendations
 * @module hooks/stealth/usePrivacy
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAsyncStorage, ASYNC_KEYS } from '../storage/useAsyncStorage';
import { useWallet } from '../wallet/useWallet';
import { useTransactions } from '../wallet/useTransactions';
import { useStealth } from './useStealth';

export type PrivacyLevel = 'low' | 'medium' | 'high' | 'maximum';

export interface PrivacyScore {
  overall: number; // 0-100
  level: PrivacyLevel;
  factors: PrivacyFactor[];
  recommendations: PrivacyRecommendation[];
}

export interface PrivacyFactor {
  id: string;
  name: string;
  description: string;
  score: number; // 0-100
  weight: number; // importance 0-1
  status: 'good' | 'warning' | 'critical';
}

export interface PrivacyRecommendation {
  id: string;
  title: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
  actionType: 'setting' | 'behavior' | 'action';
  action?: () => void;
}

export interface PrivacySettings {
  defaultUseStealthAddress: boolean;
  autoClaimStealthPayments: boolean;
  mixingEnabled: boolean;
  minMixingRounds: number;
  hideBalanceByDefault: boolean;
  requireBiometricForSend: boolean;
  autoLockTimeout: number; // seconds
  analyticsOptOut: boolean;
}

const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  defaultUseStealthAddress: true,
  autoClaimStealthPayments: false,
  mixingEnabled: false,
  minMixingRounds: 3,
  hideBalanceByDefault: false,
  requireBiometricForSend: true,
  autoLockTimeout: 300, // 5 minutes
  analyticsOptOut: true,
};

interface UsePrivacyReturn {
  privacyScore: PrivacyScore | null;
  settings: PrivacySettings;
  isLoading: boolean;
  error: Error | null;
  updateSettings: (updates: Partial<PrivacySettings>) => Promise<boolean>;
  calculateScore: () => Promise<PrivacyScore>;
  getRecommendations: () => PrivacyRecommendation[];
  applyRecommendation: (recommendationId: string) => Promise<boolean>;
}

function calculatePrivacyLevel(score: number): PrivacyLevel {
  if (score >= 90) return 'maximum';
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

export function usePrivacy(): UsePrivacyReturn {
  const [privacyScore, setPrivacyScore] = useState<PrivacyScore | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const { wallet } = useWallet();
  const { transactions } = useTransactions({ address: wallet?.address ?? null });
  const { isInitialized: stealthInitialized } = useStealth();

  const {
    value: settings,
    setValue: setSettings,
  } = useAsyncStorage<PrivacySettings>({
    key: `${ASYNC_KEYS.SETTINGS}_privacy`,
    defaultValue: DEFAULT_PRIVACY_SETTINGS,
  });

  const currentSettings = settings ?? DEFAULT_PRIVACY_SETTINGS;

  const calculateScore = useCallback(async (): Promise<PrivacyScore> => {
    const factors: PrivacyFactor[] = [];

    // Factor 1: Stealth address usage
    const stealthTxCount = transactions.filter(tx => tx.isPrivate).length;
    const totalTxCount = transactions.length || 1;
    const stealthUsageRatio = stealthTxCount / totalTxCount;

    factors.push({
      id: 'stealth_usage',
      name: 'Stealth Address Usage',
      description: 'Percentage of transactions using stealth addresses',
      score: Math.round(stealthUsageRatio * 100),
      weight: 0.3,
      status: stealthUsageRatio >= 0.7 ? 'good' : stealthUsageRatio >= 0.3 ? 'warning' : 'critical',
    });

    // Factor 2: Stealth keys initialization
    factors.push({
      id: 'stealth_initialized',
      name: 'Stealth Keys Setup',
      description: 'Stealth address functionality is configured',
      score: stealthInitialized ? 100 : 0,
      weight: 0.2,
      status: stealthInitialized ? 'good' : 'critical',
    });

    // Factor 3: Default privacy settings
    const privacySettingsScore =
      (currentSettings.defaultUseStealthAddress ? 30 : 0) +
      (currentSettings.requireBiometricForSend ? 25 : 0) +
      (currentSettings.analyticsOptOut ? 25 : 0) +
      (currentSettings.hideBalanceByDefault ? 20 : 0);

    factors.push({
      id: 'privacy_settings',
      name: 'Privacy Settings',
      description: 'Security and privacy settings configuration',
      score: privacySettingsScore,
      weight: 0.25,
      status: privacySettingsScore >= 70 ? 'good' : privacySettingsScore >= 40 ? 'warning' : 'critical',
    });

    // Factor 4: Address reuse (lower is better)
    const uniqueAddresses = new Set(transactions.map(tx => tx.to)).size;
    const addressReuseScore = totalTxCount > 1
      ? Math.round((uniqueAddresses / totalTxCount) * 100)
      : 100;

    factors.push({
      id: 'address_reuse',
      name: 'Address Hygiene',
      description: 'Avoiding address reuse for better privacy',
      score: addressReuseScore,
      weight: 0.15,
      status: addressReuseScore >= 70 ? 'good' : addressReuseScore >= 40 ? 'warning' : 'critical',
    });

    // Factor 5: Auto-lock timeout
    const lockTimeoutScore = currentSettings.autoLockTimeout <= 60 ? 100 :
      currentSettings.autoLockTimeout <= 300 ? 70 :
      currentSettings.autoLockTimeout <= 600 ? 40 : 20;

    factors.push({
      id: 'auto_lock',
      name: 'Auto-Lock Security',
      description: 'How quickly the wallet locks when inactive',
      score: lockTimeoutScore,
      weight: 0.1,
      status: lockTimeoutScore >= 70 ? 'good' : lockTimeoutScore >= 40 ? 'warning' : 'critical',
    });

    // Calculate overall score
    const overall = Math.round(
      factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0)
    );

    const level = calculatePrivacyLevel(overall);

    // Generate recommendations
    const recommendations = generateRecommendations(factors, currentSettings);

    const score: PrivacyScore = {
      overall,
      level,
      factors,
      recommendations,
    };

    setPrivacyScore(score);
    return score;
  }, [transactions, stealthInitialized, currentSettings]);

  // Calculate score on mount and when dependencies change
  useEffect(() => {
    setIsLoading(true);
    calculateScore()
      .catch(err => setError(err instanceof Error ? err : new Error('Failed to calculate privacy score')))
      .finally(() => setIsLoading(false));
  }, [calculateScore]);

  const updateSettings = useCallback(async (
    updates: Partial<PrivacySettings>
  ): Promise<boolean> => {
    try {
      const newSettings = { ...currentSettings, ...updates };
      await setSettings(newSettings);

      // Recalculate score with new settings
      await calculateScore();

      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to update settings'));
      return false;
    }
  }, [currentSettings, setSettings, calculateScore]);

  const getRecommendations = useCallback((): PrivacyRecommendation[] => {
    return privacyScore?.recommendations ?? [];
  }, [privacyScore]);

  const applyRecommendation = useCallback(async (
    recommendationId: string
  ): Promise<boolean> => {
    const recommendation = privacyScore?.recommendations.find(r => r.id === recommendationId);

    if (!recommendation) {
      return false;
    }

    try {
      switch (recommendationId) {
        case 'enable_stealth_default':
          return await updateSettings({ defaultUseStealthAddress: true });

        case 'enable_biometric':
          return await updateSettings({ requireBiometricForSend: true });

        case 'reduce_lock_timeout':
          return await updateSettings({ autoLockTimeout: 60 });

        case 'opt_out_analytics':
          return await updateSettings({ analyticsOptOut: true });

        case 'hide_balance':
          return await updateSettings({ hideBalanceByDefault: true });

        default:
          if (recommendation.action) {
            recommendation.action();
            return true;
          }
          return false;
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to apply recommendation'));
      return false;
    }
  }, [privacyScore, updateSettings]);

  return {
    privacyScore,
    settings: currentSettings,
    isLoading,
    error,
    updateSettings,
    calculateScore,
    getRecommendations,
    applyRecommendation,
  };
}

function generateRecommendations(
  factors: PrivacyFactor[],
  settings: PrivacySettings
): PrivacyRecommendation[] {
  const recommendations: PrivacyRecommendation[] = [];

  // Check each factor and generate recommendations
  for (const factor of factors) {
    if (factor.status === 'critical' || factor.status === 'warning') {
      switch (factor.id) {
        case 'stealth_usage':
          if (!settings.defaultUseStealthAddress) {
            recommendations.push({
              id: 'enable_stealth_default',
              title: 'Enable Stealth by Default',
              description: 'Use stealth addresses for all transactions to improve privacy',
              impact: 'high',
              actionType: 'setting',
            });
          }
          break;

        case 'stealth_initialized':
          recommendations.push({
            id: 'setup_stealth',
            title: 'Set Up Stealth Addresses',
            description: 'Initialize stealth address keys to enable private transactions',
            impact: 'high',
            actionType: 'action',
          });
          break;

        case 'privacy_settings':
          if (!settings.requireBiometricForSend) {
            recommendations.push({
              id: 'enable_biometric',
              title: 'Enable Biometric Authentication',
              description: 'Require biometric verification before sending transactions',
              impact: 'medium',
              actionType: 'setting',
            });
          }
          if (!settings.analyticsOptOut) {
            recommendations.push({
              id: 'opt_out_analytics',
              title: 'Opt Out of Analytics',
              description: 'Disable analytics to prevent data collection',
              impact: 'medium',
              actionType: 'setting',
            });
          }
          break;

        case 'auto_lock':
          if (settings.autoLockTimeout > 60) {
            recommendations.push({
              id: 'reduce_lock_timeout',
              title: 'Reduce Auto-Lock Time',
              description: 'Lock wallet faster when inactive for better security',
              impact: 'low',
              actionType: 'setting',
            });
          }
          break;
      }
    }
  }

  // Add general recommendations
  if (!settings.hideBalanceByDefault) {
    recommendations.push({
      id: 'hide_balance',
      title: 'Hide Balance by Default',
      description: 'Hide your wallet balance until you explicitly reveal it',
      impact: 'low',
      actionType: 'setting',
    });
  }

  return recommendations;
}
