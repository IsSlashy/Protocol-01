"use client";

/**
 * The progress a multi-minute pool operation owes the user.
 *
 * Three things, in order of how much they matter:
 *   1. A bar that MOVES, driven by real sub-progress during the upload, the
 *      longest phase, instead of an animation that would move identically
 *      whether the job was working or dead.
 *   2. The steps AFTER the current one, so the wait has a known length rather
 *      than an unknown one.
 *   3. What is at stake while it runs, because ~1 SOL sits in a refundable
 *      deposit for the duration and the user is entitled to know that without
 *      reading the source.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { progressFor, type FlowPhase } from "@/lib/pay/flowProgress";

export default function FlowProgress({
  phases,
  step,
  running,
  note,
}: {
  phases: FlowPhase[];
  /** The worker's current step string, verbatim. */
  step: string | null;
  running: boolean;
  /** One line on what is at stake. Omit when nothing is. */
  note?: string;
}) {
  // Monotonic: an unrecognised step must never look like going backwards.
  const [percent, setPercent] = useState(0);
  const startedAt = useRef<number | null>(null);

  const state = progressFor(phases, step, percent);

  useEffect(() => {
    if (!running) {
      setPercent(0);
      startedAt.current = null;
      return;
    }
    if (startedAt.current === null) startedAt.current = Date.now();
    setPercent((p) => Math.max(p, state.percent));
  }, [running, state.percent]);

  if (!running) return null;

  // Elapsed time, always. An ESTIMATE only where something real is being
  // counted.
  //
  // The first version extrapolated elapsed/percent across the whole run and was
  // badly wrong, in the harmful direction: measured in production, a shield sat
  // at 7% for three minutes and was told it had 36 minutes left, because the
  // slow work (reading the tree, proving) is at the START while the upload,
  // which carries 45% of the bar, is comparatively fast. Linear extrapolation
  // from an early sample is structurally pessimistic here, and a 36-minute
  // estimate makes people cancel a job that is going fine.
  //
  // The only phase that measures itself is the chunk upload, which reports i/N.
  // So the estimate exists exactly there and nowhere else, and the rest of the
  // time the user gets the one number that is true: how long it has been.
  const elapsed = startedAt.current ? (Date.now() - startedAt.current) / 1000 : 0;
  const remaining = (() => {
    if (!state.detail || state.detail.done < 2) return null;
    const perUnit = elapsed / state.detail.done;
    const left = state.detail.total - state.detail.done;
    return left > 0 ? Math.round(perUnit * left) : null;
  })();

  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="flex items-center gap-2 text-sm text-p01-text">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-p01-cyan" />
          {state.current?.label ?? "Starting"}
          {state.detail && (
            <span className="font-mono text-xs text-p01-text-muted">
              {state.detail.done}/{state.detail.total}
            </span>
          )}
        </p>
        <p className="font-mono text-xs text-p01-text-muted">
          {Math.floor(percent)}%
          {elapsed > 5 && ` · ${formatRemaining(Math.round(elapsed))} elapsed`}
          {remaining !== null && ` · ~${formatRemaining(remaining)} left`}
        </p>
      </div>

      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-p01-border"
        role="progressbar"
        aria-valuenow={Math.floor(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={state.current?.label ?? "In progress"}
      >
        <div
          className="h-full rounded-full bg-p01-cyan transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>

      <ol className="space-y-1">
        {phases.map((p, i) => {
          const done = state.index > i;
          const active = state.index === i;
          return (
            <li
              key={p.id}
              className={
                active
                  ? "flex items-center gap-2 text-xs text-p01-text"
                  : done
                    ? "flex items-center gap-2 text-xs text-p01-text-muted"
                    : "flex items-center gap-2 text-xs text-p01-text-dim"
              }
            >
              {done ? (
                <Check className="h-3 w-3 text-p01-cyan" />
              ) : active ? (
                <Loader2 className="h-3 w-3 animate-spin text-p01-cyan" />
              ) : (
                <span className="h-3 w-3 rounded-full border border-current opacity-40" />
              )}
              {p.label}
            </li>
          );
        })}
      </ol>

      {note && <p className="text-xs text-p01-text-dim">{note}</p>}
      <p className="text-xs text-p01-text-dim">Keep this tab open.</p>
    </div>
  );
}

function formatRemaining(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}
