/**
 * What a route is allowed to write to the server log when something fails.
 *
 * 🚨 AN ERROR FROM THE STORE IS A TRANSCRIPT, NOT A SYMPTOM.
 *
 * The production client words a failed request as
 * `${error}, command was: ${JSON.stringify(commands)}`
 * (node_modules/@upstash/redis/nodejs.js), and auto-pipelining puts every
 * command batched into that round trip in the same list. So `console.error(tag,
 * err)` writes, into the Vercel runtime log, the value the write was carrying —
 * a subscriber's whole record, or the entire developer whitelist — plus
 * whatever another route batched alongside it, which on this deployment can be
 * a redeemable claim code and a payment signature (the waitlist and the pay
 * routes share one module-level client, lib/waitlist/store.ts). Anyone with a
 * log dump, a log drain or a support export reads all of it.
 *
 * So a failure is logged as a FIXED tag plus, at most, the error's CLASS name,
 * which is chosen by the class and carries no argument. The name is still
 * sanitised: it is a writable property, so nothing stops a value reaching it.
 *
 * Pinned by `__tests__/api/serverLogHygiene.test.ts`, which fails a store call
 * in each route in turn with an Upstash-shaped message holding a subscriber
 * email, a sale's claim code, a payment signature and a developer record, and
 * reads what the route wrote.
 */

/** The error's class name, sanitised, or `unknown` when there is nothing safe. */
export function errorClass(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.name
      : typeof err === 'object' && err !== null
        ? err.constructor?.name
        : undefined;
  if (typeof raw !== 'string') return 'unknown';
  const safe = raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
  return safe === '' ? 'unknown' : safe;
}

/**
 * Write one line: `<tag> failed (<class>); details withheld`.
 *
 * `tag` is a literal written at the call site. Never pass a key, a value, a
 * message or anything read from a request.
 */
export function logFailure(tag: string, err: unknown): void {
  console.error(`${tag} failed (${errorClass(err)}); details withheld: a store error carries the command it was sent`);
}
