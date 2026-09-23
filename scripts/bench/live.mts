/**
 * The gates every live (devnet) flow of the benchmark passes BEFORE anything is
 * sent. A flow that fails one does not run; the runner exits before measuring
 * anything, so a half-run never produces a partial table.
 *
 *   --cluster devnet        required, literally. Anything else is refused.
 *   --key <path>            required. A dedicated measurement key:
 *                             - a 64-byte Solana keypair JSON;
 *                             - NOT the Solana CLI default (~/.config/solana/id.json),
 *                               which on this project is the operator's key;
 *                             - NOT an address this repository names in public
 *                               (apps/web/lib/privacy/pool/publicPayer.ts);
 *                             - NOT a file inside the repository, so it cannot be committed.
 *   --rpc-env <NAME>        the RPC URL is read from that environment variable, so
 *   (or --rpc <url>)        the URL (which may carry an API key) is never on a command
 *                           line that gets logged; only its host is recorded.
 *                           A URL naming mainnet is refused; before the first send
 *                           the runner checks the endpoint's genesis hash is devnet's.
 *   --api-base <url>        purchase flow only. The production deployments are
 *                           refused unless --allow-production-api is also given.
 *
 * Nothing here prints the key, the secret bytes or the full RPC URL.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { Keypair, Connection, PublicKey } from '@solana/web3.js';

import { PUBLICLY_NAMED_IN_THIS_REPO } from '../../apps/web/lib/privacy/pool/publicPayer.ts';

/** Devnet's genesis hash; `getGenesisHash` on any devnet endpoint returns it. */
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

const PRODUCTION_HOSTS = ['protocol-01.dev', 'www.protocol-01.dev', 'styx.cash', 'www.styx.cash'];

export interface LiveOptions {
  cluster?: string;
  key?: string;
  rpcEnv?: string;
  rpc?: string;
  apiBase?: string;
  allowProductionApi?: boolean;
}

export interface LiveContext {
  keyPath: string;
  /** First 4 and last 4 characters only, for logs. */
  keyFingerprint: string;
  pubkey: string;
  rpcUrl: string;
  rpcHost: string;
  apiBase?: string;
}

export function redactUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.host;
  } catch {
    return '<unparseable url>';
  }
}

export function checkLiveGates(o: LiveOptions, repoRoot: string, needApi: boolean): { errors: string[]; ctx?: LiveContext } {
  const errors: string[] = [];

  if (o.cluster !== 'devnet') {
    errors.push(`--cluster devnet is required for live flows (got ${o.cluster === undefined ? 'nothing' : JSON.stringify(o.cluster)}).`);
  }

  let keyPath = '';
  let pubkey = '';
  if (!o.key) {
    errors.push('--key <path to a dedicated devnet keypair JSON> is required for live flows.');
  } else {
    keyPath = path.resolve(o.key.replace(/^~(?=$|[\\/])/, homedir()));
    if (!existsSync(keyPath)) {
      errors.push(`--key: no file at the given path.`);
    } else {
      const real = realpathSync(keyPath);
      const cliDefault = path.join(homedir(), '.config', 'solana', 'id.json');
      const isCliDefault = existsSync(cliDefault) && realpathSync(cliDefault).toLowerCase() === real.toLowerCase();
      if (isCliDefault) {
        // Refused by path, before the file is even opened.
        errors.push('--key is the Solana CLI default key (~/.config/solana/id.json). The benchmark needs a dedicated key.');
      }
      const rel = path.relative(realpathSync(repoRoot), real);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        errors.push('--key lives inside the repository. Keep the measurement key outside the working tree so it can never be committed.');
      }
      if (!isCliDefault) try {
        const arr = JSON.parse(readFileSync(real, 'utf8')) as unknown;
        if (!Array.isArray(arr) || arr.length !== 64) throw new Error('not a 64-byte array');
        pubkey = Keypair.fromSecretKey(Uint8Array.from(arr as number[])).publicKey.toBase58();
        if (PUBLICLY_NAMED_IN_THIS_REPO[pubkey]) {
          errors.push(`--key is an address this repository names in public (${PUBLICLY_NAMED_IN_THIS_REPO[pubkey].slice(0, 60)}...). Use a dedicated key.`);
        }
      } catch (e) {
        errors.push(`--key is not a Solana keypair JSON (${(e as Error).message}).`);
      }
    }
  }

  let rpcUrl = '';
  if (o.rpcEnv) {
    rpcUrl = process.env[o.rpcEnv] ?? '';
    if (!rpcUrl) errors.push(`--rpc-env ${o.rpcEnv}: that environment variable is empty.`);
  } else if (o.rpc) {
    rpcUrl = o.rpc;
  } else {
    errors.push('--rpc-env <VAR holding the RPC URL> (preferred) or --rpc <url> is required for live flows.');
  }
  if (rpcUrl) {
    let host = '';
    try { host = new URL(rpcUrl).host.toLowerCase(); } catch { errors.push('the RPC URL does not parse.'); }
    if (/mainnet/.test(host) || /mainnet/.test(rpcUrl.toLowerCase())) {
      errors.push('the RPC URL names mainnet. The benchmark runs on devnet only.');
    }
  }

  let apiBase: string | undefined;
  if (needApi) {
    if (!o.apiBase) {
      errors.push('--api-base <deployment URL> is required for the purchase flow (the note-in exchange calls its /api routes).');
    } else {
      try {
        const h = new URL(o.apiBase).host.toLowerCase();
        if (PRODUCTION_HOSTS.includes(h) && !o.allowProductionApi) {
          errors.push(`--api-base ${h} is a production deployment. Add --allow-production-api only with the founder's go-ahead.`);
        }
        apiBase = o.apiBase.replace(/\/+$/, '');
      } catch {
        errors.push('--api-base does not parse as a URL.');
      }
    }
  }

  if (errors.length) return { errors };
  return {
    errors,
    ctx: {
      keyPath,
      keyFingerprint: `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`,
      pubkey,
      rpcUrl,
      rpcHost: redactUrl(rpcUrl),
      apiBase,
    },
  };
}

