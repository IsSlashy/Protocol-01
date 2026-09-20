/**
 * StyxRiver — the site's ground, on the phone.
 *
 * The web home draws ONE background under everything: a Grok still of the
 * river of light (apps/web/public/styx/field.jpg, made from the site's own
 * tokens) pulled through a slow domain-warp by a WebGL shader, with the cursor
 * bending the current (apps/web/app/_styx/StyxField.tsx). Until 2026-09-13 the
 * phone had a flat ink screen and a 3 % gradient, so the two products did not
 * look like one thing on the first screen a person sees.
 *
 * This is the same shader in SkSL, drawn by Skia. Same texture (rotated to
 * portrait so the current runs down the screen), same noise, same warp, same
 * touch response: a finger bends the current and lights a faint teal bloom
 * where it rests, and lets go on the slower curve.
 *
 * `flow` is the one thing the web version does not have: 0 is the site's
 * resting drift, 1 is the fast current of the speed film. The wallet-creation
 * screen drives it from 0.15 to 1 as the keys form, so the river itself is the
 * progress indicator.
 *
 * Cost: one runtime shader, four-octave noise, drawn at HALF resolution and
 * scaled by the compositor (the web does 0.6 on a coarse pointer). Reduced
 * motion freezes the clock. No image yet → plain ink, never a white flash.
 */
import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View, useWindowDimensions } from 'react-native';
import {
  Canvas,
  Fill,
  ImageShader,
  Shader,
  Skia,
  useClock,
  useImage,
} from '@shopify/react-native-skia';
import {
  useDerivedValue,
  useSharedValue,
  withTiming,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';

import { Colors } from '../../constants/theme';

const SKSL = `
uniform shader image;
uniform float2 uRes;
uniform float uTime;
uniform float2 uTouch;
uniform float uTouchOn;
uniform float uFlow;
uniform float uDim;

float hash(float2 p) { return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453); }
float noise(float2 p) {
  float2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + float2(1.0, 0.0)), f.x),
             mix(hash(i + float2(0.0, 1.0)), hash(i + float2(1.0, 1.0)), f.x), f.y);
}
float fbm(float2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s;
}

half4 main(float2 xy) {
  float2 uv = xy / uRes;
  /* the current runs DOWN the screen on a phone: drift along y */
  float t = uTime * (0.16 + 0.9 * uFlow);
  float2 q = float2(fbm(uv * 3.0 + float2(0.0, t)), fbm(uv * 3.0 + float2(5.2, t * 0.8)));
  float2 warp = (q - 0.5) * (0.14 + 0.08 * uFlow);
  warp.y *= 1.0 + uFlow * 1.5;

  /* the finger bends the current: a soft radial push, strongest under it.
     Measured on height so the reach is a circle on screen. */
  float2 d = (xy - uTouch) / uRes.y;
  float dist = length(d);
  float infl = smoothstep(0.55, 0.0, dist) * uTouchOn;
  float2 push = normalize(d + 1e-4) * infl * 0.10 + float2(-d.y, d.x) * infl * 0.06;
  warp += push;

  float3 col = image.eval(clamp(uv + warp, 0.001, 0.999) * uRes).rgb * 0.82;
  /* the light breathes along the current */
  col *= 0.9 + 0.25 * fbm(uv * 2.0 + float2(-t * 1.1, t * 1.7));

  float3 teal = float3(0.224, 0.773, 0.733);
  /* a faint teal bloom under the finger */
  col += teal * infl * infl * 0.28;
  /* thin streaks that only appear when the current runs */
  float band = noise(float2(uv.x * 60.0 + q.x * 4.0, uv.y * 2.0 - t * 4.0));
  col += teal * smoothstep(0.7, 0.96, band) * 0.35 * uFlow;

  /* grain, re-rolled ~12 times a second, so the gradients never band */
  col += (hash(xy + floor(uTime * 12.0)) - 0.5) * 0.015;
  col *= (1.0 - uDim);
  return half4(col, 1.0);
}`;

const EFFECT = Skia.RuntimeEffect.Make(SKSL);
const TEXTURE = require('../../assets/images/styx/field-portrait.jpg');

export interface StyxRiverProps {
  /** 0 = the site's resting drift, 1 = the fast current. A plain number or a shared value. */
  flow?: number | SharedValue<number>;
  /** Darkening, 0..1. Content sits on top, so most screens want some. */
  dim?: number;
  /** Whether a finger bends the current. Off where the screen is all controls. */
  touch?: boolean;
}

export const StyxRiver: React.FC<StyxRiverProps> = ({ flow = 0, dim = 0.35, touch = true }) => {
  const { width, height } = useWindowDimensions();
  const image = useImage(TEXTURE);
  const clock = useClock();
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => live && setReduceMotion(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);

  /* Half resolution: the canvas is laid out at half the window and scaled up
     by the compositor. Touch coordinates are halved to match. */
  const W = Math.ceil(width / 2);
  const H = Math.ceil(height / 2);

  const touchX = useSharedValue(W / 2);
  const touchY = useSharedValue(H / 2);
  const touchOn = useSharedValue(0);
  const flowShared = useSharedValue(typeof flow === 'number' ? flow : 0);
  useEffect(() => {
    if (typeof flow === 'number') flowShared.value = withTiming(flow, { duration: 600 });
  }, [flow, flowShared]);

  const uniforms = useDerivedValue(() => {
    const f = typeof flow === 'number' ? flowShared.value : flow.value;
    return {
      uRes: [W, H],
      uTime: reduceMotion ? 0 : clock.value / 1000,
      uTouch: [touchX.value, touchY.value],
      uTouchOn: touchOn.value,
      uFlow: f,
      uDim: dim,
    };
  }, [W, H, dim, reduceMotion, flow]);

  if (!EFFECT) return <View style={[StyleSheet.absoluteFill, { backgroundColor: Colors.background }]} />;

  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: Colors.background }]}
      pointerEvents={touch ? 'box-only' : 'none'}
      onTouchStart={(e) => {
        touchX.value = e.nativeEvent.locationX / 2;
        touchY.value = e.nativeEvent.locationY / 2;
        touchOn.value = withTiming(1, { duration: 500, easing: Easing.out(Easing.quad) });
      }}
      onTouchMove={(e) => {
        touchX.value = e.nativeEvent.locationX / 2;
        touchY.value = e.nativeEvent.locationY / 2;
      }}
      onTouchEnd={() => {
        /* the hand arrives faster than it lets go: the release is the part the eye follows */
        touchOn.value = withTiming(0, { duration: 1800, easing: Easing.out(Easing.cubic) });
      }}
      onTouchCancel={() => {
        touchOn.value = withTiming(0, { duration: 1800, easing: Easing.out(Easing.cubic) });
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {image ? (
        <Canvas
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: W,
            height: H,
            transform: [{ translateX: W / 2 }, { translateY: H / 2 }, { scale: 2 }],
          }}
        >
          <Fill>
            <Shader source={EFFECT} uniforms={uniforms}>
              <ImageShader image={image} fit="cover" x={0} y={0} width={W} height={H} />
            </Shader>
          </Fill>
        </Canvas>
      ) : null}
    </View>
  );
};

export default StyxRiver;
