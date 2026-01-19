import React, { useEffect, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated';

interface LogoProps {
  size?: number;
  showText?: boolean;
  animated?: boolean;
}

const AnimatedView = Animated.createAnimatedComponent(View);

// ULTRAKILL STYLE - Chaotic, not linear
export const Logo: React.FC<LogoProps> = ({
  size = 280,
  showText = false,
  animated = true,
}) => {
  // Logo glitch state
  const [glitchState, setGlitchState] = useState({
    cyanX: 0,
    cyanY: 0,
    pinkX: 0,
    pinkY: 0,
    mainX: 0,
    mainY: 0,
    rotation: 0,
    scale: 1,
    showSlice: false,
    sliceY: 0,
    sliceX: 0,
  });

  // Text glitch state - SEPARATE timing
  const [textGlitch, setTextGlitch] = useState({
    offsetX: 0,
    skew: 0,
    showCyan: false,
    showPink: false,
    cyanX: 0,
    pinkX: 0,
  });

  const baseOpacity = useSharedValue(1);

  useEffect(() => {
    if (!animated) return;

    // LOGO glitch - fast chaotic
    const logoGlitchLoop = () => {
      const intensity = Math.random();
      if (intensity > 0.3) {
        setGlitchState({
          cyanX: (Math.random() - 0.5) * 12,
          cyanY: (Math.random() - 0.5) * 8,
          pinkX: (Math.random() - 0.5) * 10,
          pinkY: (Math.random() - 0.5) * 6,
          mainX: (Math.random() - 0.5) * 4,
          mainY: (Math.random() - 0.5) * 3,
          rotation: (Math.random() - 0.5) * 2,
          scale: 0.98 + Math.random() * 0.04,
          showSlice: intensity > 0.7,
          sliceY: Math.random() * 80,
          sliceX: (Math.random() - 0.5) * 40,
        });

        setTimeout(() => {
          setGlitchState(prev => ({
            ...prev,
            cyanX: (Math.random() - 0.5) * 4,
            cyanY: (Math.random() - 0.5) * 2,
            pinkX: (Math.random() - 0.5) * 3,
            pinkY: (Math.random() - 0.5) * 2,
            mainX: 0,
            mainY: 0,
            rotation: 0,
            scale: 1,
            showSlice: false,
          }));
        }, 50 + Math.random() * 100);
      }
    };

    // TEXT glitch - slower, different rhythm
    const textGlitchLoop = () => {
      const intensity = Math.random();
      if (intensity > 0.5) {
        setTextGlitch({
          offsetX: (Math.random() - 0.5) * 6,
          skew: (Math.random() - 0.5) * 4,
          showCyan: true,
          showPink: true,
          cyanX: -2 - Math.random() * 3,
          pinkX: 2 + Math.random() * 3,
        });

        setTimeout(() => {
          setTextGlitch({
            offsetX: 0,
            skew: 0,
            showCyan: false,
            showPink: false,
            cyanX: 0,
            pinkX: 0,
          });
        }, 80 + Math.random() * 120);
      }
    };

    // Logo: fast irregular interval
    const scheduleLogoGlitch = () => {
      const delay = 100 + Math.random() * 400;
      return setTimeout(() => {
        logoGlitchLoop();
        logoTimerId = scheduleLogoGlitch();
      }, delay);
    };

    // Text: slower, different rhythm
    const scheduleTextGlitch = () => {
      const delay = 800 + Math.random() * 1500;
      return setTimeout(() => {
        textGlitchLoop();
        textTimerId = scheduleTextGlitch();
      }, delay);
    };

    let logoTimerId = scheduleLogoGlitch();
    let textTimerId = scheduleTextGlitch();

    return () => {
      clearTimeout(logoTimerId);
      clearTimeout(textTimerId);
    };
  }, [animated]);

  const flickerStyle = useAnimatedStyle(() => ({
    opacity: baseOpacity.value,
  }));

  return (
    <View style={styles.container}>
      {/* Main logo container */}
      <AnimatedView
        style={[
          styles.logoWrapper,
          {
            width: size,
            height: size * 0.5,
            transform: [
              { translateX: glitchState.mainX },
              { translateY: glitchState.mainY },
              { rotate: `${glitchState.rotation}deg` },
              { scale: glitchState.scale },
            ],
          },
          flickerStyle,
        ]}
      >
        {/* Cyan channel */}
        <Image
          source={require('../../assets/images/01-miku.png')}
          style={[
            styles.layer,
            {
              width: size,
              height: size * 0.5,
              opacity: 0.6,
              tintColor: '#39c5bb',
              transform: [
                { translateX: glitchState.cyanX },
                { translateY: glitchState.cyanY },
              ],
            },
          ]}
          resizeMode="contain"
        />

        {/* Pink channel */}
        <Image
          source={require('../../assets/images/01-miku.png')}
          style={[
            styles.layer,
            {
              width: size,
              height: size * 0.5,
              opacity: 0.5,
              tintColor: '#ff2d7a',
              transform: [
                { translateX: glitchState.pinkX },
                { translateY: glitchState.pinkY },
              ],
            },
          ]}
          resizeMode="contain"
        />

        {/* Main image */}
        <Image
          source={require('../../assets/images/01-miku.png')}
          style={[
            styles.mainImage,
            { width: size, height: size * 0.5 },
          ]}
          resizeMode="contain"
        />

        {/* Slice glitch */}
        {glitchState.showSlice && (
          <View
            style={[
              styles.glitchSlice,
              {
                top: glitchState.sliceY,
                width: size,
                transform: [{ translateX: glitchState.sliceX }],
              },
            ]}
          >
            <Image
              source={require('../../assets/images/01-miku.png')}
              style={{
                width: size,
                height: size * 0.5,
                marginTop: -glitchState.sliceY,
                tintColor: Math.random() > 0.5 ? '#39c5bb' : '#ff2d7a',
              }}
              resizeMode="contain"
            />
          </View>
        )}
      </AnimatedView>

      {/* PROTOCOL text with own glitch rhythm */}
      {showText && (
        <View style={styles.textContainer}>
          {/* Cyan ghost layer */}
          {textGlitch.showCyan && (
            <Text style={[
              styles.protocolText,
              styles.cyanText,
              { transform: [{ translateX: textGlitch.cyanX }] }
            ]}>
              PROTOCOL
            </Text>
          )}

          {/* Pink ghost layer */}
          {textGlitch.showPink && (
            <Text style={[
              styles.protocolText,
              styles.pinkText,
              { transform: [{ translateX: textGlitch.pinkX }] }
            ]}>
              PROTOCOL
            </Text>
          )}

          {/* Main text */}
          <Text style={[
            styles.protocolText,
            {
              transform: [
                { translateX: textGlitch.offsetX },
                { skewX: `${textGlitch.skew}deg` },
              ],
            }
          ]}>
            PROTOCOL
          </Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
  },
  logoWrapper: {
    position: 'relative',
  },
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  mainImage: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  glitchSlice: {
    position: 'absolute',
    left: 0,
    height: 15,
    overflow: 'hidden',
    zIndex: 5,
  },
  textContainer: {
    marginTop: 24,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    height: 30,
  },
  protocolText: {
    position: 'absolute',
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 12,
    textTransform: 'uppercase',
    // Sharp industrial look
    fontFamily: 'monospace',
  },
  cyanText: {
    color: '#39c5bb',
    opacity: 0.7,
  },
  pinkText: {
    color: '#ff2d7a',
    opacity: 0.7,
  },
});

export default Logo;
