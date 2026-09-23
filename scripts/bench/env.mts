/**
 * What the machine and the tree were when a run started. Read from the system
 * at run time, never typed in: a benchmark JSON that carries a hand-written CPU
 * name is a claim, one that carries the WMI answer is a record.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function run(cmd: string, args: string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
}

function windowsInventory(): Record<string, unknown> {
  const ps = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8;',
    '$c = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed;',
    '$m = @(Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity,Speed,ConfiguredClockSpeed,Manufacturer,PartNumber);',
    '$o = Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture;',
    "$r = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';",
    '$p = (powercfg /getactivescheme) -join " ";',
    '[pscustomobject]@{ cpu=$c; memory=$m; os=$o; ubr=$r.UBR; display_version=$r.DisplayVersion; power_scheme=$p } | ConvertTo-Json -Depth 4 -Compress',
  ].join(' ');
  const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  try { return JSON.parse(out) as Record<string, unknown>; } catch { return { error: 'WMI query failed' }; }
}

/** CPU busy share over `ms` milliseconds, from os.cpus() tick counters (works on Windows, where loadavg is 0). */
export async function cpuBusyPercent(ms = 2000): Promise<number> {
  const snap = () => os.cpus().map((c) => c.times);
  const a = snap();
  await new Promise((r) => setTimeout(r, ms));
  const b = snap();
  let busy = 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (k: keyof typeof a[number]) => b[i][k] - a[i][k];
    const t = d('user') + d('nice') + d('sys') + d('irq') + d('idle');
    busy += t - d('idle');
    total += t;
  }
  return total > 0 ? (100 * busy) / total : 0;
}

export function browserVersion(exe: string): string {
  if (process.platform === 'win32') {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`]);
  }
  return run(exe, ['--version']);
}

export function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

export function collectEnvironment(repoRoot: string): Record<string, unknown> {
  const blob = path.join(repoRoot, 'packages/stark-prover/wasm/p01_stark_bg.wasm');
  const typesTs = path.join(repoRoot, 'packages/stark-prover/src/types.ts');
  const programId = existsSync(typesTs)
    ? (/DEFAULT_STARK_VERIFIER_PROGRAM_ID = '([1-9A-HJ-NP-Za-km-z]+)'/.exec(readFileSync(typesTs, 'utf8'))?.[1] ?? '')
    : '';
  const porcelain = run('git', ['status', '--porcelain', '--untracked-files=no'], repoRoot);
  return {
    captured_at: new Date().toISOString(),
    platform: { platform: process.platform, arch: process.arch, release: os.release() },
    machine: process.platform === 'win32' ? windowsInventory() : {
      cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, total_memory_bytes: os.totalmem(),
    },
    node_reported: { logical_cpus: os.cpus().length, total_memory_bytes: os.totalmem(), free_memory_bytes: os.freemem() },
    toolchain: {
      node: process.version,
      rustc: run('rustc', ['--version']),
      cargo: run('cargo', ['--version']),
    },
    tree: {
      commit: run('git', ['rev-parse', 'HEAD'], repoRoot),
      branch: run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot),
      tracked_files_modified: porcelain ? porcelain.split('\n').length : 0,
    },
    prover: existsSync(blob) ? { blob: 'packages/stark-prover/wasm/p01_stark_bg.wasm', bytes: readFileSync(blob).length, sha256: sha256File(blob) } : null,
    verifier_program_id: programId,
  };
}
