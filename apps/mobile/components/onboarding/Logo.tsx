/**
 * Logo — the onboarding mark.
 *
 * ⛔ WHAT THIS FILE USED TO BE. Three stacked copies of
 * `assets/images/01-miku.png`, tinted and offset by two `setTimeout` loops
 * re-running `Math.random()` every 100–400ms, plus a "slice" layer, plus the
 * word PROTOCOL in 900-weight monospace at 12pt of letter-spacing with its own
 * chromatic-aberration ghosts. The header called it "ULTRAKILL STYLE". It was
 * the loudest thing in the app and it was on the FIRST screen a new user saw.
 *
 * Three separate rulings landed on it at once on 2026-08-23:
 *   - the 01 numeral is retired as a mark
 *   - pink is retired as a colour
 *   - the glitch/cyberpunk house style is being removed everywhere
 *
 * So the internals are now `components/common/Wordmark`: a serif S cut by a
 * cyan diagonal, composed from the display face rather than shipped as a
 * raster. 🚨 It is COMPOSED, not invented — the mark already existed at
 * `apps/web/public/styx-mark.png`, and the extension's first attempt at this
 * replacement drew a new glyph and was rejected for it.
 *
 * ⚠️ THE NAME AND THE PROPS ARE DELIBERATELY UNCHANGED. Four call sites import
 * `Logo` (`(onboarding)/index`, `(onboarding)/create-wallet`, `AuthScreen`, and
 * this module's barrel) and none of them had to be touched. `animated` is
 * accepted and ignored: the mark does not move any more, and a prop that
 * silently disappears is a compile error at four sites for no gain.
 *
 * ⚠️ SIZE IS MAPPED, NOT FORWARDED. The old mark was a landscape raster drawn
 * `size` wide by `size / 2` tall. The Wordmark is square. Passing `size`
 * straight through would have doubled the mark's HEIGHT on every existing
 * screen without a single call site changing, which is the kind of regression
 * that ships because the diff looks clean. Half of it keeps the optical height
 * the layouts were built around.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';

import { Wordmark } from '../common/Wordmark';

interface LogoProps {
  /** Width the old raster occupied. The mark renders at half of it, square. */
  size?: number;
  showText?: boolean;
  /** Accepted for call-site parity. The mark no longer animates. */
  animated?: boolean;
}

export const Logo: React.FC<LogoProps> = ({ size = 280, showText = false }) => {
  return (
    <View style={styles.container}>
      <Wordmark size={Math.round(size * 0.5)} showText={showText} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
  },
});

export default Logo;
