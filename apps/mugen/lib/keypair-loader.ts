/**
 * Env-var-first keypair loader for server routes.
 *
 * Resolution order:
 *   1. process.env[envVarName] — base64 of the 64-byte Solana secret key
 *      (i.e. Buffer.from(keypair.secretKey).toString('base64'))
 *   2. fallbackPath — standard Anchor/Solana JSON number-array file
 *
 * For the array variant (loadKeypairs) the env value is a JSON string
 * array of base64 entries, e.g. '["AAA...","BBB..."]'. The fallback
 * template uses the literal '{i}' placeholder for the 0-based index.
 *
 * This file is imported by server-side modules only (Next.js API routes
 * and background runners). It uses fs/os/path and MUST NOT be bundled
 * into client components.
 */

import * as fs from 'fs';
import { Keypair } from '@solana/web3.js';

/**
 * Decode a base64 string into a Keypair.
 * Accepts either 64-byte secret keys (Solana standard) OR a JSON array
 * of numbers serialized as base64 — the former is what
 * `Buffer.from(kp.secretKey).toString('base64')` produces and is the
 * canonical format for this loader.
 */
function keypairFromBase64(b64: string, envVarName: string): Keypair {
  const trimmed = b64.trim();
  let bytes: Uint8Array;
  try {
    const buf = Buffer.from(trimmed, 'base64');
    // A re-encode roundtrip is the simplest sanity check that the input
    // really was base64 (Buffer.from silently accepts garbage).
    if (buf.toString('base64').replace(/=+$/, '') !==
        trimmed.replace(/=+$/, '')) {
      throw new Error('not valid base64');
    }
    bytes = new Uint8Array(buf);
  } catch (err) {
    throw new Error(
      `${envVarName} is set but not valid base64: ${(err as Error).message}`,
    );
  }

  if (bytes.length !== 64) {
    throw new Error(
      `${envVarName} decoded to ${bytes.length} bytes, expected 64 ` +
        `(Solana secret keys are 64 bytes — use ` +
        `Buffer.from(keypair.secretKey).toString('base64'))`,
    );
  }
  return Keypair.fromSecretKey(bytes);
}

/**
 * Read a JSON number-array keypair file from disk (Anchor/Solana format).
 */
function keypairFromFile(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `keypair file ${filePath} is not a JSON number array`,
    );
  }
  const bytes = Uint8Array.from(parsed as number[]);
  if (bytes.length !== 64) {
    throw new Error(
      `keypair file ${filePath} contains ${bytes.length} bytes, expected 64`,
    );
  }
  return Keypair.fromSecretKey(bytes);
}

/**
 * Load a single Keypair by env var (base64) with optional file fallback.
 *
 * Throws when both sources are missing so misconfiguration surfaces loudly
 * instead of silently generating a fresh identity (which would orphan
 * SOL/token balances on Vercel cold starts).
 */
export function loadKeypair(
  envVarName: string,
  fallbackPath?: string,
): Keypair {
  const envVal = process.env[envVarName];
  if (envVal && envVal.trim().length > 0) {
    return keypairFromBase64(envVal, envVarName);
  }

  if (fallbackPath && fs.existsSync(fallbackPath)) {
    return keypairFromFile(fallbackPath);
  }

  throw new Error(
    `Missing keypair: set ${envVarName} (base64 of 64-byte secret key) ` +
      (fallbackPath
        ? `or place the keypair JSON at ${fallbackPath}.`
        : `— no fallback path supplied.`) +
      ` Run 'pnpm --filter @protocol-01/mugen env:export-keypairs' to ` +
      `generate the env values from your local files.`,
  );
}

/**
 * Load an ordered list of Keypairs by env var (JSON array of base64)
 * with per-index file fallback.
 *
 * - Env value format: JSON string array of base64 entries (length must
 *   equal `count`).
 * - `fallbackPathTemplate` uses '{i}' as the 0-based index placeholder,
 *   e.g. '.secrets/noise-wallet-{i}.keypair.json'.
 *
 * Throws when neither source provides enough entries.
 */
export function loadKeypairs(
  envVarName: string,
  fallbackPathTemplate: string,
  count: number,
): Keypair[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`loadKeypairs: count must be a non-negative integer`);
  }
  if (count === 0) return [];
  if (!fallbackPathTemplate.includes('{i}')) {
    throw new Error(
      `loadKeypairs: fallbackPathTemplate must contain '{i}' placeholder`,
    );
  }

  const envVal = process.env[envVarName];
  if (envVal && envVal.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(envVal);
    } catch (err) {
      throw new Error(
        `${envVarName} must be a JSON array of base64 strings: ` +
          (err as Error).message,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${envVarName} must be a JSON array, got ${typeof parsed}`);
    }
    if (parsed.length !== count) {
      throw new Error(
        `${envVarName} has ${parsed.length} entries, expected ${count}`,
      );
    }
    return parsed.map((entry, i) => {
      if (typeof entry !== 'string') {
        throw new Error(
          `${envVarName}[${i}] must be a base64 string, got ${typeof entry}`,
        );
      }
      return keypairFromBase64(entry, `${envVarName}[${i}]`);
    });
  }

  // File fallback — all indices must resolve.
  const missing: string[] = [];
  const result: Keypair[] = [];
  for (let i = 0; i < count; i++) {
    const p = fallbackPathTemplate.replace('{i}', String(i));
    if (!fs.existsSync(p)) {
      missing.push(p);
      continue;
    }
    result.push(keypairFromFile(p));
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing keypairs: set ${envVarName} (JSON array of ${count} base64 ` +
        `strings) or create the fallback files. Missing: ${missing.join(', ')}. ` +
        `Run 'pnpm --filter @protocol-01/mugen env:export-keypairs' to generate.`,
    );
  }

  return result;
}
