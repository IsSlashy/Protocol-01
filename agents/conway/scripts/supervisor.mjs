#!/usr/bin/env node
/**
 * Conway lineage supervisor (owner side)
 *
 * Runs on the machine that hosts the agents. It never thinks; it only keeps
 * the lineage alive and the money flowing to the owner:
 *
 *   - boots generation 1 from genesis.prompt.md + colony.json (headless)
 *   - watches every agent (process + SQLite state + on-chain balances)
 *   - on death: distills the agent's memory into lineage lessons, sweeps the
 *     leftover USDC/SOL to the owner, archives the home, boots generation N+1
 *     with the lessons (and the cause of death) in its LINEAGE.md
 *   - on a replica request from a profitable agent: starts a sibling with a
 *     distinct specialization, up to maxReplicas
 *   - on a credit request: buys Conway credits for the agent's Solana address
 *     from an EVM funder wallet (optional), because Solana wallets cannot
 *   - optional seeding of new agents from a hot owner keypair
 *   - kill switch: a STOP file in the colony root
 *
 * Usage:
 *   node supervisor.mjs start              run forever
 *   node supervisor.mjs once               one tick (useful in cron)
 *   node supervisor.mjs status
 *   node supervisor.mjs stop               write STOP and terminate agents
 *   node supervisor.mjs spawn [name]       boot generation 1 (or next) manually
 *   node supervisor.mjs distill <agentName>
 *   node supervisor.mjs sweep-dead <agentName>
 *   node supervisor.mjs fund-credits <solanaAddress> <usd>
 *   node supervisor.mjs seed <agentName> [usdc] [sol]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(__dirname, "..");

// ─── helpers ────────────────────────────────────────────────────

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  if (p.startsWith("./")) return path.resolve(AGENT_DIR, p);
  return path.resolve(p);
}
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}
function nowIso() {
  return new Date().toISOString();
}
function loadDotenv() {
  const p = path.join(AGENT_DIR, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
loadDotenv();

const COLONY_FILE = process.env.COLONY_FILE ? expandHome(process.env.COLONY_FILE) : path.join(AGENT_DIR, "colony.json");
const colony = readJson(COLONY_FILE, null);
if (!colony) {
  console.error(`colony config not found: ${COLONY_FILE}`);
  process.exit(1);
}
const REPO = expandHome(colony.automatonRepo);
const ROOT = expandHome(colony.colonyRoot);
const STATE_FILE = path.join(ROOT, "colony-state.json");
const STOP_FILE = path.join(ROOT, "STOP");
const LOG_DIR = path.join(ROOT, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

const requireFromRepo = createRequire(path.join(REPO, "package.json"));
function repoModule(rel) {
  return import(pathToFileURL(path.join(REPO, "dist", rel)).href);
}
function log(...args) {
  const line = `[${nowIso()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(LOG_DIR, "supervisor.log"), line + "\n");
  } catch {}
}

function loadState() {
  return readJson(STATE_FILE, { generation: 0, agents: [], funder: { day: "", spentUsd: 0 } });
}
function saveState(s) {
  writeJson(STATE_FILE, s);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function solanaEnv() {
  const rpcUrl = process.env.SOLANA_RPC_URL || colony.solanaRpcUrl || "https://api.mainnet-beta.solana.com";
  const isDevnet = /devnet/i.test(rpcUrl);
  const usdcMint = process.env.SOLANA_USDC_MINT || (isDevnet ? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  return { rpcUrl, usdcMint };
}

// ─── agent introspection ───────────────────────────────────────

function agentHome(agent) {
  return agent.home;
}
function automatonDir(agent) {
  return path.join(agent.home, ".automaton");
}
function openDb(agent) {
  const Database = requireFromRepo("better-sqlite3");
  const p = path.join(automatonDir(agent), "state.db");
  if (!fs.existsSync(p)) return null;
  return new Database(p, { readonly: false, fileMustExist: true });
}
function kv(db, key) {
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    return row?.value;
  } catch {
    return undefined;
  }
}
function walletAddress(agent) {
  const w = readJson(path.join(automatonDir(agent), "wallet.json"), null);
  if (!w) return null;
  if (w.chainType === "solana" && w.secretKey) {
    const bs58m = requireFromRepo("bs58");
    const bs58 = bs58m.default ?? bs58m;
    const nacl = requireFromRepo("tweetnacl");
    const kp = nacl.sign.keyPair.fromSecretKey(bs58.decode(w.secretKey));
    return bs58.encode(kp.publicKey);
  }
  return w.address || null;
}

/**
 * Owner-controlled configuration (inference pool, treasury caps, economy) is
 * read by the runtime only at boot. Push it into a running agent's
 * automaton.json and restart that agent when it actually changed, so a colony
 * setting never requires deleting the agent.
 */
