/**
 * The Discover tab. One screen for now: the merchant list.
 *
 * Headers are off because the screen draws its own, the way the other tab
 * groups in this app do. A stack header plus a screen header is the double
 * title bar that made every route here start 56pt lower than it needed to.
 */
import { Stack } from 'expo-router';

export default function DiscoverLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
