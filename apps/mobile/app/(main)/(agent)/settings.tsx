import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Switch,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { useAIStore } from '@/stores/aiStore';
import { MODEL_INFO, isOnDeviceAvailable } from '@/services/ai/llamaService';
import { DEFAULT_CONFIGS } from '@/services/ai/agent';
import { Colors, FontSize, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';

type ProviderOption = {
  id: string;
  label: string;
  description: string;
  icon: string;
};

const PROVIDERS: ProviderOption[] = [
  { id: 'groq', label: 'Groq', description: 'Llama 3.3 70B — fastest cloud', icon: 'flash-outline' },
  { id: 'gemma', label: 'Gemini', description: 'Gemini 2.0 Flash — free', icon: 'diamond-outline' },
  { id: 'llama-local', label: 'On-Device', description: 'Gemma 3 1B — fully offline', icon: 'phone-portrait-outline' },
  { id: 'custom', label: 'Custom', description: 'OpenAI, Anthropic, Ollama', icon: 'code-slash-outline' },
];

export default function AISettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    config, isConnected, messages, clearMessages, updateConfig,
    modelStatus, modelDownloadProgress, modelLoadProgress, downloadError,
    downloadModel, cancelDownload, initModel, releaseModel, deleteModel,
    conversations, deleteConversation,
  } = useAIStore();

  const [groqKey, setGroqKey] = useState(config.groqApiKey || '');
  const [geminiKey, setGeminiKey] = useState(config.apiKey || '');
  const [showGroqKey, setShowGroqKey] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const nativeAvailable = isOnDeviceAvailable();

  const handleProviderChange = (providerId: string) => {
    if (providerId === 'custom') {
      // Keep current provider but show custom options
      return;
    }
    // Map pill IDs to actual config keys
    const configKey = providerId === 'gemma' ? 'gemma-cloud' : providerId;
    const defaults = DEFAULT_CONFIGS[configKey] || {};
    updateConfig({
      ...defaults,
      groqApiKey: groqKey || config.groqApiKey,
      apiKey: geminiKey || config.apiKey,
      voiceEnabled: config.voiceEnabled,
      voiceAutoSend: config.voiceAutoSend,
    } as any);
  };

  const handleSaveGroqKey = () => {
    updateConfig({ groqApiKey: groqKey });
  };

  const handleSaveGeminiKey = () => {
    updateConfig({ apiKey: geminiKey });
  };

  const handleClearHistory = () => {
    p01Alert(
      'Clear All Data',
      'Delete all messages and conversations? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            clearMessages();
            // Delete all conversations
            conversations.forEach((c: any) => deleteConversation(c.id));
            p01Alert('Done', 'All chat data cleared.');
          },
        },
      ]
    );
  };

  const handleDownloadModel = () => {
    p01Alert(
      'Download Gemma 3 1B',
      `This will download ~${MODEL_INFO.fileSizeMB}MB. Wi-Fi recommended.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Download', onPress: () => downloadModel() },
      ]
    );
  };

  const handleDeleteModel = () => {
    p01Alert(
      'Delete Model',
      `Free ~${MODEL_INFO.fileSizeMB}MB of storage?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteModel() },
      ]
    );
  };

  const currentProvider = config.provider === 'gemma-cloud' || (config.provider === 'gemma' && config.gemmaBackend === 'google-ai')
    ? 'gemma'
    : config.provider === 'llama-local' || (config.provider === 'gemma' && config.gemmaBackend === 'on-device')
    ? 'llama-local'
    : config.provider;

  const providerLabel = (() => {
    if (config.provider === 'groq') return 'Groq (Llama 3.3 70B)';
    if (modelStatus === 'loaded') return 'On-device (Gemma 3 1B)';
    if (config.provider === 'gemma' || config.provider === 'gemma-cloud') return 'Gemini 2.0 Flash';
    return config.provider;
  })();

  const modelStatusLabel = (() => {
    switch (modelStatus) {
      case 'not_downloaded': return 'Not downloaded';
      case 'downloading': return `Downloading... ${modelDownloadProgress}%`;
      case 'ready': return 'Downloaded (not loaded)';
      case 'loading': return `Loading... ${modelLoadProgress}%`;
      case 'loaded': return 'Loaded & Active';
      case 'error': return 'Error';
      default: return modelStatus;
    }
  })();

  const modelStatusColor = (() => {
    switch (modelStatus) {
      case 'loaded': return Colors.success;
      case 'ready': return Colors.primary;
      case 'downloading':
      case 'loading': return Colors.yellow;
      case 'error': return Colors.error;
      default: return Colors.textTertiary;
    }
  })();

  return (
    <View style={{ flex: 1, backgroundColor: 'transparent', paddingTop: insets.top }}>
      {/* Header */}
      <View style={{ overflow: 'hidden' }}>
        <BlurView
          intensity={30}
          tint="dark"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: Spacing.lg,
            paddingVertical: 12,
            backgroundColor: 'rgba(10, 10, 12, 0.75)',
            borderBottomWidth: 1,
            borderBottomColor: 'rgba(57, 197, 187, 0.1)',
          }}
        >
          <TouchableOpacity
            onPress={() => router.back()}
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(255, 255, 255, 0.06)',
            }}
          >
            <Ionicons name="chevron-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text
            style={{
              color: Colors.text,
              fontSize: FontSize.lg,
              fontFamily: FontFamily.semibold,
              marginLeft: 10,
            }}
          >
            Agent Settings
          </Text>
        </BlurView>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: Spacing.xl, paddingBottom: insets.bottom + 120 }}
      >
        {/* AI Provider Selector */}
        <Animated.View entering={FadeInDown.delay(100).springify()}>
          <SectionTitle title="AI PROVIDER" />
          <GlassCard>
            <SettingsRow icon="sparkles" label="Active" value={providerLabel} />
            <GlassDivider />
            <SettingsRow
              icon="wifi"
              label="Status"
              value={isConnected ? 'Connected' : 'Offline'}
              valueColor={isConnected ? Colors.success : Colors.yellow}
            />
          </GlassCard>

          {/* Provider pills — 2×2 compact grid */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {PROVIDERS.map((p) => {
              const isActive = currentProvider === p.id;
              return (
                <TouchableOpacity
                  key={p.id}
                  onPress={() => handleProviderChange(p.id)}
                  activeOpacity={0.7}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 10,
                    paddingVertical: 7,
                    borderRadius: 10,
                    overflow: 'hidden',
                    width: '48.5%',
                  }}
                >
                  <View style={StyleSheet.absoluteFill}>
                    <BlurView
                      intensity={12}
                      tint="dark"
                      style={[
                        StyleSheet.absoluteFill,
                        {
                          backgroundColor: isActive
                            ? 'rgba(57, 197, 187, 0.12)'
                            : 'rgba(12, 12, 14, 0.65)',
                        },
                      ]}
                    />
                  </View>
                  <View
                    style={[
                      StyleSheet.absoluteFill,
                      {
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: isActive
                          ? 'rgba(57, 197, 187, 0.35)'
                          : 'rgba(57, 197, 187, 0.07)',
                      },
                    ]}
                    pointerEvents="none"
                  />
                  <Ionicons
                    name={p.icon as any}
                    size={14}
                    color={isActive ? P01Colors.cyan : Colors.textSecondary}
                  />
                  <View style={{ marginLeft: 6, flex: 1 }}>
                    <Text style={{ color: isActive ? P01Colors.cyan : Colors.text, fontSize: 12, fontFamily: FontFamily.medium }}>
                      {p.label}
                    </Text>
                    <Text style={{ color: Colors.textTertiary, fontSize: 9 }} numberOfLines={1}>
                      {p.description}
                    </Text>
                  </View>
                  {isActive && (
                    <Ionicons name="checkmark-circle" size={14} color={P01Colors.cyan} style={{ marginLeft: 2 }} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </Animated.View>

        {/* API Keys */}
        <Animated.View entering={FadeInDown.delay(150).springify()}>
          <SectionTitle title="API KEYS" />
          <GlassCard>
            {/* Groq Key */}
            <View style={{ padding: 14 }}>
              <Text style={{ color: Colors.text, fontSize: FontSize.sm, fontFamily: FontFamily.medium, marginBottom: 6 }}>
                Groq API Key
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: 'rgba(0, 0, 0, 0.3)',
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    borderWidth: 1,
                    borderColor: 'rgba(57, 197, 187, 0.07)',
                    height: 40,
                  }}
                >
                  <TextInput
                    value={groqKey}
                    onChangeText={setGroqKey}
                    onBlur={handleSaveGroqKey}
                    placeholder="gsk_..."
                    placeholderTextColor={Colors.textTertiary}
                    secureTextEntry={!showGroqKey}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{
                      flex: 1,
                      color: Colors.text,
                      fontSize: FontSize.sm,
                      fontFamily: FontFamily.mono,
                    }}
                  />
                  <TouchableOpacity onPress={() => setShowGroqKey(!showGroqKey)}>
                    <Ionicons
                      name={showGroqKey ? 'eye-off-outline' : 'eye-outline'}
                      size={18}
                      color={Colors.textTertiary}
                    />
                  </TouchableOpacity>
                </View>
              </View>
              <Text style={{ color: Colors.textTertiary, fontSize: 10, marginTop: 4 }}>
                Free at console.groq.com — enables fast cloud AI + voice
              </Text>
            </View>

            <GlassDivider />

            {/* Gemini Key */}
            <View style={{ padding: 14 }}>
              <Text style={{ color: Colors.text, fontSize: FontSize.sm, fontFamily: FontFamily.medium, marginBottom: 6 }}>
                Gemini API Key
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: 'rgba(0, 0, 0, 0.3)',
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    borderWidth: 1,
                    borderColor: 'rgba(57, 197, 187, 0.07)',
                    height: 40,
                  }}
                >
                  <TextInput
                    value={geminiKey}
                    onChangeText={setGeminiKey}
                    onBlur={handleSaveGeminiKey}
                    placeholder="AI..."
                    placeholderTextColor={Colors.textTertiary}
                    secureTextEntry={!showGeminiKey}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{
                      flex: 1,
                      color: Colors.text,
                      fontSize: FontSize.sm,
                      fontFamily: FontFamily.mono,
                    }}
                  />
                  <TouchableOpacity onPress={() => setShowGeminiKey(!showGeminiKey)}>
                    <Ionicons
                      name={showGeminiKey ? 'eye-off-outline' : 'eye-outline'}
                      size={18}
                      color={Colors.textTertiary}
                    />
                  </TouchableOpacity>
                </View>
              </View>
              <Text style={{ color: Colors.textTertiary, fontSize: 10, marginTop: 4 }}>
                Free at aistudio.google.com — Gemini Flash fallback
              </Text>
            </View>
          </GlassCard>
        </Animated.View>

        {/* Voice Settings */}
        <Animated.View entering={FadeInDown.delay(200).springify()}>
          <SectionTitle title="VOICE INPUT" />
          <GlassCard>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <IconBox icon="mic-outline" color={P01Colors.cyan} />
                <Text style={{ color: Colors.text, fontSize: FontSize.md, marginLeft: 12 }}>
                  Voice Input
                </Text>
              </View>
              <Switch
                value={config.voiceEnabled !== false}
                onValueChange={(v) => updateConfig({ voiceEnabled: v })}
                trackColor={{ false: 'rgba(42, 42, 48, 0.5)', true: 'rgba(57, 197, 187, 0.3)' }}
                thumbColor={config.voiceEnabled !== false ? P01Colors.cyan : Colors.textTertiary}
              />
            </View>
            <GlassDivider />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <IconBox icon="send-outline" color={P01Colors.yellow} />
                <View style={{ marginLeft: 12 }}>
                  <Text style={{ color: Colors.text, fontSize: FontSize.md }}>Auto-Send</Text>
                  <Text style={{ color: Colors.textTertiary, fontSize: FontSize.xs }}>
                    Send message after transcription
                  </Text>
                </View>
              </View>
              <Switch
                value={config.voiceAutoSend === true}
                onValueChange={(v) => updateConfig({ voiceAutoSend: v })}
                trackColor={{ false: 'rgba(42, 42, 48, 0.5)', true: 'rgba(255, 204, 0, 0.3)' }}
                thumbColor={config.voiceAutoSend ? P01Colors.yellow : Colors.textTertiary}
              />
            </View>
          </GlassCard>
          <InfoBox text="Voice uses Groq Whisper for transcription. Requires Groq API key." />
        </Animated.View>

        {/* Privacy — wallet context sharing (H8) */}
        <Animated.View entering={FadeInDown.delay(225).springify()}>
          <SectionTitle title="PRIVACY" />
          <GlassCard>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <IconBox icon="eye-off-outline" color={P01Colors.yellow} />
                <View style={{ marginLeft: 12, flex: 1 }}>
                  <Text style={{ color: Colors.text, fontSize: FontSize.md }}>Share Wallet Data</Text>
                  <Text style={{ color: Colors.textTertiary, fontSize: FontSize.xs }}>
                    Send balances & streams to cloud AI
                  </Text>
                </View>
              </View>
              <Switch
                value={config.shareWalletContext === true}
                onValueChange={(v) => updateConfig({ shareWalletContext: v })}
                trackColor={{ false: 'rgba(42, 42, 48, 0.5)', true: 'rgba(255, 204, 0, 0.3)' }}
                thumbColor={config.shareWalletContext ? P01Colors.yellow : Colors.textTertiary}
              />
            </View>
          </GlassCard>
          <InfoBox text="When off, cloud providers (Groq, Gemini, OpenAI) only see market data. On-device AI always has full access — your data never leaves the phone." />
        </Animated.View>

        {/* On-Device AI */}
        <Animated.View entering={FadeInDown.delay(250).springify()}>
          <SectionTitle title="ON-DEVICE AI" />
          <GlassCard>
            <SettingsRow icon="hardware-chip-outline" label={MODEL_INFO.name} value={`${MODEL_INFO.quantization} | ${MODEL_INFO.fileSizeMB}MB`} />
            <GlassDivider />
            <SettingsRow icon="radio-button-on" label="Status" value={modelStatusLabel} valueColor={modelStatusColor} />

            {/* Progress bar */}
            {(modelStatus === 'downloading' || modelStatus === 'loading') && (
              <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
                <View
                  style={{
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: 'rgba(57, 197, 187, 0.15)',
                    marginLeft: 48,
                  }}
                >
                  <View
                    style={{
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: P01Colors.cyan,
                      width: `${modelStatus === 'downloading' ? modelDownloadProgress : modelLoadProgress}%`,
                    }}
                  />
                </View>
              </View>
            )}

            {/* Download error */}
            {downloadError && (
              <View style={{ paddingHorizontal: 14, paddingBottom: 10, marginLeft: 48 }}>
                <Text style={{ color: Colors.error, fontSize: FontSize.xs }}>{downloadError}</Text>
              </View>
            )}

            <GlassDivider />

            {/* Action buttons */}
            {modelStatus === 'not_downloaded' && (
              <ActionButton icon="cloud-download-outline" label="Download Model" sublabel={`~${MODEL_INFO.fileSizeMB}MB | Works fully offline`} color={P01Colors.cyan} onPress={handleDownloadModel} />
            )}

            {modelStatus === 'downloading' && (
              <ActionButton icon="close-circle-outline" label={`Downloading... ${modelDownloadProgress}%`} sublabel="Tap to cancel" color={P01Colors.yellow} onPress={cancelDownload} />
            )}

            {modelStatus === 'ready' && (
              <>
                {!nativeAvailable && (
                  <View style={{ paddingHorizontal: 14, paddingBottom: 10, marginLeft: 48 }}>
                    <Text style={{ color: P01Colors.yellow, fontSize: FontSize.xs }}>
                      Requires native build (EAS). Use Groq or Gemini instead.
                    </Text>
                  </View>
                )}
                <ActionButton
                  icon="play-outline"
                  label="Load Model"
                  sublabel={nativeAvailable ? `Uses ~${MODEL_INFO.fileSizeMB}MB RAM` : 'Needs EAS build — not available'}
                  color={nativeAvailable ? Colors.success : Colors.textTertiary}
                  onPress={() => {
                    if (!nativeAvailable) {
                      p01Alert('Native Build Required', 'On-device inference needs a full EAS build with llama.rn. Use Groq or Gemini cloud providers for now.');
                    } else {
                      initModel();
                    }
                  }}
                />
                <GlassDivider />
                <ActionButton icon="trash-outline" label="Delete Model" color={Colors.error} onPress={handleDeleteModel} />
              </>
            )}

            {modelStatus === 'loading' && (
              <View style={{ flexDirection: 'row', alignItems: 'center', padding: 14 }}>
                <View style={{ width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: P01Colors.yellowDim, marginRight: 12 }}>
                  <ActivityIndicator size="small" color={P01Colors.yellow} />
                </View>
                <Text style={{ color: P01Colors.yellow, fontSize: FontSize.md }}>Loading... {modelLoadProgress}%</Text>
              </View>
            )}

            {modelStatus === 'loaded' && (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', padding: 14 }}>
                  <IconBox icon="checkmark-circle" color={Colors.success} />
                  <View style={{ marginLeft: 12, flex: 1 }}>
                    <Text style={{ color: Colors.success, fontSize: FontSize.md }}>Model Active</Text>
                    <Text style={{ color: Colors.textTertiary, fontSize: FontSize.xs }}>Processing queries on-device</Text>
                  </View>
                </View>
                <GlassDivider />
                <ActionButton icon="pause-outline" label="Unload (Free RAM)" color={P01Colors.yellow} onPress={() => releaseModel()} />
              </>
            )}

            {modelStatus === 'error' && (
              <>
                {!nativeAvailable && (
                  <View style={{ paddingHorizontal: 14, paddingBottom: 10, marginLeft: 48 }}>
                    <Text style={{ color: P01Colors.yellow, fontSize: FontSize.xs }}>
                      Native module not found — needs EAS build. Use Groq or Gemini.
                    </Text>
                  </View>
                )}
                <ActionButton icon="refresh-outline" label="Retry Loading" color={Colors.error} onPress={() => {
                  if (!nativeAvailable) {
                    p01Alert('Native Build Required', 'On-device inference needs a full EAS build with llama.rn. Use Groq or Gemini cloud providers for now.');
                  } else {
                    initModel();
                  }
                }} />
              </>
            )}
          </GlassCard>
          <InfoBox text="On-device AI runs entirely on your phone. No data sent to servers. Works offline." />
        </Animated.View>

        {/* Chat Data */}
        <Animated.View entering={FadeInDown.delay(350).springify()}>
          <SectionTitle title="DATA" />
          <GlassCard>
            <SettingsRow icon="chatbubbles-outline" label="Messages" value={`${messages.length} in current chat`} />
            <GlassDivider />
            <SettingsRow icon="albums-outline" label="Conversations" value={`${conversations.length} saved`} />
            <GlassDivider />
            <ActionButton icon="trash-outline" label="Clear All Chat Data" color={Colors.error} onPress={handleClearHistory} />
          </GlassCard>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

