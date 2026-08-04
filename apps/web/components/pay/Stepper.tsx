"use client";

/**
 * The three things that must happen before anything else can, in order.
 *
 * Two defects this replaces, both reported from the running app:
 *
 * 1. The connector line lived INSIDE each step with `flex-1`, while the step
 *    itself was also `flex-1`. Three equal-width blocks holding three
 *    different-length labels give uneven gaps and a line that starts in a
 *    different place under each one. Steps and connectors are siblings now, so
 *    the line takes the leftover space and nothing else competes for it.
 *
 * 2. The last step said "Send". That was the whole app once; it is now one tab
 *    of five, so the label named a destination the user might not be heading
 *    for. "Send or subscribe" says what the keys unlock without pretending
 *    there is only one door.
 */

import { Check } from "lucide-react";
import clsx from "clsx";

export type StepState = "done" | "active" | "todo";

const STEPS = [
  { label: "Connect", hint: "your wallet" },
  { label: "Derive keys", hint: "one signature" },
  { label: "Send or subscribe", hint: "shield, pay, subscribe" },
] as const;

export default function Stepper({ current }: { current: 0 | 1 | 2 }) {
  return (
    <ol className="flex items-center gap-2 sm:gap-3">
      {STEPS.map((step, i) => {
        const state: StepState = i < current ? "done" : i === current ? "active" : "todo";
        return (
          <li key={step.label} className="flex min-w-0 items-center gap-2 sm:gap-3">
            <span
              className={clsx(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                state === "done" && "border-p01-cyan bg-p01-cyan text-p01-void",
                state === "active" && "border-p01-cyan text-p01-cyan glow-cyan-sm",
                state === "todo" && "border-p01-border text-p01-text-dim",
              )}
            >
              {state === "done" ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </span>

            <span className="flex min-w-0 flex-col leading-tight">
              <span
                className={clsx(
                  "truncate text-xs",
                  state === "active" && "font-medium text-p01-text",
                  state === "done" && "text-p01-text-muted",
                  state === "todo" && "text-p01-text-dim",
                )}
              >
                {step.label}
              </span>
              {/* The hint only ever appears on the step being worked on. On the
                  others it is noise, and on narrow screens it is noise that
                  wraps. */}
              {state === "active" && (
                <span className="hidden truncate text-[10px] text-p01-text-dim sm:block">
                  {step.hint}
                </span>
              )}
            </span>

            {/* Sibling of the step, not a child of it: this is what makes the
                spacing even. Hidden on narrow screens, where three labels and
                two lines do not fit. */}
            {i < STEPS.length - 1 && (
              <span
                aria-hidden
                className={clsx(
                  "ml-1 hidden h-px w-6 shrink-0 sm:block lg:w-12",
                  i < current ? "bg-p01-cyan/50" : "bg-p01-border",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
