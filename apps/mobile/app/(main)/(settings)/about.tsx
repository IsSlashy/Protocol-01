import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Linking, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

const APP_VERSION = '1.0.0';
const BUILD_NUMBER = '1';

interface SocialLinkProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  url: string;
  color: string;
}

const SocialLink: React.FC<SocialLinkProps> = ({ icon, label, url, color }) => (
  <TouchableOpacity
    className="items-center"
    onPress={() => Linking.openURL(url)}
    activeOpacity={0.7}
  >
    <View
      className="w-14 h-14 rounded-2xl items-center justify-center mb-2"
      style={{ backgroundColor: `${color}20` }}
    >
      <Ionicons name={icon} size={26} color={color} />
    </View>
    <Text className="text-p01-gray text-xs">{label}</Text>
  </TouchableOpacity>
);

interface LinkRowProps {
  label: string;
  onPress: () => void;
}

const LinkRow: React.FC<LinkRowProps> = ({ label, onPress }) => (
  <TouchableOpacity
    className="flex-row items-center justify-between py-4 px-4"
    onPress={onPress}
    activeOpacity={0.7}
  >
    <Text className="text-white text-base">{label}</Text>
    <Ionicons name="open-outline" size={18} color="#666" />
  </TouchableOpacity>
);

export default function AboutScreen() {
  const router = useRouter();

  const socialLinks = [
    {
      icon: 'globe-outline' as const,
      label: 'Website',
      url: 'https://protocol01.dev',
      color: '#39c5bb',
    },
    {
      icon: 'logo-github' as const,
      label: 'GitHub',
      url: 'https://github.com/protocol-01',
      color: '#fff',
    },
    {
      icon: 'logo-twitter' as const,
      label: 'Twitter',
      url: 'https://twitter.com/protocol01',
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
    <SafeAreaView className="flex-1 bg-p01-void">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-4">
        <TouchableOpacity
          onPress={() => router.back()}
          className="w-10 h-10 rounded-full bg-p01-surface items-center justify-center"
        >
          <Ionicons name="arrow-back" size={20} color="#fff" />
        </TouchableOpacity>
        <Text className="text-white text-lg font-semibold">About</Text>
        <View className="w-10" />
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        {/* Logo and Version */}
        <View className="items-center py-8">
          {/* P-01 Logo Placeholder */}
          <View className="w-24 h-24 rounded-3xl bg-p01-surface items-center justify-center mb-4 border border-p01-cyan/30">
            <Text className="text-p01-cyan text-4xl font-bold">01</Text>
          </View>
          <Text className="text-white text-2xl font-bold">Protocol 01</Text>
          <Text className="text-p01-cyan text-base mt-1">P-01 Wallet</Text>
          <View className="flex-row items-center mt-3">
            <Text className="text-p01-gray text-sm">Version {APP_VERSION}</Text>
            <Text className="text-p01-gray/50 text-sm mx-2">|</Text>
            <Text className="text-p01-gray text-sm">Build {BUILD_NUMBER}</Text>
          </View>
        </View>

        {/* Social Links */}
        <View className="flex-row justify-center gap-6 py-6 mx-4">
          {socialLinks.map((link) => (
            <SocialLink key={link.label} {...link} />
          ))}
        </View>

        {/* Description */}
        <View className="mx-4 mb-6 p-4 bg-p01-surface rounded-2xl">
          <Text className="text-p01-gray text-sm leading-6 text-center">
            Protocol 01 is a privacy-focused Solana wallet that uses advanced cryptographic techniques including stealth addresses, ring signatures, and decoy transactions to protect your financial privacy.
          </Text>
        </View>

        {/* Legal Links */}
        <View className="mx-4 mb-6">
          <Text className="text-p01-gray text-xs font-semibold tracking-wider uppercase mb-2 px-4">
            Legal
          </Text>
          <View className="bg-p01-surface rounded-2xl overflow-hidden">
            <LinkRow
              label="Privacy Policy"
              onPress={() => Linking.openURL('https://protocol01.dev/privacy')}
            />
            <View className="h-px bg-p01-border mx-4" />
            <LinkRow
              label="Terms of Service"
              onPress={() => Linking.openURL('https://protocol01.dev/terms')}
            />
            <View className="h-px bg-p01-border mx-4" />
            <LinkRow
              label="Open Source Licenses"
              onPress={() => Linking.openURL('https://protocol01.dev/licenses')}
            />
          </View>
        </View>

        {/* Tech Stack */}
        <View className="mx-4 mb-6 p-4 bg-p01-surface rounded-2xl">
          <Text className="text-white text-sm font-semibold mb-3">Built With</Text>
          <View className="flex-row flex-wrap gap-2">
            {['Solana', 'React Native', 'Expo', 'Light Protocol', 'ZK Compression'].map((tech) => (
              <View key={tech} className="px-3 py-1.5 bg-p01-void rounded-full">
                <Text className="text-p01-gray text-xs">{tech}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Credits */}
        <View className="items-center py-4">
          <Text className="text-p01-gray/50 text-xs">
            Made with privacy in mind
          </Text>
          <View className="flex-row items-center mt-2">
            <Ionicons name="shield-checkmark" size={14} color="#39c5bb" />
            <Text className="text-p01-cyan/70 text-xs ml-1">
              Your keys, your coins
            </Text>
          </View>
        </View>

        {/* Debug Info (could be hidden in production) */}
        <TouchableOpacity
          className="mx-4 mt-4 py-3 items-center"
          onPress={() => {}}
          activeOpacity={0.5}
        >
          <Text className="text-p01-gray/30 text-xs">
            Tap 7 times to enable developer mode
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}
