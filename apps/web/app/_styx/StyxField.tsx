"use client";

import { useEffect, useRef } from "react";

/**
 * StyxField — ONE background for the whole page.
 *
 * Founder's brief, 2026-09-12: "un seul fond, uniforme, attaché à toute la
 * page, dynamique et intrigant, qui réagit à la souris, assez léger pour le
 * mobile". So: a fixed, full-viewport WebGL quad behind everything, drawing a
 * Grok-generated texture of the river of light (/styx/field.jpg, made from the
 * site's own tokens) through a slow domain-warp, with the cursor bending the
 * current and lighting a faint teal bloom where it passes.
 *
 * Cost, by design:
 *   - one draw call per frame, a 2-D texture lookup and a few noise samples
 *     per pixel; rendered at min(devicePixelRatio, 1) on a fine pointer and at
 *     0.6 on a coarse one (phones), then scaled by the compositor;
 *   - 60 fps only while the cursor moves (and for the first second after it
 *     leaves, so the release reads as one motion); idle it settles to ~24 fps, and on
 *     a coarse pointer it never exceeds 30 fps;
 *   - paused when the tab is hidden; a single still frame when the visitor
 *     prefers reduced motion;
 *   - if WebGL is unavailable or the context is lost, the same texture is
 *     shown as a plain <img>, so the page never depends on the GPU.
 *
 * Decorative only: aria-hidden, pointer-events none, z-index -1, so it sits
 * under the translucent header, the app and the footer alike.
 */

const VERT = `
attribute vec2 a;
varying vec2 v;
void main() { v = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }
`;

const FRAG = `
precision mediump float;
varying vec2 v;
uniform sampler2D u_tex;
uniform vec2 u_res;      /* canvas size in px */
uniform vec2 u_texRes;   /* texture size in px */
uniform vec2 u_mouse;    /* 0..1, y up */
uniform float u_time;
uniform float u_mouseOn;
/* [2026-09-13] the wake: four points that FOLLOW the cursor with growing lag
   (x, y in 0..1 with y down, weight 0..1) and how fast it moves (0..1). They
   are continuous by construction, so nothing pops in or out along the path. */
#define TRAIL 4
uniform vec3 u_trail[TRAIL];
uniform float u_speed;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s;
}

void main() {
  /* cover-fit the texture to the canvas */
  float ca = u_res.x / u_res.y, ta = u_texRes.x / u_texRes.y;
  vec2 uv = v;
  if (ca > ta) { uv.y = (uv.y - 0.5) * (ta / ca) + 0.5; } else { uv.x = (uv.x - 0.5) * (ca / ta) + 0.5; }
  uv.y = 1.0 - uv.y;

  /* slow drift + domain warp: the river keeps moving on its own */
  float t = u_time * 0.16;
  vec2 q = vec2(fbm(uv * 3.0 + vec2(t, 0.0)), fbm(uv * 3.0 + vec2(5.2, t * 0.8)));
  vec2 warp = (q - 0.5) * 0.14;

  /* the cursor bends the current: a soft radial push, strongest near it.
     Measured in SCREEN space (v, y up; u_mouse from clientX/Y, y down), with
     the x axis scaled by the canvas aspect so the reach is a circle on screen.
     The texture's uv has y flipped, so the push is converted before it is
     added to the sample coordinate. (2026-09-12: computed in texture space it
     landed on the opposite side of the pointer.) */
  vec2 m = vec2(u_mouse.x, 1.0 - u_mouse.y);
  vec2 d = v - m;
  d.x *= ca;
  float dist = length(d);
  float infl = smoothstep(0.62, 0.0, dist) * u_mouseOn;
  /* a fast sweep drags the current a little harder than a resting hand */
  vec2 push = normalize(d + 1e-4) * infl * (0.10 + 0.05 * u_speed)
            + vec2(-d.y, d.x) * infl * (0.06 + 0.03 * u_speed);
  float glow = infl * infl;
  /* the wake: the followers trail the cursor along its path and catch up
     when it rests, so a sweep stretches the light behind the hand and a
     still hand sees it gather back, with no step anywhere. */
  for (int i = 0; i < TRAIL; i++) {
    vec2 tm = vec2(u_trail[i].x, 1.0 - u_trail[i].y);
    vec2 td = v - tm;
    td.x *= ca;
    float ti = smoothstep(0.5, 0.0, length(td)) * u_trail[i].z;
    push += (normalize(td + 1e-4) * 0.04 + vec2(-td.y, td.x) * 0.04) * ti;
    glow += ti * ti * 0.35;
  }
  warp += vec2(push.x, -push.y);

  vec3 col = texture2D(u_tex, clamp(uv + warp, 0.001, 0.999)).rgb * 0.82;
  /* the light breathes along the current, slowly, so a still hand still sees it move */
  col *= 0.9 + 0.25 * fbm(uv * 2.0 + vec2(t * 1.7, -t * 1.1));

  /* a faint teal bloom under the cursor, in the brand accent */
  vec3 teal = vec3(0.224, 0.773, 0.733);
  col += teal * glow * (0.28 + 0.1 * u_speed);

  /* grain, so the gradients never band; re-rolled ~12 times a second, not
     every frame, so it never reads as flicker on the bloom */
  col += (hash(gl_FragCoord.xy + floor(u_time * 12.0)) - 0.5) * 0.015;

  gl_FragColor = vec4(col, 1.0);
}
`;

