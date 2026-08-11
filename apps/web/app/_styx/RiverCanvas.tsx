"use client";

import { useEffect, useRef } from "react";

/**
 * The river. The one motion gesture this design allows itself.
 *
 * Layered sine currents drifting under the hero, plus a single brighter thread,
 * the oath line, carrying a slow travelling light. Adapted from the direction B
 * canvas, with two deliberate changes for the Styx palette:
 *
 *  - The field is drawn in PAPER at 0.02 to 0.055 alpha, not in cyan. Cyan is a
 *    seal here, not a colour, so the only cyan in the whole canvas is the light
 *    travelling along the oath line.
 *  - The current is driven by SCROLL. At rest the river is nearly flat, a
 *    whisper. As you scroll through the hero it forms: amplitude and alpha rise
 *    together. As the hero leaves, it recedes, so nothing bleeds into the
 *    sections below and no reader ever has to scroll past a moving background.
 *
 * Plain 2D canvas and requestAnimationFrame, no animation library. A tweening
 * engine interpolates between two states; this is a field recomputed every
 * frame, so there is nothing for one to do. The scroll link is the ~15 lines in
 * `targetReveal` below.
 *
 * Costs are bounded: pauses when the tab is hidden or the canvas leaves the
 * viewport, renders one coherent static frame under prefers-reduced-motion, and
 * drops line count and device pixel ratio on small or coarse-pointer screens.
 */
export default function RiverCanvas({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const small = window.matchMedia("(max-width: 720px), (pointer: coarse)");

    let raf = 0;
    let running = false;
    let tabVisible = document.visibilityState === "visible";
    let inView = true;
    let w = 0;
    let h = 0;
    let t = 0;
    let last = performance.now();

    /** Smoothed 0..1. `reveal` chases `target` so scroll jitter never shows. */
    let reveal = 0.18;
    let target = 0.18;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, small.matches ? 1 : 1.5);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

    /**
     * How much river to show, from where the stage sits in the viewport.
     *
     * 0.18 at rest so arrival is not a blank ground, rising to 1 across the
     * first screen of scrolling, then falling back to 0 as the stage leaves so
     * the current never runs behind the reading sections.
     */
    const targetReveal = () => {
      const rect = canvas.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      /* Formed over the first THIRD of the hero's height, not over all of it.
         Mapping the ramp to the full height meant the river only reached full
         amplitude once the hero had scrolled away, so the gesture peaked where
         nobody was looking. A third is roughly two turns of a wheel: the current
         is fully there while the hero is still the thing on screen. */
      const scrolled = clamp01(-rect.top / Math.max(1, rect.height * 0.33));
      // Then it recedes as the stage leaves, so it never runs behind the reading
      // sections below.
      const onScreen = clamp01((rect.bottom - vh * 0.1) / Math.max(1, rect.height * 0.5));
      const formed = 0.18 + 0.82 * scrolled;
      return clamp01(formed * onScreen);
    };

    const wave = (
      x: number,
      baseY: number,
      amp1: number,
      amp2: number,
      k1: number,
      ph: number,
      drift: number,
      a: number,
    ) =>
      baseY +
      Math.sin(x * k1 + drift + ph) * amp1 * a +
      Math.sin(x * 0.011 - drift * 0.7 + ph * 2.3) * amp2 * a;

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      if (reveal <= 0.005) return;

      const lines = small.matches ? 12 : 22;
      const step = small.matches ? 22 : 14;
      const top = h * 0.46;
      const span = h * 0.58;
      // Amplitude eases in faster than opacity, so the river forms before it
      // brightens rather than sliding in as a flat grey band.
      const amp = Math.pow(reveal, 0.65);

      for (let i = 0; i < lines; i++) {
        const d = i / (lines - 1); // 0 = far, 1 = near
        const baseY = top + d * span;
        const drift = t * (0.5 + d * 0.9);

        ctx.beginPath();
        for (let x = -step; x <= w + step; x += step) {
          const y = wave(x, baseY, 6 + d * 18, 2 + d * 6, 0.0038 - d * 0.0012, i * 1.7, drift, amp);
          if (x === -step) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        // Paper, never cyan. The far lines are barely there on purpose.
        const alpha = (0.02 + d * 0.035) * reveal;
        ctx.strokeStyle = `rgba(234, 231, 223, ${alpha.toFixed(4)})`;
        ctx.lineWidth = d > 0.85 ? 1.25 : 1;
        ctx.stroke();
      }

      // The oath line: one brighter thread, and the only cyan on the canvas.
      const od = 0.34;
      const baseY = top + od * span;
      const drift = t * (0.5 + od * 0.9);
      ctx.beginPath();
      for (let x = -step; x <= w + step; x += step) {
        const y = wave(x, baseY, 6 + od * 18, 2 + od * 6, 0.0038 - od * 0.0012, 5.1, drift, amp);
        if (x === -step) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const p = ((t * 0.32) % 1.4) - 0.2;
      const grad = ctx.createLinearGradient(0, 0, Math.max(1, w), 0);
      const base = `rgba(234, 231, 223, ${(0.09 * reveal).toFixed(4)})`;
      grad.addColorStop(0, base);
      grad.addColorStop(clamp01(p - 0.2), base);
      grad.addColorStop(clamp01(p), `rgba(57, 197, 187, ${(0.4 * reveal).toFixed(4)})`);
      grad.addColorStop(clamp01(p + 0.2), base);
      grad.addColorStop(1, base);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    };

    const frame = (now: number) => {
      const dt = Math.min(50, now - last);
      last = now;
      t += dt * 0.00024; // a slow, continuous current
      // Critically damped chase: no overshoot, no visible stepping.
      reveal += (target - reveal) * Math.min(1, dt * 0.006);
      draw();
      raf = requestAnimationFrame(frame);
    };

    const update = () => {
      const shouldRun = tabVisible && inView && !reduced.matches;
      if (shouldRun && !running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      } else if (!shouldRun && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };

    const onScroll = () => {
      target = targetReveal();
      // When motion is off there is no loop to pick the new value up, so the
      // static frame is redrawn at the scrolled position instead.
      if (reduced.matches) {
        reveal = target;
        draw();
      }
    };

    const onVisibility = () => {
      tabVisible = document.visibilityState === "visible";
      update();
    };

    const onMediaChange = () => {
      resize();
      target = targetReveal();
      if (reduced.matches) reveal = target;
      draw();
      update();
    };

    const io = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting ?? true;
        update();
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    const ro = new ResizeObserver(() => {
      resize();
      target = targetReveal();
      if (!running) draw();
    });
    ro.observe(canvas);

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    reduced.addEventListener("change", onMediaChange);
    small.addEventListener("change", onMediaChange);

    resize();
    target = targetReveal();
    reveal = reduced.matches ? Math.max(0.5, target) : target;
    draw();
    update();

    return () => {
      cancelAnimationFrame(raf);
      running = false;
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      reduced.removeEventListener("change", onMediaChange);
      small.removeEventListener("change", onMediaChange);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
