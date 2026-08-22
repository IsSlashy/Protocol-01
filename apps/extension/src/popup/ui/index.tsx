/**
 * The extension's UI kit.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * There was no shared kit. Thirteen screens hand-rolled a primary button, each
 * with its own padding, radius, disabled treatment and loading behaviour, and
 * that is the actual reason the extension looked like a different product from
 * one screen to the next. Retuning the colour tokens aligned the palette in one
 * move; nothing aligns the SHAPES except a set of components everyone uses.
 *
 * The rules baked in here, so no screen has to remember them:
 *   - every interactive target is at least 44px tall
 *   - disabled is `disabled` plus reduced opacity plus no pointer, never just
 *     a colour change that still looks pressable
 *   - a button that is loading is disabled and says so to a screen reader
 *   - focus is visible, because a popup opens over whatever the user was
 *     typing in and gets driven by keyboard more than a website does
 *   - motion is 140 to 220ms, and the global sheet honours reduced-motion
 *   - digits that sit in columns are tabular
 *
 * Display type is Newsreader at weight 300, the site's voice. Body is the
 * system sans. Data, addresses and amounts are mono.
 */

import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Loader2, type LucideIcon } from 'lucide-react';
import { cn } from '@/shared/utils';

/* ── Eyebrow ──────────────────────────────────────────────────────────── */

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('eyebrow', className)}>{children}</p>;
}

/* ── Hairline ─────────────────────────────────────────────────────────── */

export function Hairline({ className }: { className?: string }) {
  return <div className={cn('h-px w-full bg-p01-border', className)} aria-hidden="true" />;
}

/* ── Panel ────────────────────────────────────────────────────────────── */

export function Panel({
  children,
  className,
  tone = 'default',
}: {
  children: ReactNode;
  className?: string;
  /** `warn` is the site's amber, used for anything the user should read twice. */
  tone?: 'default' | 'warn' | 'quiet';
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-3',
        tone === 'default' && 'border-p01-border bg-p01-surface',
        tone === 'quiet' && 'border-p01-border-soft bg-p01-dark',
        tone === 'warn' && 'border-p01-amber/40 bg-p01-amber/[0.06]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── Button ───────────────────────────────────────────────────────────── */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'lg';
  loading?: boolean;
  /** Visible label is required; an icon never stands alone. */
  icon?: LucideIcon;
  full?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon: Icon, full, className, children, disabled, ...rest },
  ref,
) {
  const isOff = disabled || loading;
  return (
    <button
      ref={ref}
      // ⚠️ `disabled` on the element, not only in the styling. A control that
      // looks dead but still fires is the worst of both.
      disabled={isOff}
      aria-busy={loading || undefined}
      className={cn(
        'relative inline-flex items-center justify-center gap-2 rounded-lg font-medium',
        'transition-colors duration-exit outline-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan',
        size === 'md' ? 'min-h-[44px] px-4 text-sm' : 'min-h-[52px] px-5 text-base',
        full && 'w-full',
        variant === 'primary' && 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-bright',
        variant === 'secondary' && 'border border-p01-border bg-transparent text-p01-text hover:bg-p01-surface',
        variant === 'ghost' && 'bg-transparent text-p01-text-muted hover:text-p01-text',
        variant === 'danger' && 'border border-p01-red/40 bg-p01-red/10 text-p01-red hover:bg-p01-red/20',
        isOff && 'cursor-not-allowed opacity-40 hover:bg-inherit',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : Icon ? (
        <Icon className="h-4 w-4" aria-hidden="true" />
      ) : null}
      {children}
    </button>
  );
});

/* ── Screen ───────────────────────────────────────────────────────────── */

/**
 * Every screen is this shape: a header that always offers a way back, a body
 * that scrolls, and an optional footer that does not.
 *
 * The footer is separate from the body on purpose. A primary action that
 * scrolls out of view is the single most common reason a wallet flow stalls,
 * and half the screens here put their action at the bottom of a long column.
 */
export function Screen({
  title,
  onBack,
  action,
  children,
  footer,
  className,
}: {
  title?: ReactNode;
  onBack?: () => void;
  action?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex h-full flex-col bg-p01-void">
      {(title || onBack || action) && (
        <header className="flex shrink-0 items-center gap-1 border-b border-p01-border-soft px-2 py-2">
          {onBack ? (
            <button
              onClick={onBack}
              aria-label="Go back"
              className="flex h-11 w-11 items-center justify-center rounded-lg text-p01-text-muted transition-colors duration-exit hover:text-p01-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
            >
              <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            </button>
          ) : (
            <span className="w-2" />
          )}
          <h1 className="flex-1 truncate px-1 font-display text-lg font-normal tracking-tight">
            {title}
          </h1>
          {action}
        </header>
      )}

      <div className={cn('flex-1 overflow-y-auto px-4 py-4', className)}>{children}</div>

      {footer && (
        <div className="shrink-0 border-t border-p01-border-soft bg-p01-void px-4 py-3">{footer}</div>
      )}
    </div>
  );
}

/* ── Amount ───────────────────────────────────────────────────────────── */

/**
 * The one place a number is allowed to be large. Tabular, so a balance that
 * ticks does not shift the layout under the user's thumb.
 */