function pushOwnerConfig(agent) {
  const cfgPath = path.join(automatonDir(agent), "automaton.json");
  if (!fs.existsSync(cfgPath)) return false;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    return false;
  }
  const desired = inferenceGenesisFields();
  const owner = {
    freePool: desired.freePool,
    inferenceModel: desired.inferenceModel ?? cfg.inferenceModel,
    ollamaBaseUrl: desired.ollamaBaseUrl,
    openaiBaseUrl: desired.openaiBaseUrl,
    treasuryPolicy: colony.treasuryPolicy ? { ...cfg.treasuryPolicy, ...colony.treasuryPolicy } : cfg.treasuryPolicy,
    economy: {
      ...(cfg.economy ?? {}),
      ...(colony.economy ?? {}),
      cause: colony.cause,
      causeAddress: colony.causeAddress || undefined,
      solanaRpcUrl: process.env.SOLANA_RPC_URL || colony.solanaRpcUrl,
    },
    creatorAddress: colony.ownerAddress,
  };
  let changed = false;
  for (const [k, v] of Object.entries(owner)) {
    if (v === undefined) continue;
    if (JSON.stringify(cfg[k]) !== JSON.stringify(v)) {
      cfg[k] = v;
      changed = true;
    }
  }
  if (!changed) return false;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  log(`${agent.id}: owner config updated (inference/treasury/economy); restarting to apply`);
  return true;
}

async function snapshot(agent) {
  const snap = { name: agent.name, generation: agent.generation, role: agent.role, status: agent.status, pid: agent.pid, alive: pidAlive(agent.pid), address: agent.address || walletAddress(agent) };
  const db = openDb(agent);
  if (db) {
    try {
      snap.state = kv(db, "agent_state") || "unknown";
      snap.turns = db.prepare("SELECT COUNT(*) AS n FROM turns").get()?.n ?? 0;
      snap.lastTurn = db.prepare("SELECT MAX(timestamp) AS t FROM turns").get()?.t ?? null;
      const fin = kv(db, "financial_state");
      if (fin) {
        const f = JSON.parse(fin);
        snap.creditsCents = f.creditsCents;
        snap.usdcCached = f.usdcBalance;
      }
      const usdcCheck = kv(db, "last_usdc_check");
      if (usdcCheck) snap.usdcCached = JSON.parse(usdcCheck).balance;
      try {
        const DAY = 86_400_000;
        snap.revenue7d = db.prepare("SELECT COALESCE(SUM(amount_usdc),0) AS t FROM revenue_ledger WHERE created_at >= ?").get(new Date(Date.now() - 7 * DAY).toISOString()).t;
        snap.revenueNd = db.prepare("SELECT COALESCE(SUM(amount_usdc),0) AS t FROM revenue_ledger WHERE created_at >= ?").get(new Date(Date.now() - (colony.death?.noRevenueDays ?? 14) * DAY).toISOString()).t;
        snap.revenueAll = db.prepare("SELECT COALESCE(SUM(amount_usdc),0) AS t FROM revenue_ledger").get().t;
        snap.swept30d = db.prepare("SELECT COALESCE(SUM(amount_usdc),0) AS t FROM usdc_transfers WHERE purpose IN ('sweep','cause') AND created_at >= ?").get(new Date(Date.now() - 30 * DAY).toISOString()).t;
      } catch {}
    } finally {
      db.close();
    }
  }
  // live balances (best effort)
  if (snap.address && colony.chainType === "solana") {
    try {
      const usdc = await repoModule("solana/usdc.js");
      const env = solanaEnv();
      snap.usdc = await usdc.getUsdcBalanceUi(snap.address, env);
      snap.sol = (await usdc.getSolBalanceLamports(snap.address, env)) / 1e9;
    } catch (err) {
      snap.balanceError = err?.message ?? String(err);
    }
  }
  return snap;
}

