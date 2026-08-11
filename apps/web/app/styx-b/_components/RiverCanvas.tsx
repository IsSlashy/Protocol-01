"use client";

import { useEffect, useRef } from "react";

/**
 * The river. Layered sine currents drifting slowly across the hero,
 * plus one brighter thread (the oath line) carrying a travelling light.
 *
 * Plain 2D canvas + requestAnimationFrame, no libraries.
 * - pauses when the tab is hidden or the canvas leaves the viewport
 * - renders a single static frame under prefers-reduced-motion
 * - drops line density and DPR on small / coarse-pointer screens
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
    let t = Math.random() * 400;
    let last = performance.now();

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

    const wave = (
      x: number,
      baseY: number,
      amp1: number,
      amp2: number,
      k1: number,
      ph: number,
      drift: number,
    ) =>
      baseY +
      Math.sin(x * k1 + drift + ph) * amp1 +
      Math.sin(x * 0.011 - drift * 0.7 + ph * 2.3) * amp2;

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const lines = small.matches ? 14 : 26;
      const step = small.matches ? 22 : 14;
      const top = h * 0.42;
      const span = h * 0.62;

      for (let i = 0; i < lines; i++) {
        const d = i / (lines - 1); // 0 = far, 1 = near
        const baseY = top + d * span;
        const amp1 = 6 + d * 18;
        const amp2 = 2 + d * 6;
        const k1 = 0.0038 - d * 0.0012;
        const ph = i * 1.7;
        const drift = t * (0.5 + d * 0.9);

        ctx.beginPath();
        for (let x = -step; x <= w + step; x += step) {
          const y = wave(x, baseY, amp1, amp2, k1, ph, drift);
          if (x === -step) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        const alpha = 0.03 + d * 0.09;
        ctx.strokeStyle = `rgba(57, 197, 187, ${alpha.toFixed(3)})`;
        ctx.lineWidth = d > 0.85 ? 1.25 : 1;
        ctx.stroke();
      }

      // The oath line: a single brighter thread with a slow travelling light.
      const od = 0.34;
      const baseY = top + od * span;
      const drift = t * (0.5 + od * 0.9);
      ctx.beginPath();
      for (let x = -step; x <= w + step; x += step) {
        const y = wave(x, baseY, 6 + od * 18, 2 + od * 6, 0.0038 - od * 0.0012, 5.1, drift);
        if (x === -step) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const p = ((t * 0.32) % 1.4) - 0.2;
      const grad = ctx.createLinearGradient(0, 0, Math.max(1, w), 0);
      const base = "rgba(57, 197, 187, 0.14)";
      grad.addColorStop(0, base);
      grad.addColorStop(clamp01(p - 0.2), base);
      grad.addColorStop(clamp01(p), "rgba(168, 236, 229, 0.55)");
      grad.addColorStop(clamp01(p + 0.2), base);
      grad.addColorStop(1, base);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    };

    const frame = (now: number) => {
      const dt = Math.min(50, now - last);
      last = now;
      t += dt * 0.00028; // ~0.28 rad/s: a slow, continuous current
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

    const onVisibility = () => {
      tabVisible = document.visibilityState === "visible";
      update();
    };

    const onMediaChange = () => {
      resize();
      draw(); // keep a coherent static frame if we are (now) paused
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
      if (!running) draw();
    });
    ro.observe(canvas);

    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onMediaChange);
    small.addEventListener("change", onMediaChange);

    resize();
    draw();
    update();

    return () => {
      cancelAnimationFrame(raf);
      running = false;
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onMediaChange);
      small.removeEventListener("change", onMediaChange);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