export function Amount({
  value,
  unit,
  size = 'lg',
  className,
}: {
  value: string | number;
  unit?: string;
  size?: 'sm' | 'lg' | 'xl';
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 tabular', className)}>
      <span
        className={cn(
          'font-display font-light leading-none tracking-tight',
          size === 'sm' && 'text-lg',
          size === 'lg' && 'text-2xl',
          size === 'xl' && 'text-3xl',
        )}
      >
        {value}
      </span>
      {unit && <span className="text-sm text-p01-text-muted">{unit}</span>}
    </span>
  );
}

/* ── Row ──────────────────────────────────────────────────────────────── */

export function Row({
  label,
  value,
  sub,
  onClick,
  icon: Icon,
  chevron,
  danger,
}: {
  label: ReactNode;
  value?: ReactNode;
  sub?: ReactNode;
  onClick?: () => void;
  icon?: LucideIcon;
  chevron?: boolean;
  danger?: boolean;
}) {
  const inner = (
    <>
      {Icon && (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-p01-border-soft bg-p01-surface">
          <Icon className={cn('h-4 w-4', danger ? 'text-p01-red' : 'text-p01-cyan')} aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0 flex-1 text-left">
        <span className={cn('block truncate text-sm', danger ? 'text-p01-red' : 'text-p01-text')}>
          {label}
        </span>
        {sub && <span className="block truncate text-tiny text-p01-text-dim">{sub}</span>}
      </span>
      {value && <span className="shrink-0 text-sm text-p01-text-muted tabular">{value}</span>}
      {chevron && <ChevronRight className="h-4 w-4 shrink-0 text-p01-text-dim" aria-hidden="true" />}
    </>
  );

  if (!onClick) {
    return <div className="flex min-h-[44px] items-center gap-3 py-2">{inner}</div>;
  }

  return (
    <button
      onClick={onClick}
      className="flex min-h-[44px] w-full items-center gap-3 rounded-lg py-2 text-left transition-colors duration-exit hover:bg-p01-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
    >
      {inner}
    </button>
  );
}

/* ── Field ────────────────────────────────────────────────────────────── */

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  /** ⚠️ Visible, always. A placeholder is not a label: it vanishes on focus. */
  label: string;
  hint?: string;
  error?: string;
  suffix?: ReactNode;
};

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, suffix, className, id, ...rest },
  ref,
) {
  const fieldId = id ?? `f-${label.replace(/\s+/g, '-').toLowerCase()}`;
  const describedBy = error ? `${fieldId}-err` : hint ? `${fieldId}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-tiny text-p01-text-muted">
        {label}
      </label>
      <div className="relative flex items-center">
        <input
          ref={ref}
          id={fieldId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'min-h-[44px] w-full rounded-lg border bg-p01-dark px-3 text-sm text-p01-text',
            'placeholder:text-p01-text-dim',
            'outline-none transition-colors duration-exit',
            'focus:border-p01-cyan focus-visible:outline-none',
            error ? 'border-p01-red' : 'border-p01-border',
            suffix ? 'pr-16' : '',
            className,
          )}
          {...rest}
        />
        {suffix && (
          <span className="absolute right-3 text-tiny text-p01-text-dim">{suffix}</span>
        )}
      </div>
      {/* Error sits under its own field, never in a summary at the top, and it
          announces itself: a wallet form that fails silently costs money. */}
      {error ? (
        <p id={`${fieldId}-err`} role="alert" className="text-tiny text-p01-red">
          {error}
        </p>
      ) : hint ? (
        <p id={`${fieldId}-hint`} className="text-tiny text-p01-text-dim">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

/* ── Empty state ──────────────────────────────────────────────────────── */

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      {Icon && <Icon className="h-6 w-6 text-p01-text-dim" aria-hidden="true" />}
      <p className="font-display text-lg font-normal">{title}</p>
      {/* An empty state that does not say what to do next is a dead end. */}
      {body && <p className="max-w-[26ch] text-sm text-p01-text-muted">{body}</p>}
      {action}
    </div>
  );
}

/* ── Pill ─────────────────────────────────────────────────────────────── */

export function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[0.6875rem] leading-tight',
        tone === 'neutral' && 'border-p01-border text-p01-text-muted',
        tone === 'good' && 'border-p01-cyan/40 bg-p01-cyan/10 text-p01-cyan',
        tone === 'warn' && 'border-p01-amber/40 bg-p01-amber/10 text-p01-amber',
        tone === 'bad' && 'border-p01-red/40 bg-p01-red/10 text-p01-red',
      )}
    >
      {children}
    </span>
  );
}

/* ── Action grid ──────────────────────────────────────────────────────── */

/**
 * The row of primary verbs on the wallet screen. Icon plus LABEL, never icon
 * alone: an unlabelled icon in a wallet is a guess about someone's money.
 */
export function ActionGrid({
  actions,
}: {
  actions: { label: string; icon: LucideIcon; onClick: () => void; disabled?: boolean }[];
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {actions.map((a) => (
        <button
          key={a.label}
          onClick={a.onClick}
          disabled={a.disabled}
          className={cn(
            'flex min-h-[68px] flex-col items-center justify-center gap-1.5 rounded-xl border border-p01-border bg-p01-surface',
            'transition-colors duration-exit hover:border-p01-border-light',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan',
            a.disabled && 'cursor-not-allowed opacity-40',
          )}
        >
          <a.icon className="h-[18px] w-[18px] text-p01-cyan" aria-hidden="true" />
          <span className="text-[0.6875rem] text-p01-text-muted">{a.label}</span>
        </button>
      ))}
    </div>
  );
}
