"use client";

import { Check } from "lucide-react";
import clsx from "clsx";

export type StepState = "done" | "active" | "todo";

const STEPS = ["Connect", "Derive keys", "Send"] as const;

export default function Stepper({ current }: { current: 0 | 1 | 2 }) {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((label, i) => {
        const state: StepState = i < current ? "done" : i === current ? "active" : "todo";
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={clsx(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                state === "done" && "border-p01-cyan bg-p01-cyan text-p01-void",
                state === "active" && "border-p01-cyan text-p01-cyan glow-cyan-sm",
                state === "todo" && "border-p01-border text-p01-text-dim"
              )}
            >
              {state === "done" ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <span
              className={clsx(
                "text-xs",
                state === "todo" ? "text-p01-text-dim" : "text-p01-text"
              )}
            >
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="mx-1 hidden h-px flex-1 bg-p01-border sm:block" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
