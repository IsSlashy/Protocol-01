/**
 * The Styx mark.
 *
 * ⛔ REPLACES THE 01 LOGO. Founder ruling 2026-08-23. The old mark was a glitch
 * numeral in hot pink built on `assets/images/01-miku.png`, which is three
 * retired things in one asset: the numeral, the pink, and the arcade treatment.
 *
 * 🚨 AND THE FIRST REPLACEMENT I DREW WAS ALSO WRONG. On the Chrome extension I
 * invented a circle-and-crossbar glyph, and the answer was "le logo n'est pas
 * le notre". It was not. Inventing a mark for a brand that already has one is
 * not a design decision, it is a failure to look.
 *
 * The real mark is `apps/web/public/styx-mark.png`: a high-contrast serif S cut
 * by a cyan diagonal. It is COMPOSED here rather than shipped as an image,
 * because the app now loads Newsreader for its display type, so the letterform
 * is a font we already have and the cut is one line. That means it scales to
 * any size, takes the colour it is given, and needs no @2x/@3x raster set.
 *
 * ⚠️ Same prop names as `components/onboarding/Logo.tsx` so call sites do not
 * have to change.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Line } from 'react-native-svg';

import { Colors, FontFamily } from '../../constants/theme';

interface WordmarkProps {
  /** Height of the mark in points. The name scales with it. */
  size?: number;
  showText?: boolean;
  /** Accepted for parity with the mark this replaces. The mark does not move. */
  animated?: boolean;
  /** Override the letterform colour. The cut is always the accent. */
  color?: string;
}

export const Wordmark: React.FC<WordmarkProps> = ({
  size = 32,
  showText = false,
  color = Colors.text,
}) => {
  return (
    <View style={styles.row}>
      <View
        style={[styles.mark, { width: size, height: size }]}
        accessible
        accessibilityRole="image"
        accessibilityLabel="Styx"
      >
        {/* The letterform, in the same face the headings use. That is what
            makes the mark and the interface read as one thing rather than a
            logo pasted on top of one. */}
        <Text
          style={[
            styles.letter,
            { fontSize: size * 1.02, lineHeight: size * 1.02, color },
          ]}
          allowFontScaling={false}
        >
          S
        </Text>

        {/* The cut, edge to edge. */}
        <Svg
          width={size}
          height={size}
          viewBox="0 0 32 32"
          style={StyleSheet.absoluteFill}
        >
          <Line
            x1="27.5"
            y1="4.5"
            x2="4.5"
            y2="27.5"
            stroke={Colors.primary}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </Svg>
      </View>

      {showText && (
        <Text
          style={[styles.name, { fontSize: Math.max(15, size * 0.6), color }]}
          allowFontScaling={false}
        >
          Styx
        </Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  mark: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  letter: {
    fontFamily: FontFamily.display,
    textAlign: 'center',
  },
  name: {
    fontFamily: FontFamily.display,
    letterSpacing: -0.4,
  },
});

export default Wordmark;
