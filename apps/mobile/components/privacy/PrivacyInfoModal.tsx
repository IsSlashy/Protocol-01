import React from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

interface Section {
  title: string;
  text: string;
}

interface PrivacyInfoModalProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle: string;
  sections: Section[];
}

export default function PrivacyInfoModal({
  visible,
  onClose,
  title,
  subtitle,
  sections,
}: PrivacyInfoModalProps) {
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={[styles.iconWrap, { backgroundColor: P01Colors.cyanDim }]}>
              <Ionicons name="shield-checkmark" size={28} color={P01Colors.cyan} />
            </View>
            <View>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.subtitle}>{subtitle}</Text>
            </View>
          </View>

          <ScrollView style={styles.scroll}>
            {sections.map((section, i) => (
              <View key={i} style={styles.section}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <Text style={styles.sectionText}>{section.text}</Text>
              </View>
            ))}
          </ScrollView>

          <TouchableOpacity
            style={[styles.button, { backgroundColor: P01Colors.cyan }]}
            onPress={onClose}
          >
            <Text style={styles.buttonText}>Got it</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'flex-end',
  },
  content: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    margin: Spacing.lg,
    padding: Spacing.lg,
    maxHeight: '80%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: Spacing.lg,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  scroll: {
    marginBottom: Spacing.md,
  },
  section: {
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  sectionTitle: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  sectionText: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  button: {
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    alignItems: 'center',
  },
  buttonText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
});
