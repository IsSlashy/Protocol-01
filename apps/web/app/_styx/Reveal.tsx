"use client";

import {
  createElement,
  useEffect,
  useRef,
  type CSSProperties,
  type ElementType,
  type ReactNode,
} from "react";

type RevealProps = {
  children: ReactNode;
  className?: string;
  /** Stagger, in ms. Applied as a transition-delay so reduced-motion ignores it. */
  delay?: number;
  as?: "div" | "section" | "aside" | "li" | "figure" | "tr";
};

/**
 * Marks its element data-revealed="true" the first time it enters the viewport.
 *
 * All visual consequences live in styx.css behind
 * `prefers-reduced-motion: no-preference`, so with reduced motion — or without
 * IntersectionObserver at all — the content is simply visible from the start.
 * Nothing here can leave a page permanently blank.
 *
 * Combine with the `styx-reveal` class:
 *   <Reveal className="styx-card styx-reveal" delay={80}>…</Reveal>
 */
export default function Reveal({
  children,
  className,
  delay = 0,
  as = "div",
}: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      node.dataset.revealed = "true";
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            node.dataset.revealed = "true";
            observer.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const style: CSSProperties | undefined =
    delay > 0 ? { transitionDelay: `${delay}ms` } : undefined;

  return createElement(
    as as ElementType,
    { ref, className, style, "data-revealed": "false" },
    children,
  );
}
