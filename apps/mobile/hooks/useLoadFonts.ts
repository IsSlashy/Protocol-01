import { useFonts } from 'expo-font';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from '@expo-google-fonts/jetbrains-mono';
/**
 * 🎯 ADDED 2026-08-23. Newsreader is the display face on protocol-01.dev and,
 * since the same day, in the Chrome extension. The mobile app had Inter and a
 * mono and no display voice at all, so every heading was Inter-Bold: the same
 * face as body text, one weight louder. Three surfaces, one brand, one
 * letterform for the things that carry it.
 *
 * Light weights only. The site sets display type at 300 and titles at 400; a
 * bold serif is a different product.
 */
import {
  Newsreader_300Light,
  Newsreader_400Regular,
} from '@expo-google-fonts/newsreader';
import { Ionicons } from '@expo/vector-icons';

export function useLoadFonts() {
  const [fontsLoaded, fontError] = useFonts({
    'Inter-Regular': Inter_400Regular,
    'Inter-Medium': Inter_500Medium,
    'Inter-SemiBold': Inter_600SemiBold,
    'Inter-Bold': Inter_700Bold,
    'JetBrainsMono-Regular': JetBrainsMono_400Regular,
    'JetBrainsMono-Medium': JetBrainsMono_500Medium,
    'Newsreader-Light': Newsreader_300Light,
    'Newsreader-Regular': Newsreader_400Regular,
    ...Ionicons.font,
  });

  return {
    fontsLoaded,
    fontError,
  };
}