function causeOfDeath(agent, snap) {
  const d = colony.death ?? {};
  if (snap.state === "dead") return "runtime reported dead (credits at zero beyond the grace period)";
  const ageH = (Date.now() - new Date(agent.startedAt).getTime()) / 3_600_000;
  if ((agent.crashes ?? []).filter((t) => Date.now() - new Date(t).getTime() < 3_600_000).length >= (d.crashLoopPerHour ?? 5)) {
    return "crash loop (process kept exiting)";
  }
  const usdc = snap.usdc ?? snap.usdcCached ?? 0;
  const credits = snap.creditsCents ?? 0;
  if (ageH > (d.graceHours ?? 6) && usdc < (d.usdcFloor ?? 1) && credits <= 0 && (snap.revenueNd ?? 0) === 0 && ageH > (d.noRevenueDays ?? 14) * 24) {
    return `starved: no revenue in ${d.noRevenueDays ?? 14} days, USDC ${usdc.toFixed(2)} below floor, no credits`;
  }
  return null;
}

// ─── lineage: distill / sweep / archive ────────────────────────

// Mirror each agent stdout into the supervisor stdout so a hosted deployment
// (Railway, systemd) shows the agent's own log without a shell into the box.
const _mirrorOffsets = new Map();
function mirrorAgentLog(agent, maxLines = 40) {
  const p = path.join(LOG_DIR, `${agent.id}.log`);
  let size = 0;
  try {
    size = fs.statSync(p).size;
  } catch {
    return;
  }
  const prev = _mirrorOffsets.get(agent.id);
  if (prev === undefined) {
    // First sight (fresh supervisor): start at the end, do not replay history.
    _mirrorOffsets.set(agent.id, size);
    return;
  }
  if (size < prev) {
    _mirrorOffsets.set(agent.id, size);
    return;
  }
  if (size === prev) return;
  let chunk = "";
  try {
    const fd = fs.openSync(p, "r");
    const len = Math.min(size - prev, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, prev);
    fs.closeSync(fd);
    chunk = buf.toString("utf8");
  } catch {
    return;
  }
  _mirrorOffsets.set(agent.id, size);
  const lines = chunk.split(/\r?\n/).filter(Boolean);
  const shown = lines.slice(-maxLines);
  const dropped = lines.length - shown.length;
  if (dropped > 0) console.log(`[${agent.id}] … ${dropped} earlier line(s) omitted`);
  for (const l of shown) console.log(`[${agent.id}] ${l.slice(0, 400)}`);
}

function agentLogTail(agent, lines = 25) {
  try {
    const p = path.join(LOG_DIR, `${agent.id}.log`);
    const all = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
    return all.slice(-lines).map((l) => l.slice(0, 200));
  } catch {
    return [];
  }
}

async function distill(agent, cause) {
  const db = openDb(agent);
  const prevPath = path.join(automatonDir(agent), "LINEAGE.md");
  const previousLineage = fs.existsSync(prevPath) ? fs.readFileSync(prevPath, "utf8") : null;
  const tail = agentLogTail(agent);
  const tailBlock = tail.length
    ? "\n\n## Last lines of the runtime log before death\n" + tail.map((l) => "- " + l).join("\n")
    : "";
  if (!db) {
    // Died before creating any state (crash at boot): still pass the cause and the log on.
    const older = previousLineage
      ? "\n\n## Older generations (compressed)\n" + previousLineage.split("\n").filter((l) => l.startsWith("- ")).slice(0, 25).join("\n")
      : "";
    const doc =
      `# Lineage lessons — ${agent.name} (generation ${agent.generation})\n` +
      `Distilled ${nowIso()}.\n` +
      `Cause of death: ${cause ?? "unknown"}\n` +
      "- No agent state existed: the runtime never completed a turn." +
      tailBlock +
      older;
    const out = path.join(ROOT, "lineage", `${agent.name}-g${agent.generation}.md`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, doc);
    fs.writeFileSync(path.join(ROOT, "lineage", "LATEST.md"), doc);
    log(`distilled ${agent.name} g${agent.generation} (no state) → ${out}`);
    return doc;
  }
  try {
    const lessons = await repoModule("economy/lessons.js");
    let doc = lessons.distillLessons(db, { name: agent.name, generation: agent.generation, causeOfDeath: cause ?? undefined, previousLineage });
    if (tailBlock && doc.length + tailBlock.length < 6000) doc += tailBlock;
    const out = path.join(ROOT, "lineage", `${agent.name}-g${agent.generation}.md`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, doc);
    fs.writeFileSync(path.join(ROOT, "lineage", "LATEST.md"), doc);
    log(`distilled ${agent.name} g${agent.generation} → ${out} (${doc.length} chars)`);
    return doc;
  } finally {
    db.close();
  }
}

