import React, { useEffect, useRef, useState } from 'react';
import { continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';

/**
 * The river, animated.
 *
 * Takes one of the Grok stills (apps/weekly-update/public/speed/*.jpg, generated
 * 2026-09-13 with grok-imagine-image-2.0 from the styx.css tokens) and moves it:
 * the texture is sampled through a domain-warped noise field advected along x,
 * and thin additive teal streaks ride the flow. Speed and displacement are
 * blended across a vertical split so ONE canvas can hold a stagnant left bank
 * and a fast right current, which is the whole before/after image of the film.
 *
 * Deterministic: the only time input is the frame number, so a chunked render
 * (scripts/render-chunked.mjs) produces the same picture for the same frame in
 * any process. Drawn at half resolution and scaled by CSS; the picture is soft
 * by design and a 4K WebGL surface per frame is what bluescreens this machine.
 */
export type FlowProps = {
  src: string;
  /** Flow speed at the left and right edge, in texture widths per second. */
  speedLeft: number;
  speedRight: number;
  /** Displacement amplitude at each edge, in texture widths. */
  ampLeft: number;
  ampRight: number;
  /** Where the blend sits (0..1) and how wide it is. */
  split?: number;
  softness?: number;
  /** Additive teal streak intensity, 0..1, scaled by the local speed. */
  streak?: number;
  /** Darkening, 0..1. */
  dim?: number;
  /** Aspect of the source image (w / h). */
  srcAspect: number;
  /** Time offset in seconds so two scenes never start on the same phase. */
  phase?: number;
};

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform float uTime;
uniform float uSpeedL, uSpeedR, uAmpL, uAmpR, uSplit, uSoft, uStreak, uDim;
uniform vec2 uCover;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(17.0, 9.0); a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = vUv;
  float k = smoothstep(uSplit - uSoft, uSplit + uSoft, uv.x);
  float speed = mix(uSpeedL, uSpeedR, k);
  float amp = mix(uAmpL, uAmpR, k);

  vec2 p = vec2(uv.x * 3.0 - uTime * speed, uv.y * 3.0);
  float n1 = fbm(p);
  float n2 = fbm(p + vec2(5.2, 1.3) + vec2(uTime * speed * 0.3, 0.0));
  vec2 disp = (vec2(n1, n2) - 0.5) * amp;
  disp.x *= 1.0 + speed * 2.0;

  vec2 suv = uv + disp;
  vec2 tuv = 0.5 + (suv - 0.5) * uCover;
  vec3 col = texture2D(uTex, tuv).rgb;

  float band = noise(vec2(uv.x * 2.0 - uTime * speed * 4.0, uv.y * 70.0 + n1 * 5.0));
  float streak = smoothstep(0.66, 0.96, band) * uStreak * (0.35 + 0.65 * k) * (0.4 + 0.6 * n2);
  col += vec3(0.224, 0.773, 0.733) * streak * 0.6 * min(1.0, speed * 3.0 + 0.15);

  float vig = smoothstep(1.35, 0.35, length((uv - 0.5) * vec2(1.6, 1.0)));
  col *= (1.0 - uDim) * (0.55 + 0.45 * vig);
  gl_FragColor = vec4(col, 1.0);
}`;

type Gl = {
  gl: WebGLRenderingContext;
  u: Record<string, WebGLUniformLocation | null>;
};

export const FlowField: React.FC<FlowProps> = ({
  src,
  speedLeft,
  speedRight,
  ampLeft,
  ampRight,
  split = 0.5,
  softness = 0.08,
  streak = 0.8,
  dim = 0.3,
  srcAspect,
  phase = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<Gl | null>(null);
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender(`Loading ${src}`));

  const W = Math.round(width / 2);
  const H = Math.round(height / 2);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', {
      preserveDrawingBuffer: true,
      antialias: false,
      premultipliedAlpha: false,
    });
    if (!gl) {
      console.error('WebGL unavailable, the river stays still');
      continueRender(handle);
      return;
    }
    const compile = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      }
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const names = [
      'uTex', 'uTime', 'uSpeedL', 'uSpeedR', 'uAmpL', 'uAmpR',
      'uSplit', 'uSoft', 'uStreak', 'uDim', 'uCover',
    ];
    const u: Gl['u'] = {};
    for (const n of names) u[n] = gl.getUniformLocation(prog, n);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      gl.uniform1i(u.uTex, 0);
      glRef.current = { gl, u };
      setReady(true);
      continueRender(handle);
    };
    img.onerror = (e) => {
      console.error('river texture failed', e);
      continueRender(handle);
    };
    img.src = src;

    return () => {
      glRef.current = null;
      continueRender(handle);
    };
  }, [src, handle]);

  useEffect(() => {
    const g = glRef.current;
    if (!g || !ready) return;
    const { gl, u } = g;
    gl.viewport(0, 0, W, H);
    const canvasAspect = W / H;
    /* Cover-fit: crop the axis on which the image is larger than the frame. */
    const cover =
      srcAspect < canvasAspect ? [1, srcAspect / canvasAspect] : [canvasAspect / srcAspect, 1];
    gl.uniform1f(u.uTime, frame / fps + phase);
    gl.uniform1f(u.uSpeedL, speedLeft);
    gl.uniform1f(u.uSpeedR, speedRight);
    gl.uniform1f(u.uAmpL, ampLeft);
    gl.uniform1f(u.uAmpR, ampRight);
    gl.uniform1f(u.uSplit, split);
    gl.uniform1f(u.uSoft, softness);
    gl.uniform1f(u.uStreak, streak);
    gl.uniform1f(u.uDim, dim);
    gl.uniform2f(u.uCover, cover[0], cover[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }, [frame, fps, ready, W, H, speedLeft, speedRight, ampLeft, ampRight, split, softness, streak, dim, srcAspect, phase]);

  return (
    <canvas
      ref={canvasRef}
      width={W}
      height={H}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
    />
  );
};
