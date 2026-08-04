"use client";

/**
 * The confirmation an operation owes the user when it lands.
 *
 * A multi-minute wait that ends by silently swapping a paragraph reads as "did
 * something happen?". One deliberate beat says it did, then gets out of the way.
 * The result underneath is the real content, not this.
 *
 * The animation lives in `app/globals.css` under `p01-burst-*`, not in a
 * `<style jsx>` block: styled-jsx is not transformed everywhere this component
 * is rendered, and the React warning that produces would land on every consumer
 * instead of on the author. It also runs ONCE and settles, where Tailwind's
 * `animate-ping` would keep pulsing long after the news is old, and it is gated
 * on `prefers-reduced-motion` so the mark still appears for anyone who asked
 * for less movement.
 */

import { Check } from "lucide-react";

export default function SuccessBurst({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-2">
      <span className="relative flex h-12 w-12 items-center justify-center">
        <span className="p01-burst-ring absolute inset-0 rounded-full bg-p01-cyan/20" />
        <span className="p01-burst-mark relative flex h-12 w-12 items-center justify-center rounded-full border border-p01-cyan bg-p01-cyan/10">
          <Check className="h-6 w-6 text-p01-cyan" />
        </span>
      </span>
      <p className="text-sm text-p01-text">{label}</p>
    </div>
  );
}