// ---- Reusable sub-components ----

function SectionTitle({ title }: { title: string }) {
  return (
    <Text
      style={{
        fontSize: FontSize.xs,
        fontFamily: FontFamily.semibold,
        letterSpacing: 1,
        color: Colors.textTertiary,
        marginBottom: 8,
        marginTop: 24,
      }}
    >
      {title}
    </Text>
  );
}

function GlassCard({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        borderRadius: 20,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(57, 197, 187, 0.07)',
      }}
    >
      <BlurView
        intensity={15}
        tint="dark"
        style={{ backgroundColor: 'rgba(12, 12, 14, 0.65)' }}
      >
        <LinearGradient
          colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {children}
      </BlurView>
    </View>
  );
}

function SettingsRow({
  icon,
  label,
  value,
  valueColor,
}: {
  icon: string;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
        <IconBox icon={icon} color={P01Colors.cyan} />
        <Text style={{ color: Colors.text, fontSize: FontSize.md, marginLeft: 12 }}>{label}</Text>
      </View>
      <Text
        style={{
          color: valueColor || Colors.textSecondary,
          fontSize: FontSize.sm,
          flexShrink: 1,
          textAlign: 'right',
        }}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

function IconBox({ icon, color }: { icon: string; color: string }) {
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: `${color}18`,
      }}
    >
      <Ionicons name={icon as any} size={18} color={color} />
    </View>
  );
}