/** The one network read the gate makes, and only when a live flow is about to run. */
export async function assertDevnetEndpoint(rpcUrl: string): Promise<void> {
  const conn = new Connection(rpcUrl, 'confirmed');
  const g = await conn.getGenesisHash();
  if (g !== DEVNET_GENESIS_HASH) {
    throw new Error(`the RPC endpoint's genesis hash is not devnet's (got ${g.slice(0, 8)}…). Refusing to send.`);
  }
}

/** Replace every secret value we know of in a log before it is written to disk. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text.replace(/api-key=[^&\s"']+/gi, 'api-key=<redacted>');
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('<redacted>');
  return out;
}

/** The confirmed slot now: the run's first slot, for `p01-verify.mjs --since-slot`. Read-only. */
export async function currentSlot(rpcUrl: string): Promise<number> {
  return new Connection(rpcUrl, 'confirmed').getSlot('confirmed');
}

const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

/**
 * Each program's last deploy slot, read from its ProgramData account (bytes
 * 4..12, u64 LE), so a manifest says WHICH deployment of a program was
 * measured, not only its address. Read-only; an error is recorded, not thrown.
 */
export async function readDeploySlots(rpcUrl: string, programIds: string[]): Promise<Record<string, { programdata?: string; last_deploy_slot?: number; error?: string }>> {
  const conn = new Connection(rpcUrl, 'confirmed');
  const out: Record<string, { programdata?: string; last_deploy_slot?: number; error?: string }> = {};
  for (const id of programIds) {
    try {
      const acc = await conn.getAccountInfo(new PublicKey(id));
      if (!acc) { out[id] = { error: 'no such account' }; continue; }
      if (acc.owner.toBase58() !== UPGRADEABLE_LOADER || acc.data.length < 36 || acc.data.readUInt32LE(0) !== 2) {
        out[id] = { error: `not an upgradeable program (owner ${acc.owner.toBase58().slice(0, 8)}…)` };
        continue;
      }
      const pd = new PublicKey(acc.data.subarray(4, 36));
      const head = await conn.getAccountInfo(pd, { dataSlice: { offset: 0, length: 12 } });
      if (!head || head.data.length < 12 || head.data.readUInt32LE(0) !== 3) { out[id] = { programdata: pd.toBase58(), error: 'programdata header unreadable' }; continue; }
      out[id] = { programdata: pd.toBase58(), last_deploy_slot: Number(head.data.readBigUInt64LE(4)) };
    } catch (e) {
      out[id] = { error: (e as Error).message.slice(0, 120) };
    }
  }
  return out;
}
