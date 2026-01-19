import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { useAIStore } from '@/stores/aiStore';
import { DEFAULT_CONFIGS, getOllamaModels } from '@/services/ai/agent';
import { SettingsSection, RadioOption } from '@/components/settings';

type ProviderType = 'ollama' | 'openai' | 'anthropic';

export default function AISettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const { config, isConnected, updateConfig, testConnection } = useAIStore();

  const [provider, setProvider] = useState<ProviderType>(config.provider as ProviderType);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [model, setModel] = useState(config.model);
  const [apiKey, setApiKey] = useState(config.apiKey || '');
  const [temperature, setTemperature] = useState(config.temperature.toString());

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  // Load Ollama models when provider is Ollama
  useEffect(() => {
    if (provider === 'ollama' && baseUrl) {
      loadOllamaModels();
    }
  }, [provider, baseUrl]);

  const loadOllamaModels = async () => {
    setLoadingModels(true);
    try {
      const models = await getOllamaModels(baseUrl);
      setAvailableModels(models);
      if (models.length > 0 && !models.includes(model)) {
        setModel(models[0]);
      }
    } catch (error) {
      console.error('Failed to load models:', error);
    } finally {
      setLoadingModels(false);
    }
  };

  const handleProviderChange = (newProvider: ProviderType) => {
    setProvider(newProvider);
    const defaults = DEFAULT_CONFIGS[newProvider];
    if (defaults) {
      setBaseUrl(defaults.baseUrl || '');
      setModel(defaults.model || '');
    }
    setTestResult(null);
    setTestError(null);
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    setTestError(null);

    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Temporarily update config for testing
    await updateConfig({
      provider,
      baseUrl,
      model,
      apiKey: apiKey || undefined,
      temperature: parseFloat(temperature) || 0.7,
    });

    const result = await testConnection();

    if (result.success) {
      setTestResult('success');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setTestResult('error');
      setTestError(result.error || 'Connection failed');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }

    setIsTesting(false);
  };

  const handleSave = async () => {
    setIsSaving(true);

    try {
      await updateConfig({
        provider,
        baseUrl,
        model,
        apiKey: apiKey || undefined,
        temperature: parseFloat(temperature) || 0.7,
        maxTokens: config.maxTokens,
      });

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Settings Saved', 'AI configuration has been updated.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <View className="flex-1 bg-p01-void" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-4">
        <TouchableOpacity
          onPress={() => router.back()}
          className="w-10 h-10 rounded-full bg-p01-surface items-center justify-center"
        >
          <Ionicons name="arrow-back" size={20} color="#fff" />
        </TouchableOpacity>
        <Text className="text-white text-lg font-semibold">AI Settings</Text>
        <View className="w-10" />
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        {/* Connection Status */}
        <View className="mx-4 mb-6 p-4 bg-p01-surface rounded-2xl border border-p01-border">
          <View className="flex-row items-center">
            <View
              className="w-3 h-3 rounded-full mr-3"
              style={{ backgroundColor: isConnected ? '#22c55e' : '#ef4444' }}
            />
            <Text className="text-white text-base font-medium">
              {isConnected ? 'Connected' : 'Not Connected'}
            </Text>
          </View>
          <Text className="text-p01-gray text-sm mt-2">
            {isConnected
              ? `Using ${config.model} via ${config.provider}`
              : 'Configure your AI provider below'}
          </Text>
        </View>

        {/* Provider Selection */}
        <SettingsSection title="AI Provider">
          <RadioOption
            label="Ollama (Local)"
            description="Run AI locally on your computer"
            selected={provider === 'ollama'}
            onSelect={() => handleProviderChange('ollama')}
          />
          <View className="h-px bg-p01-border mx-4" />
          <RadioOption
            label="OpenAI"
            description="GPT-4 and other models (requires API key)"
            selected={provider === 'openai'}
            onSelect={() => handleProviderChange('openai')}
          />
          <View className="h-px bg-p01-border mx-4" />
          <RadioOption
            label="Anthropic"
            description="Claude models (requires API key)"
            selected={provider === 'anthropic'}
            onSelect={() => handleProviderChange('anthropic')}
          />
        </SettingsSection>

        {/* Ollama Setup Info */}
        {provider === 'ollama' && (
          <View className="mx-4 mb-6 p-4 bg-orange-500/10 rounded-2xl border border-orange-500/30">
            <View className="flex-row items-start">
              <Ionicons name="information-circle" size={20} color="#f59e0b" />
              <View className="flex-1 ml-3">
                <Text className="text-orange-400 text-sm font-medium mb-1">
                  Ollama Setup Required
                </Text>
                <Text className="text-orange-300/70 text-xs leading-relaxed">
                  1. Install Ollama from ollama.ai{'\n'}
                  2. Run: ollama pull llama3.2{'\n'}
                  3. Start Ollama and ensure it's running{'\n'}
                  4. Use your computer's local IP (not localhost) if testing on a physical device
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Configuration */}
        <SettingsSection title="Configuration">
          {/* Base URL */}
          <View className="px-4 py-4">
            <Text className="text-white text-base font-medium mb-2">Server URL</Text>
            <TextInput
              className="bg-p01-surface-light border border-p01-border rounded-xl px-4 py-3 text-white"
              placeholder="http://localhost:11434"
              placeholderTextColor="#666"
              value={baseUrl}
              onChangeText={setBaseUrl}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View className="h-px bg-p01-border mx-4" />

          {/* Model */}
          <View className="px-4 py-4">
            <Text className="text-white text-base font-medium mb-2">Model</Text>
            {provider === 'ollama' && availableModels.length > 0 ? (
              <View>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  className="mb-2"
                >
                  {availableModels.map((m) => (
                    <TouchableOpacity
                      key={m}
                      onPress={() => setModel(m)}
                      className={`mr-2 px-4 py-2 rounded-xl border ${
                        model === m
                          ? 'bg-orange-500/20 border-orange-500'
                          : 'bg-p01-surface border-p01-border'
                      }`}
                    >
                      <Text
                        className={model === m ? 'text-orange-400' : 'text-white'}
                      >
                        {m}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                {loadingModels && (
                  <Text className="text-p01-gray text-xs">Loading models...</Text>
                )}
              </View>
            ) : (
              <TextInput
                className="bg-p01-surface-light border border-p01-border rounded-xl px-4 py-3 text-white"
                placeholder={provider === 'ollama' ? 'llama3.2' : 'gpt-4o-mini'}
                placeholderTextColor="#666"
                value={model}
                onChangeText={setModel}
                autoCapitalize="none"
              />
            )}
          </View>

          {/* API Key (for OpenAI/Anthropic) */}
          {provider !== 'ollama' && (
            <>
              <View className="h-px bg-p01-border mx-4" />
              <View className="px-4 py-4">
                <Text className="text-white text-base font-medium mb-2">API Key</Text>
                <TextInput
                  className="bg-p01-surface-light border border-p01-border rounded-xl px-4 py-3 text-white"
                  placeholder="sk-..."
                  placeholderTextColor="#666"
                  value={apiKey}
                  onChangeText={setApiKey}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </>
          )}

          <View className="h-px bg-p01-border mx-4" />

          {/* Temperature */}
          <View className="px-4 py-4">
            <Text className="text-white text-base font-medium mb-2">
              Temperature: {temperature}
            </Text>
            <Text className="text-p01-gray text-xs mb-2">
              Lower = more focused, Higher = more creative
            </Text>
            <View className="flex-row items-center gap-2">
              {['0.3', '0.5', '0.7', '0.9'].map((t) => (
                <TouchableOpacity
                  key={t}
                  onPress={() => setTemperature(t)}
                  className={`flex-1 py-2 rounded-lg items-center ${
                    temperature === t
                      ? 'bg-orange-500/20 border border-orange-500'
                      : 'bg-p01-surface-light border border-p01-border'
                  }`}
                >
                  <Text
                    className={temperature === t ? 'text-orange-400' : 'text-white'}
                  >
                    {t}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </SettingsSection>

        {/* Test Connection */}
        <View className="mx-4 mb-6">
          <TouchableOpacity
            className="py-3 rounded-xl items-center flex-row justify-center"
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.1)' }}
            onPress={handleTestConnection}
            disabled={isTesting}
            activeOpacity={0.7}
          >
            {isTesting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="pulse-outline" size={20} color="#fff" />
                <Text className="text-white font-semibold ml-2">Test Connection</Text>
              </>
            )}
          </TouchableOpacity>

          {testResult && (
            <View
              className={`flex-row items-center mt-3 p-3 rounded-xl ${
                testResult === 'success' ? 'bg-green-500/10' : 'bg-red-500/10'
              }`}
            >
              <Ionicons
                name={testResult === 'success' ? 'checkmark-circle' : 'close-circle'}
                size={20}
                color={testResult === 'success' ? '#22c55e' : '#ef4444'}
              />
              <Text
                className={`ml-2 text-sm flex-1 ${
                  testResult === 'success' ? 'text-green-500' : 'text-red-500'
                }`}
              >
                {testResult === 'success'
                  ? 'Connection successful!'
                  : testError || 'Connection failed'}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Save Button */}
      <View className="px-4 pb-4" style={{ paddingBottom: insets.bottom + 16 }}>
        <TouchableOpacity
          className="py-4 rounded-xl items-center flex-row justify-center"
          style={{
            backgroundColor: '#f59e0b',
            shadowColor: '#f59e0b',
            shadowOpacity: 0.3,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 4 },
          }}
          onPress={handleSave}
          disabled={isSaving}
          activeOpacity={0.8}
        >
          {isSaving ? (
            <ActivityIndicator color="#000" />
          ) : (
            <Text className="text-black font-semibold text-base">
              Save Settings
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}
