"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

/**
 * Holographic foil wrapper — the Intel i7/i9 chip-sticker effect.
 *
 * Wrap anything (a photo, a card) and it gains a diffraction-grating sheen that
 * shifts hue with the pointer. Styles live in globals.css under
 * "===== Holographic foil =====".
 *
 * The pointer position is written to CSS custom properties rather than to React
 * state: pointermove fires far too often to re-render through, and the browser
 * can animate custom properties on the compositor.
 *
 * `variant="brand"` keeps the site's cyan palette. `variant="spectrum"` is the
 * real full-RGB sticker look.
 */
export default function HoloFoil({
  children,
  className = "",
  variant = "spectrum",
  disabled = false,
}: {
  children: ReactNode;
  className?: string;
  variant?: "spectrum" | "brand";
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const [active, setActive] = useState(false);

  const track = useCallback((clientX: number, clientY: number) => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const mx = ((clientX - r.left) / r.width) * 100;
      const my = ((clientY - r.top) / r.height) * 100;
      el.style.setProperty("--mx", String(Math.max(0, Math.min(100, mx))));
      el.style.setProperty("--my", String(Math.max(0, Math.min(100, my))));
    });
  }, []);

  const engage = useCallback(() => {
    setActive(true);
    ref.current?.style.setProperty("--holo", "1");
  }, []);

  const release = useCallback(() => {
    setActive(false);
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--holo", "0");
    el.style.setProperty("--mx", "50");
    el.style.setProperty("--my", "50");
  }, []);

  if (disabled) return <div className={className}>{children}</div>;

  return (
    <div
      ref={ref}
      // Idle drift only while nothing is pointing at it — otherwise the
      // animation fights the pointer-driven background-position.
      data-idle={active ? "false" : "true"}
      className={`holo-foil holo-foil--${variant} ${className}`}
      onPointerEnter={engage}
      onPointerLeave={release}
      onPointerMove={(e) => {
        if (!active) engage();
        track(e.clientX, e.clientY);
      }}
      // Touch: a tap engages and tracks the finger, lifting releases.
      onTouchMove={(e) => {
        const t = e.touches[0];
        if (t) {
          if (!active) engage();
          track(t.clientX, t.clientY);
        }
      }}
      onTouchEnd={release}
    >
      {children}
      <span aria-hidden className="holo-foil__layer holo-foil__spectrum" />
      <span aria-hidden className="holo-foil__layer holo-foil__grating" />
      <span aria-hidden className="holo-foil__layer holo-foil__glint" />
    </div>
  );
}
