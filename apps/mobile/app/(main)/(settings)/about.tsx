import React, { useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Linking, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'react-native';
import Constants from 'expo-constants';
import { Colors, FontFamily, P01Colors } from '@/constants/theme';
import { checkForUpdate } from '@/services/updates/versionCheck';
import { useT } from '@/i18n';

const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';
const BUILD_NUMBER = String(Constants.expoConfig?.android?.versionCode ?? Constants.expoConfig?.ios?.buildNumber ?? '1');

function GlassCard({ children, style }: { children: React.ReactNode; style?: any }) {
  return (
    <View style={[{ borderRadius: 20, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(57, 197, 187, 0.07)' }, style]}>
      <BlurView intensity={14} tint="dark" style={{ backgroundColor: 'rgba(12, 12, 14, 0.65)' }}>
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

interface SocialLinkProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  url: string;
  color: string;
}

const SocialLink: React.FC<SocialLinkProps> = ({ icon, label, url, color }) => (
  <TouchableOpacity
    style={{ alignItems: 'center' }}
    onPress={() => Linking.openURL(url)}
    activeOpacity={0.7}
  >
    <View
      style={{
        width: 56,
        height: 56,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 8,
        backgroundColor: `${color}20`,
      }}
    >
      <Ionicons name={icon} size={26} color={color} />
    </View>
    <Text style={{ color: Colors.textSecondary, fontSize: 12 }}>{label}</Text>
  </TouchableOpacity>
);

interface LinkRowProps {
  label: string;
  onPress: () => void;
}

const LinkRow: React.FC<LinkRowProps> = ({ label, onPress }) => (
  <TouchableOpacity
    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, paddingHorizontal: 16 }}
    onPress={onPress}
    activeOpacity={0.7}
  >
    <Text style={{ color: '#ffffff', fontSize: 16 }}>{label}</Text>
    <Ionicons name="open-outline" size={18} color={Colors.textSecondary} />
  </TouchableOpacity>
);

export default function AboutScreen() {
  const t = useT();
  const router = useRouter();
  const devTapCount = useRef(0);

  const socialLinks = [
    {
      icon: 'globe-outline' as const,
      label: 'Website',
      url: 'https://protocol-01.vercel.app',
      color: P01Colors.cyan,
    },
    {
      icon: 'logo-github' as const,
      label: 'GitHub',
      url: 'https://github.com/IsSlashy/Protocol-01',
      color: '#fff',
    },
    {
      icon: 'logo-twitter' as const,
      label: 'Twitter',
      url: 'https://x.com/Protocol01_',
      color: '#1DA1F2',
    },
    {
      icon: 'logo-discord' as const,
      label: 'Discord',
      url: 'https://discord.gg/protocol01',
      color: '#5865F2',
    },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: 'transparent' }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 16 }}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255, 255, 255, 0.06)', alignItems: 'center', justifyContent: 'center' }}
        >
          <Ionicons name="arrow-back" size={20} color="#fff" />
        </TouchableOpacity>
        <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '600' }}>{t('settings.about')}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 140 }}
      >
        {/* Logo and Version */}
        <Animated.View entering={FadeInDown.delay(100).duration(400)} style={{ alignItems: 'center', paddingVertical: 32 }}>
          <Image
            source={require('@/assets/images/Protocol.png')}
            style={{
              width: 96,
              height: 96,
              borderRadius: 24,
              marginBottom: 16,
            }}
          />
          <Text style={{ color: '#ffffff', fontSize: 24, fontWeight: '700' }}>Protocol 01</Text>
          <Text style={{ color: P01Colors.cyan, fontSize: 16, marginTop: 4 }}>P-01 Wallet</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 }}>
            <Text style={{ color: Colors.textSecondary, fontSize: 14 }}>{t('settings.version')} {APP_VERSION}</Text>
            <Text style={{ color: Colors.textTertiary, fontSize: 14, marginHorizontal: 8 }}>|</Text>
            <Text style={{ color: Colors.textSecondary, fontSize: 14 }}>{t('settings.build')} {BUILD_NUMBER}</Text>
          </View>
        </Animated.View>

        {/* Social Links */}
        <Animated.View entering={FadeInDown.delay(200).duration(400)} style={{ flexDirection: 'row', justifyContent: 'center', gap: 24, paddingVertical: 24, marginHorizontal: 16 }}>
          {socialLinks.map((link) => (
            <SocialLink key={link.label} {...link} />
          ))}
        </Animated.View>

        {/* Description */}
        <Animated.View entering={FadeInDown.delay(300).duration(400)} style={{ marginHorizontal: 16, marginBottom: 24 }}>
          <GlassCard>
            <View style={{ padding: 16 }}>
              <Text style={{ color: Colors.textSecondary, fontSize: 14, lineHeight: 22, textAlign: 'center' }}>
                {t('settings.aboutDescription')}
              </Text>
            </View>
          </GlassCard>
        </Animated.View>

        {/* Check for Updates */}
        <Animated.View entering={FadeInDown.delay(350).duration(400)} style={{ marginHorizontal: 16, marginBottom: 24 }}>
          <GlassCard>
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 }}
              onPress={() => checkForUpdate(true)}
              activeOpacity={0.7}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="cloud-download-outline" size={20} color={P01Colors.cyan} />
                <Text style={{ color: '#ffffff', fontSize: 16, marginLeft: 12 }}>{t('settings.checkForUpdates')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />
            </TouchableOpacity>
          </GlassCard>
        </Animated.View>

        {/* Legal Links */}
        <Animated.View entering={FadeInDown.delay(400).duration(400)} style={{ marginHorizontal: 16, marginBottom: 24 }}>
          <Text style={{ color: Colors.textTertiary, fontSize: 12, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8, paddingHorizontal: 16 }}>
            {t('settings.legal')}
          </Text>
          <GlassCard>
            <View>
              <LinkRow
                label={t('settings.privacyPolicy')}
                onPress={() => Linking.openURL('https://protocol-01.vercel.app/privacy')}
              />
              <View style={{ height: 1, backgroundColor: 'rgba(57, 197, 187, 0.07)', marginHorizontal: 16 }} />
              <LinkRow
                label={t('settings.termsOfService')}
                onPress={() => Linking.openURL('https://protocol-01.vercel.app/terms')}
              />
              <View style={{ height: 1, backgroundColor: 'rgba(57, 197, 187, 0.07)', marginHorizontal: 16 }} />
              <LinkRow
                label={t('settings.openSource')}
                onPress={() => Linking.openURL('https://protocol-01.vercel.app/licenses')}
              />
            </View>
          </GlassCard>
        </Animated.View>

        {/* Tech Stack */}
        <Animated.View entering={FadeInDown.delay(500).duration(400)} style={{ marginHorizontal: 16, marginBottom: 24 }}>
          <GlassCard>
            <View style={{ padding: 16 }}>
              <Text style={{ color: '#ffffff', fontSize: 14, fontWeight: '600', marginBottom: 12 }}>{t('settings.builtWith')}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {['Solana', 'React Native', 'Expo', 'Groth16', 'STARKs', 'Arcium MPC', 'Poseidon', 'ML-KEM'].map((tech) => (
                  <View key={tech} style={{ paddingHorizontal: 12, paddingVertical: 6, backgroundColor: 'rgba(255, 255, 255, 0.06)', borderRadius: 9999 }}>
                    <Text style={{ color: Colors.textSecondary, fontSize: 12 }}>{tech}</Text>
                  </View>
                ))}
              </View>
            </View>
          </GlassCard>
        </Animated.View>

        {/* Credits */}
        <Animated.View entering={FadeInDown.delay(600).duration(400)} style={{ alignItems: 'center', paddingVertical: 16 }}>
          <Text style={{ color: Colors.textTertiary, fontSize: 12 }}>
            {t('settings.madeBy')}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
            <Ionicons name="shield-checkmark" size={14} color={P01Colors.cyan} />
            <Text style={{ color: 'rgba(57, 197, 187, 0.7)', fontSize: 12, marginLeft: 4 }}>
              {t('settings.yourKeys')}
            </Text>
          </View>
        </Animated.View>

        {/* Debug Info (could be hidden in production) */}
        <TouchableOpacity
          style={{ marginHorizontal: 16, marginTop: 16, paddingVertical: 12, alignItems: 'center' }}
          onPress={() => {
            devTapCount.current += 1;
            if (devTapCount.current >= 7) {
              devTapCount.current = 0;
              router.push('/(main)/(settings)/privacy-test');
            }
          }}
          activeOpacity={0.5}
        >
          <Text style={{ color: 'rgba(255, 255, 255, 0.15)', fontSize: 12 }}>
            Tap 7 times to enable developer mode
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}