function ActionButton({
  icon,
  label,
  sublabel,
  color,
  onPress,
}: {
  icon: string;
  label: string;
  sublabel?: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', padding: 14 }}
    >
      <IconBox icon={icon} color={color} />
      <View style={{ marginLeft: 12, flex: 1 }}>
        <Text style={{ color, fontSize: FontSize.md }}>{label}</Text>
        {sublabel && (
          <Text style={{ color: Colors.textTertiary, fontSize: FontSize.xs }}>{sublabel}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

function GlassDivider() {
  return <View style={{ height: 1, backgroundColor: 'rgba(57, 197, 187, 0.07)', marginLeft: 62 }} />;
}

function InfoBox({ text }: { text: string }) {
  return (
    <View
      style={{
        borderRadius: 14,
        overflow: 'hidden',
        marginTop: 8,
      }}
    >
      <BlurView
        intensity={12}
        tint="dark"
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          padding: 12,
          backgroundColor: 'rgba(12, 12, 14, 0.5)',
        }}
      >
        <LinearGradient
          colors={['rgba(57, 197, 187, 0.06)', 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <Ionicons name="shield-checkmark-outline" size={16} color={P01Colors.cyan} style={{ marginTop: 1 }} />
        <Text
          style={{
            color: Colors.textTertiary,
            fontSize: FontSize.xs,
            lineHeight: 18,
            marginLeft: 8,
            flex: 1,
          }}
        >
          {text}
        </Text>
      </BlurView>
    </View>
  );
}