const TEXTURE = "/styx/field.jpg";

export default function StyxField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const fallback = imgRef.current;
    if (!canvas) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const coarse = window.matchMedia("(pointer: coarse)");
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "low-power" });

    const showFallback = () => {
      canvas.style.display = "none";
      if (fallback) fallback.style.display = "block";
      canvas.parentElement?.setAttribute("data-mode", "image");
    };
    if (!gl) { showFallback(); return; }

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    let prog: WebGLProgram;
    try {
      prog = gl.createProgram()!;
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link");
    } catch {
      showFallback();
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aLoc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(aLoc);
    gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
    const u = {
      res: gl.getUniformLocation(prog, "u_res"),
      texRes: gl.getUniformLocation(prog, "u_texRes"),
      mouse: gl.getUniformLocation(prog, "u_mouse"),
      time: gl.getUniformLocation(prog, "u_time"),
      mouseOn: gl.getUniformLocation(prog, "u_mouseOn"),
      trail: gl.getUniformLocation(prog, "u_trail"),
      speed: gl.getUniformLocation(prog, "u_speed"),
      tex: gl.getUniformLocation(prog, "u_tex"),
    };

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    /* 1x1 ink until the image arrives, so the first frame is never white */
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([7, 7, 9]));
    gl.uniform1i(u.tex, 0);
    let texW = 1, texH = 1;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      texW = img.naturalWidth; texH = img.naturalHeight;
      draw(performance.now());
    };
    img.onerror = showFallback;
    img.src = TEXTURE;

    /* state */
    let w = 0, h = 0;
    let raf = 0;
    let running = false;
    let visible = document.visibilityState === "visible";
    let lastFrame = 0;
    let lastMove = 0;
    const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, on: 0, ton: 0 };
    /* [2026-09-13] the wake and the speed. Four followers chase the eased
       head, each one the previous one's target, so they string out along the
       path while the hand moves and gather back when it rests. Continuous, so
       nothing can pop (the sampled-points version before this one dropped a
       fresh point every 45 ms and the eye read the drops as ticks; founder:
       "un effet de microtick trop intense"). Speed is read off the eased head,
       frame to frame, and eased again: no raw pointer-event jitter reaches
       the shader. */
    const TRAIL = 4;
    const trail = Array.from({ length: TRAIL }, () => ({ x: 0.5, y: 0.5 }));
    const trailData = new Float32Array(TRAIL * 3);
    const TRAIL_WEIGHT = [0.8, 0.6, 0.45, 0.3];
    let speed = 0;
    let prevX = 0.5, prevY = 0.5;
    let shownTension = -1;
    let lastDraw = 0;
    const start = performance.now();

    const resize = () => {
      const dpr = coarse.matches ? 0.6 : Math.min(window.devicePixelRatio || 1, 1);
      w = Math.max(1, Math.round(window.innerWidth * dpr));
      h = Math.max(1, Math.round(window.innerHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    const draw = (now: number) => {
      /* eases are written per 60 Hz frame and scaled by the real frame time,
         so a 240 Hz screen lets go at the same pace as a 60 Hz one (MEASURED
         2026-09-13 on a 242 Hz display: per-frame eases released in 0.4 s
         instead of the ~2 s they were tuned for). */
      const dt = lastDraw ? Math.min(50, now - lastDraw) : 16.7;
      lastDraw = now;
      const ease = (r: number) => 1 - Math.pow(1 - r, dt / 16.7);
      mouse.x += (mouse.tx - mouse.x) * ease(0.08);
      mouse.y += (mouse.ty - mouse.y) * ease(0.08);
      /* the hand arrives faster than it lets go: the release is the part the
         eye follows, so it gets the slower curve */
      mouse.on += (mouse.ton - mouse.on) * ease(mouse.ton > mouse.on ? 0.08 : 0.03);
      /* speed of the eased head in viewport widths per second, squashed to
         0..1 at ~2/s, then eased so it swells and settles instead of jumping */
      const v = Math.hypot(mouse.x - prevX, mouse.y - prevY) / (dt / 1000);
      prevX = mouse.x; prevY = mouse.y;
      speed += (Math.min(1, v * 0.5) - speed) * ease(0.05);
      let fx = mouse.x, fy = mouse.y;
      for (let i = 0; i < TRAIL; i++) {
        const f = trail[i];
        const k = ease(0.055);
        f.x += (fx - f.x) * k;
        f.y += (fy - f.y) * k;
        fx = f.x; fy = f.y;
        trailData[i * 3] = f.x;
        trailData[i * 3 + 1] = f.y;
        trailData[i * 3 + 2] = mouse.on * TRAIL_WEIGHT[i];
      }
      gl.uniform2f(u.res, w, h);
      gl.uniform2f(u.texRes, texW, texH);
      gl.uniform2f(u.mouse, mouse.x, mouse.y);
      gl.uniform1f(u.time, (now - start) / 1000);
      gl.uniform1f(u.mouseOn, mouse.on);
      gl.uniform3fv(u.trail, trailData);
      gl.uniform1f(u.speed, speed);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      /* observable from outside (probes, tests): how much the cursor is
         still bending the current, 0 once released. Written on change only. */
      const tension = Math.round(mouse.on * 20) / 20;
      if (tension !== shownTension) {
        shownTension = tension;
        canvas.parentElement?.setAttribute("data-tension", tension.toFixed(2));
      }
    };

    const frame = (now: number) => {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      /* fps budget: 60 while the cursor moves, 24 idle; never above 30 on a phone */
      const active = now - lastMove < 1200;
      const budget = coarse.matches ? 1000 / 30 : active ? 0 : 1000 / 24;
      if (now - lastFrame < budget) return;
      lastFrame = now;
      draw(now);
    };

    const update = () => {
      const want = visible && !reduced.matches;
      if (want && !running) { running = true; raf = requestAnimationFrame(frame); }
      if (!want && running) { running = false; cancelAnimationFrame(raf); }
    };

    const onMove = (e: PointerEvent) => {
      mouse.tx = e.clientX / window.innerWidth;
      mouse.ty = e.clientY / window.innerHeight;
      mouse.ton = 1;
      lastMove = performance.now();
    };
    /* [2026-09-13] RELEASE. `pointerleave` never fires on `window`, so the
       tension used to hold wherever the cursor left the page (founder: "quand
       le curseur quitte la page, la tension doit se relâcher dans le fond").
       Leaving the document is `pointerout` with no relatedTarget; a lifted
       finger is `pointerup`/`pointercancel`; a lost window is `blur`. The fade
       is drawn at the moving frame rate for its first second so it reads as
       one motion. */
    const release = () => { mouse.ton = 0; lastMove = performance.now(); };
    const onOut = (e: PointerEvent) => { if (e.relatedTarget === null) release(); };
    const onUp = (e: PointerEvent) => { if (e.pointerType !== "mouse") release(); };
    const onVisibility = () => {
      visible = document.visibilityState === "visible";
      if (!visible) release();
      update();
    };
    const onResize = () => { resize(); if (!running) draw(performance.now()); };
    const onLost = (e: Event) => { e.preventDefault(); running = false; cancelAnimationFrame(raf); showFallback(); };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerout", onOut);
    window.addEventListener("pointerup", onUp, { passive: true });
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize, { passive: true });
    canvas.addEventListener("webglcontextlost", onLost);
    reduced.addEventListener("change", update);

    resize();
    draw(performance.now());
    update();

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerout", onOut);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("webglcontextlost", onLost);
      reduced.removeEventListener("change", update);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return (
    <div className="styx-ground" aria-hidden="true" data-mode="webgl">
      <canvas ref={canvasRef} className="styx-ground-canvas" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={imgRef} className="styx-ground-fallback" src={TEXTURE} alt="" decoding="async" />
    </div>
  );
}
