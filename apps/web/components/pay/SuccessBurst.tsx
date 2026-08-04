"use client";

/**
 * The confirmation an operation owes the user when it lands.
 *
 * A multi-minute wait that ends by silently swapping a paragraph reads as "did
 * something happen?". One deliberate beat says it did, then gets out of the way
 *, the result underneath is the real content, not this.
 *
 * Respects `prefers-reduced-motion`: the mark still appears, it just does not
 * move. An animation nobody asked for should never be the price of knowing
 * whether your money moved.
 */

import { Check } from "lucide-react";

export default function SuccessBurst({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-2">
      <span className="relative flex h-12 w-12 items-center justify-center">
        <span className="absolute inset-0 rounded-full bg-p01-cyan/20 motion-safe:animate-ping" />
        <span className="relative flex h-12 w-12 items-center justify-center rounded-full border border-p01-cyan bg-p01-cyan/10 motion-safe:animate-[scaleIn_220ms_ease-out]">
          <Check className="h-6 w-6 text-p01-cyan" />
        </span>
      </span>
      <p className="text-sm text-p01-text">{label}</p>
      <style jsx>{`
        @keyframes scaleIn {
          from {
            transform: scale(0.7);
            opacity: 0;
          }
          to {
            transform: scale(1);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}
