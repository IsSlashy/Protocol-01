import React from 'react';
import { View, StatusBar, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';

interface ScreenWrapperProps {
  children: React.ReactNode;
  scrollable?: boolean;
  safeArea?: boolean;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
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
  withGradient = false,
  keyboardAvoiding = false,
  className,
  contentContainerClassName,
}) => {
  const Container = safeArea ? SafeAreaView : View;

  const renderContent = () => {
    if (scrollable) {
      return (
        <ScrollView
          className="flex-1"
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
          className="flex-1"
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
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0c" />
      {withGradient ? (
        <LinearGradient
          colors={['#0a0a0c', '#0f0f12', '#0a0a0c']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          className={`flex-1 ${className || ''}`}
        >
          <Container
            edges={edges}
            className="flex-1"
          >
            {renderWithKeyboardAvoiding()}
          </Container>
        </LinearGradient>
      ) : (
        <Container
          edges={edges}
          className={`flex-1 bg-p01-void ${className || ''}`}
        >
          {renderWithKeyboardAvoiding()}
        </Container>
      )}
    </>
  );
};

export default ScreenWrapper;
