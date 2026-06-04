"use client";

import { ReactLenis } from "lenis/react";
import "lenis/dist/lenis.css";
import type { ReactNode } from "react";

/**
 * SmoothScroll — buttery, interpolated wheel/trackpad scrolling (Lenis), the
 * same feel as ghostwareos.com. Root mode binds to window, so position:fixed
 * (DepthBackground) and sticky (SiteHeader) keep working. `anchors` makes
 * in-page #links glide instead of jump. lerp ~0.09 = smooth but still snappy.
 */
export default function SmoothScroll({ children }: { children: ReactNode }) {
  return (
    <ReactLenis
      root
      options={{
        lerp: 0.09,
        smoothWheel: true,
        wheelMultiplier: 1,
        touchMultiplier: 1.5,
        anchors: true,
      }}
    >
      {children}
    </ReactLenis>
  );
}