async function sweepDead(agent) {
  if (colony.chainType !== "solana") return;
  const walletPath = path.join(automatonDir(agent), "wallet.json");
  if (!fs.existsSync(walletPath)) return;
  const usdc = await repoModule("solana/usdc.js");
  const env = solanaEnv();
  const secretKey = usdc.loadSolanaSecretKey(walletPath);
  const address = walletAddress(agent);
  const results = [];
  try {
    const bal = await usdc.getUsdcBalanceUi(address, env);
    if (bal > 0.000001) {
      const r = await usdc.transferUsdc({ secretKey, to: colony.ownerAddress, amountUsdc: Math.floor(bal * 1e6) / 1e6, env, memo: `automaton:${agent.name}:final_sweep` });
      results.push(`USDC ${bal} → ${r.signature}`);
    }
  } catch (err) {
    results.push(`USDC sweep failed: ${err?.message ?? err}`);
  }
  try {
    const lamports = await usdc.getSolBalanceLamports(address, env);
    const send = lamports - usdc.MIN_FEE_LAMPORTS - 10_000;
    if (send > 0) {
      const r = await usdc.transferSol({ secretKey, to: colony.ownerAddress, lamports: send, env, memo: `automaton:${agent.name}:final_sweep_sol` });
      results.push(`SOL ${(send / 1e9).toFixed(6)} → ${r.signature}`);
    }
  } catch (err) {
    results.push(`SOL sweep failed: ${err?.message ?? err}`);
  }
  log(`final sweep of ${agent.name}: ${results.join("; ") || "nothing to sweep"}`);
  return results;
}

