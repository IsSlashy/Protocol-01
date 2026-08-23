/**
 * ScreenWrapper — safe area, keyboard, optional scroll, and the ground colour.
 *
 * ⛔ THE GRADIENT IS GONE. `withGradient` painted a diagonal
 * `#070709 → #0d0d10 → #070709` behind the whole screen. Two things were wrong
 * with it: the ground is one flat ink on the site and in the extension, and the
 * gradient's own stops were hardcoded here, so the theme realignment could not
 * reach them — a screen using it kept the old ground while its neighbours moved.
 *
 * ⚠️ THE PROP STAYS AND IS ACCEPTED, so no call site has to change; it simply
 * renders the flat ground now. Delete it when nothing passes it any more.
 */

import React from 'react';
import {
  View,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';

interface ScreenWrapperProps {
  children: React.ReactNode;
  scrollable?: boolean;
  safeArea?: boolean;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  /** Accepted for compatibility. The ground is flat; see the note above. */
  withGradient?: boolean;
  keyboardAvoiding?: boolean;
  className?: string;
  contentContainerClassName?: string;
}

export const ScreenWrapper: React.FC<ScreenWrapperProps> = ({
  children,
  scrollable = false,
  safeArea = true,
  edges = ['top', 'bottom'],
  keyboardAvoiding = false,
  className,
  contentContainerClassName,
}) => {
  const Container = safeArea ? SafeAreaView : View;

  const renderContent = () => {
    if (scrollable) {
      return (
        <ScrollView
          style={styles.flex}
          contentContainerClassName={contentContainerClassName}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      );
    }
    return <>{children}</>;
  };

  const renderWithKeyboardAvoiding = () => {
    if (keyboardAvoiding) {
      return (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          {renderContent()}
        </KeyboardAvoidingView>
      );
    }
    return renderContent();
  };

  return (
    <>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
      <Container edges={edges} style={styles.ground} className={className}>
        {renderWithKeyboardAvoiding()}
      </Container>
    </>
  );
};

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  ground: {
    flex: 1,
    backgroundColor: Colors.background,
  },
});

export default ScreenWrapper;
