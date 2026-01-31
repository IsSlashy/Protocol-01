/**
 * Global mock for framer-motion
 *
 * framer-motion bundles its own React instance in the monorepo, causing
 * "multiple React instances" errors. This mock replaces all motion components
 * with plain HTML equivalents while preserving the API surface.
 */

import React from 'react';

// Create a proxy that converts any motion.X into a plain X element
const motionHandler = {
  get(_target: unknown, prop: string) {
    // Return a forward-ref component that renders the plain HTML element
    return React.forwardRef(function MotionMock(
      { initial, animate, exit, transition, whileHover, whileTap, whileFocus, whileInView, variants, layout, layoutId, ...props }: any,
      ref: React.Ref<HTMLElement>,
    ) {
      return React.createElement(prop, { ...props, ref });
    });
  },
};

export const motion = new Proxy({}, motionHandler);

export function AnimatePresence({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function useAnimation() {
  return {
    start: () => Promise.resolve(),
    set: () => {},
    stop: () => {},
  };
}

export function useMotionValue(initial: number) {
  return {
    get: () => initial,
    set: () => {},
    on: () => () => {},
  };
}

export function useSpring(initial: number) {
  return useMotionValue(initial);
}

export function useTransform(...args: unknown[]) {
  return useMotionValue(0);
}

export function useInView() {
  return true;
}

export function useScroll() {
  return { scrollY: useMotionValue(0), scrollYProgress: useMotionValue(0) };
}

export const LayoutGroup = ({ children }: { children: React.ReactNode }) => <>{children}</>;
export const LazyMotion = ({ children }: { children: React.ReactNode }) => <>{children}</>;
export const MotionConfig = ({ children }: { children: React.ReactNode }) => <>{children}</>;
export const Reorder = { Group: 'div', Item: 'div' };