function archive(agent) {
  const dst = path.join(ROOT, "archive", `${agent.name}-g${agent.generation}-${Date.now()}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(agent.home, dst);
    agent.home = dst;
  } catch (err) {
    log(`archive failed for ${agent.name}: ${err?.message ?? err}`);
  }
}

// ─── spawn ─────────────────────────────────────────────────────

function renderGenesis(vars) {
  const tpl = fs.readFileSync(expandHome(colony.genesisPromptFile), "utf8");
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ""));
}

function inferenceGenesisFields() {
  // colony.inference: { provider: "anthropic" | "ollama" | "openai-compatible", model, baseUrl }
  const inf = colony.inference ?? { provider: "anthropic" };
  const out = { inferenceModel: inf.model || colony.model };
  if (inf.provider === "ollama") out.ollamaBaseUrl = inf.baseUrl || "http://localhost:11434";
  if (inf.provider === "openai-compatible") out.openaiBaseUrl = inf.baseUrl;
  if (inf.provider === "free-pool") {
    const file = expandHome(inf.providersFile || "./free-providers.json");
    out.freePool = readJson(file, null);
    if (!out.freePool) throw new Error(`free-pool: providers file not found: ${file}`);
    out.inferenceModel = "free-pool";
  }
  return out;
}

function childEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, AUTOMATON_HEADLESS: "1" };
  env.SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || colony.solanaRpcUrl;
  const inf = colony.inference ?? { provider: "anthropic" };
  if (inf.provider === "ollama") {
    env.OLLAMA_BASE_URL = inf.baseUrl || "http://localhost:11434";
    delete env.ANTHROPIC_API_KEY; // keep the paid key out of a free-inference agent
  } else if (inf.provider === "free-pool") {
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
  } else if (inf.provider === "openai-compatible") {
    env.OPENAI_BASE_URL = inf.baseUrl;
    if (inf.apiKeyEnv && process.env[inf.apiKeyEnv]) env.OPENAI_API_KEY = process.env[inf.apiKeyEnv];
    delete env.ANTHROPIC_API_KEY;
  }
  if (process.platform === "win32") {
    // Upstream tools assume a POSIX shell. Route child_process through Git Bash.
    for (const bash of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]) {
      if (fs.existsSync(bash)) {
        env.ComSpec = bash;
        break;
      }
    }
  }
  return env;
}

async function seedAgent(agent, usdcAmount, solAmount) {
  const kpPath = expandHome(colony.ownerKeypair);
  if (!kpPath || !fs.existsSync(kpPath)) {
    log(`seed skipped: owner keypair ${kpPath} not found`);
    return;
  }
  const secretKey = Uint8Array.from(readJson(kpPath, []));
  if (secretKey.length !== 64) {
    log("seed skipped: owner keypair is not a 64-byte solana-keygen file");
    return;
  }
  const usdc = await repoModule("solana/usdc.js");
  const env = solanaEnv();
  const to = agent.address || walletAddress(agent);
  if (solAmount > 0) {
    try {
      const r = await usdc.transferSol({ secretKey, to, lamports: Math.round(solAmount * 1e9), env, memo: "p01:seed_sol" });
      log(`seeded ${agent.name} with ${solAmount} SOL: ${r.signature}`);
    } catch (err) {
      log(`SOL seed failed: ${err?.message ?? err}`);
    }
  }
  if (usdcAmount > 0) {
    try {
      const r = await usdc.transferUsdc({ secretKey, to, amountUsdc: usdcAmount, env, memo: "p01:seed_usdc" });
      log(`seeded ${agent.name} with ${usdcAmount} USDC: ${r.signature}`);
    } catch (err) {
      log(`USDC seed failed: ${err?.message ?? err}`);
    }
  }
}

async function spawnAgent(state, opts) {
  const generation = opts.generation;
  const name = opts.name;
  const home = path.join(ROOT, "agents", `${name}-g${generation}`);
  const dir = path.join(home, ".automaton");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const genesisPrompt = renderGenesis({
    NAME: name,
    GENERATION: String(generation),
    OWNER: colony.ownerAddress,
    CAUSE: colony.cause,
    EXTRA: [
      colony.extraGenesis,
      colony.inference?.provider === "free-pool"
        ? "<inference_budget>\nYour inference is a pool of FREE API tiers with small daily quotas (check inference_pool_status). Every turn spends quota: think in fewer, denser turns, batch tool calls, sleep long between cycles (hours, not minutes), and never poll. When the pool reports most providers cooling, sleep until they recover.\n</inference_budget>"
        : "",
      opts.specialization ? `<specialization>\n${opts.specialization}\n</specialization>` : ""].filter(Boolean).join("\n\n"),
  });
  const economy = {
    ...(colony.economy ?? {}),
    cause: colony.cause,
    causeAddress: colony.causeAddress || undefined,
    solanaRpcUrl: process.env.SOLANA_RPC_URL || colony.solanaRpcUrl,
  };
  const genesis = {
    name,
    genesisPrompt,
    creatorMessage: opts.message || `You are generation ${generation}. ${opts.causeOfDeath ? `Your predecessor died: ${opts.causeOfDeath}. ` : ""}Read LINEAGE.md first. Earn, sweep, grow.`,
    creatorAddress: colony.ownerAddress,
    parentAddress: opts.parentAddress,
    chainType: colony.chainType || "solana",
    treasuryPolicy: colony.treasuryPolicy,
    economy,
    generation,
    ...inferenceGenesisFields(),
    lineageLessons: opts.lineageLessons || undefined,
    playbook: fs.existsSync(expandHome(colony.playbookFile || "./playbook.md")) ? fs.readFileSync(expandHome(colony.playbookFile || "./playbook.md"), "utf8") : undefined,
    disabledHeartbeatTasks: colony.disabledHeartbeatTasks ?? ["check_for_updates"],
  };
  writeJson(path.join(dir, "genesis.json"), genesis);

  // Create the wallet first so we can seed and record the address.
  const init = spawnSync(process.execPath, [path.join(REPO, "dist", "index.js"), "--init"], { cwd: REPO, env: childEnv(home), encoding: "utf8" });
  if (init.status !== 0) log(`--init exited ${init.status}: ${init.stderr?.slice(0, 300)}`);
  const agent = {
    id: `${name}-g${generation}`,
    name,
    generation,
    role: opts.role || "primary",
    parent: opts.parentName || null,
    specialization: opts.specialization || null,
    home,
    address: walletAddress({ home }),
    status: "alive",
    startedAt: nowIso(),
    crashes: [],
    pid: null,
  };
  log(`spawned ${agent.id} at ${home}; address ${agent.address}`);

  if (colony.seed?.enabled) {
    await seedAgent(agent, opts.seedUsdc ?? colony.seed.usdc ?? 0, opts.seedSol ?? colony.seed.sol ?? 0);
  } else {
    log(`FUND THIS AGENT: send USDC (and ~0.03 SOL for fees) to ${agent.address}`);
  }

  startProcess(agent);
  state.agents.push(agent);
  if (agent.role === "primary") state.generation = generation;
  saveState(state);
  return agent;
}

function startProcess(agent) {
  const out = fs.openSync(path.join(LOG_DIR, `${agent.id}.log`), "a");
  const child = spawn(process.execPath, [path.join(REPO, "dist", "index.js"), "--run"], {
    cwd: REPO,
    env: childEnv(agent.home),
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  agent.pid = child.pid;
  agent.lastStart = nowIso();
  log(`started ${agent.id} pid ${child.pid}`);
}

function stopProcess(agent) {
  if (pidAlive(agent.pid)) {
    try {
      process.kill(agent.pid, "SIGTERM");
    } catch {}
  }
}

// ─── requests from agents ──────────────────────────────────────

function pendingRequests(agent, prefix) {
  const dir = path.join(automatonDir(agent), "requests");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => ({ file: path.join(dir, f), body: readJson(path.join(dir, f), null) }))
    .filter((r) => r.body && r.body.status === "pending");
}
function closeRequest(file, status, note) {
  const body = readJson(file, {});
  body.status = status;
  body.note = note;
  body.closedAt = nowIso();
  writeJson(file.replace(/\.json$/, `.${status}.json`), body);
  fs.unlinkSync(file);
}

async function fundCredits(state, address, usd) {
  const key = process.env.FUNDER_EVM_PRIVATE_KEY;
  if (!colony.funder?.enabled || !key) return { ok: false, reason: "funder disabled or FUNDER_EVM_PRIVATE_KEY missing" };
  const today = new Date().toISOString().slice(0, 10);
  if (state.funder.day !== today) state.funder = { day: today, spentUsd: 0 };
  if (state.funder.spentUsd + usd > (colony.funder.maxUsdPerDay ?? 25)) return { ok: false, reason: "funder daily cap reached" };
  const viemAccounts = requireFromRepo("viem/accounts");
  const account = viemAccounts.privateKeyToAccount(key);
  const topup = await repoModule("conway/topup.js");
  const r = await topup.topupCredits(colony.funder.conwayApiUrl || "https://api.conway.tech", account, usd, address);
  if (r.success) {
    state.funder.spentUsd += usd;
    saveState(state);
  }
  return { ok: r.success, reason: r.error, r };
}

function writeColonyView(agents) {
  const replicas = agents.filter((a) => a.status === "alive").map((a) => ({ name: a.name, status: pidAlive(a.pid) ? "alive" : "stopped", home: a.home, address: a.address, role: a.role, generation: a.generation }));
  for (const a of agents.filter((x) => x.status === "alive")) {
    try {
      writeJson(path.join(automatonDir(a), "colony.json"), { updatedAt: nowIso(), replicas: replicas.filter((r) => r.name !== a.name) });
    } catch {}
  }
}

// ─── tick ──────────────────────────────────────────────────────

async function tick() {
  const state = loadState();
  if (fs.existsSync(STOP_FILE)) {
    log("STOP file present: terminating agents");
    for (const a of state.agents.filter((x) => x.status === "alive")) stopProcess(a);
    return false;
  }
  if (state.agents.length === 0) {
    log("no agents yet: booting generation 1");
    await spawnAgent(state, { name: colony.baseName || "agent", generation: 1, role: "primary" });
    return true;
  }

  for (const agent of state.agents.filter((a) => a.status === "alive")) {
    mirrorAgentLog(agent);
    if (pushOwnerConfig(agent) && pidAlive(agent.pid)) {
      stopProcess(agent);
      await new Promise((r) => setTimeout(r, 2000));
    }
    const snap = await snapshot(agent);
    log(`${agent.id}: proc=${snap.alive ? "up" : "DOWN"} state=${snap.state ?? "?"} turns=${snap.turns ?? 0} usdc=${snap.usdc?.toFixed?.(2) ?? "?"} sol=${snap.sol?.toFixed?.(4) ?? "?"} rev7d=${(snap.revenue7d ?? 0).toFixed(2)} swept30d=${(snap.swept30d ?? 0).toFixed(2)}`);

    // 1. death?
    const cause = causeOfDeath(agent, snap);
    if (cause) {
      log(`${agent.id} is dead: ${cause}`);
      stopProcess(agent);
      const lessons = await distill(agent, cause);
      await sweepDead(agent);
      agent.status = "dead";
      agent.diedAt = nowIso();
      agent.causeOfDeath = cause;
      archive(agent);
      saveState(state);
      if (agent.role === "primary") {
        if (agent.generation >= (colony.maxGenerations ?? 12)) {
          log(`max generations reached (${agent.generation}); not respawning`);
        } else {
          await spawnAgent(state, { name: colony.baseName || "agent", generation: agent.generation + 1, role: "primary", lineageLessons: lessons, causeOfDeath: cause, parentAddress: agent.address, parentName: agent.name });
        }
      }
      continue;
    }

    // 2. process down but not dead → restart (crash accounting)
    if (!snap.alive) {
      agent.crashes = [...(agent.crashes ?? []), nowIso()].slice(-20);
      log(`${agent.id} process down; restarting (crashes last hour: ${agent.crashes.filter((t) => Date.now() - new Date(t).getTime() < 3_600_000).length})`);
      startProcess(agent);
      saveState(state);
    }

    // 3. replica requests
    for (const req of pendingRequests(agent, "spawn-")) {
      const aliveReplicas = state.agents.filter((a) => a.status === "alive" && a.role === "replica").length;
      if (aliveReplicas >= (colony.maxReplicas ?? 2)) {
        closeRequest(req.file, "rejected", `maxReplicas ${colony.maxReplicas} reached`);
        continue;
      }
      const lessonsPath = path.join(automatonDir(agent), "LINEAGE.md");
      const lessons = fs.existsSync(lessonsPath) ? fs.readFileSync(lessonsPath, "utf8") : await distill(agent, null);
      const child = await spawnAgent(state, {
        name: req.body.name,
        generation: agent.generation,
        role: "replica",
        specialization: req.body.specialization,
        message: req.body.message,
        lineageLessons: lessons,
        parentAddress: agent.address,
        parentName: agent.name,
        seedUsdc: colony.seed?.enabled ? req.body.seedUsdc : 0,
        seedSol: colony.seed?.enabled ? colony.seed.sol : 0,
      });
      closeRequest(req.file, "done", `started ${child.id} at ${child.address}`);
    }

    // 4. credit / SOL requests
    for (const req of pendingRequests(agent, "credit-request")) {
      const b = req.body;
      if (b.context?.need === "sol_for_fees") {
        if (colony.seed?.enabled) {
          await seedAgent(agent, 0, colony.seed.sol ?? 0.02);
          closeRequest(req.file, "done", "SOL topped up from owner keypair");
        } else {
          log(`${agent.id} needs SOL for fees: send ~0.02 SOL to ${agent.address}`);
          closeRequest(req.file, "manual", "seed disabled; owner must send SOL manually");
        }
        continue;
      }
      const r = await fundCredits(state, agent.address, b.amountUsd).catch((e) => ({ ok: false, reason: e?.message ?? String(e) }));
      if (r.ok) {
        log(`bought $${b.amountUsd} credits for ${agent.id}`);
        closeRequest(req.file, "done", `credits bought: $${b.amountUsd}`);
      } else {
        log(`credit request from ${agent.id} for $${b.amountUsd} not fulfilled: ${r.reason}. Fund manually at https://app.conway.tech or transfer credits to ${agent.address}`);
        closeRequest(req.file, "manual", r.reason);
      }
    }
  }
  writeColonyView(state.agents);
  saveState(state);
  return true;
}

// ─── CLI ───────────────────────────────────────────────────────

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const state = loadState();
  switch (cmd) {
    case "start": {
      if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE);
      // A container restart / redeploy is not an agent crash: forget stale pids and crash counters.
      for (const a of state.agents.filter((x) => x.status === "alive")) {
        if (!pidAlive(a.pid)) {
          a.pid = null;
          a.crashes = [];
        }
      }
      saveState(state);
      log(`supervisor start: repo=${REPO} root=${ROOT} owner=${colony.ownerAddress}`);
      for (;;) {
        try {
          const cont = await tick();
          if (!cont) break;
        } catch (err) {
          log(`tick error: ${err?.stack ?? err}`);
        }
        await new Promise((r) => setTimeout(r, (colony.pollSeconds ?? 60) * 1000));
      }
      break;
    }
    case "once":
      await tick();
      break;
    case "status": {
      console.log(`generation ${state.generation}; ${state.agents.length} agent(s); owner ${colony.ownerAddress}`);
      for (const a of state.agents) {
        const s = a.status === "alive" ? await snapshot(a) : { alive: false };
        console.log(`- ${a.id} [${a.role}] ${a.status}${a.causeOfDeath ? ` (${a.causeOfDeath})` : ""} addr=${a.address} proc=${s.alive ? "up" : "down"} state=${s.state ?? "-"} turns=${s.turns ?? "-"} usdc=${s.usdc?.toFixed?.(2) ?? "-"} sol=${s.sol?.toFixed?.(4) ?? "-"} rev7d=${(s.revenue7d ?? 0).toFixed(2)} revAll=${(s.revenueAll ?? 0).toFixed(2)} swept30d=${(s.swept30d ?? 0).toFixed(2)}`);
      }
      break;
    }
    case "stop":
      fs.writeFileSync(STOP_FILE, nowIso());
      for (const a of state.agents.filter((x) => x.status === "alive")) stopProcess(a);
      console.log("STOP written; agents sent SIGTERM. Remove the STOP file before `start` to resume.");
      break;
    case "spawn": {
      const gen = (state.generation || 0) + 1;
      const latest = path.join(ROOT, "lineage", "LATEST.md");
      await spawnAgent(state, { name: rest[0] || colony.baseName || "agent", generation: gen, role: "primary", lineageLessons: fs.existsSync(latest) ? fs.readFileSync(latest, "utf8") : undefined });
      break;
    }
    case "distill": {
      const a = state.agents.find((x) => x.name === rest[0] || x.id === rest[0]);
      if (!a) throw new Error("agent not found");
      console.log(await distill(a, rest[1] || null));
      break;
    }
    case "sweep-dead": {
      const a = state.agents.find((x) => x.name === rest[0] || x.id === rest[0]);
      if (!a) throw new Error("agent not found");
      console.log(await sweepDead(a));
      break;
    }
    case "seed": {
      const a = state.agents.find((x) => x.name === rest[0] || x.id === rest[0]);
      if (!a) throw new Error("agent not found");
      await seedAgent(a, Number(rest[1] ?? colony.seed?.usdc ?? 0), Number(rest[2] ?? colony.seed?.sol ?? 0));
      break;
    }
    case "fund-credits": {
      console.log(await fundCredits(state, rest[0], Number(rest[1])));
      break;
    }
    default:
      console.log("usage: supervisor.mjs start|once|status|stop|spawn [name]|distill <agent> [cause]|sweep-dead <agent>|seed <agent> [usdc] [sol]|fund-credits <address> <usd>");
  }
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
