import Link from "next/link";
import { Download, ShieldCheck, Puzzle, FolderOpen, ToggleRight, MousePointerClick, AlertTriangle } from "lucide-react";

export const metadata = {
  title: "Protocol 01 — Chrome Extension (Beta)",
  description: "Install the Protocol 01 privacy wallet extension on Chrome, Opera, Edge or Brave. Beta · Solana Devnet.",
};

const VERSION = "0.5.0";
const ZIP = `/protocol01-extension-${VERSION}.zip`;

const STEPS: { icon: React.ComponentType<{ className?: string }>; title: string; body: React.ReactNode }[] = [
  {
    icon: Download,
    title: "1 · Download & unzip",
    body: <>Download the <code className="text-p01-cyan">.zip</code> above and extract it. You'll get a folder named <code className="text-p01-cyan">protocol01-extension-{VERSION}</code>.</>,
  },
  {
    icon: Puzzle,
    title: "2 · Open the extensions page",
    body: <>Go to <code className="text-p01-cyan">chrome://extensions</code> (Opera: <code className="text-p01-cyan">opera://extensions</code>, Edge: <code className="text-p01-cyan">edge://extensions</code>, Brave: <code className="text-p01-cyan">brave://extensions</code>).</>,
  },
  {
    icon: ToggleRight,
    title: "3 · Enable Developer mode",
    body: <>Toggle <span className="text-white font-medium">Developer mode</span> on (top-right of the page).</>,
  },
  {
    icon: FolderOpen,
    title: "4 · Load unpacked",
    body: <>Click <span className="text-white font-medium">Load unpacked</span> and select the unzipped <code className="text-p01-cyan">protocol01-extension-{VERSION}</code> folder.</>,
  },
  {
    icon: MousePointerClick,
    title: "5 · Pin & open",
    body: <>Pin Protocol 01 from the puzzle icon, open it, and create or connect a wallet.</>,
  },
];

export default function ExtensionPage() {
  return (
    <main className="min-h-screen bg-p01-void text-white">
      <section className="relative py-20 px-4">
        <div className="max-w-3xl mx-auto">
          {/* Badge */}
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="text-[10px] font-mono text-p01-cyan tracking-[0.3em] uppercase">Chrome Extension</span>
            <span className="text-[10px] font-mono tracking-[0.2em] uppercase px-2 py-0.5 rounded-full border border-amber-400/40 text-amber-300 bg-amber-400/10">
              Beta · Devnet
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold text-center font-display mb-3">
            Install Protocol 01
          </h1>
          <p className="text-center text-p01-text-muted/70 max-w-xl mx-auto mb-2">
            Privacy-first Solana wallet — stealth addresses, shielded notes, and cross-device recurring subscriptions, right in your browser.
          </p>
          <p className="text-center text-xs font-mono text-p01-text-muted/50 mb-10">
            v{VERSION} · works on Chrome, Opera, Edge & Brave
          </p>

          {/* Download */}
          <div className="flex flex-col items-center gap-3 mb-12">
            <a
              href={ZIP}
              download
              className="inline-flex items-center gap-3 px-8 py-4 rounded-xl bg-p01-cyan text-p01-void font-display font-bold tracking-wide hover:bg-p01-cyan-dim transition-colors shadow-[0_0_40px_rgba(57,197,187,0.25)]"
            >
              <Download className="w-5 h-5" />
              Download extension (.zip)
            </a>
            <span className="text-[11px] font-mono text-p01-text-muted/50">protocol01-extension-{VERSION}.zip</span>
          </div>

          {/* Steps */}
          <div className="space-y-3">
            {STEPS.map((step) => {
              const Icon = step.icon;
              return (
                <div key={step.title} className="flex items-start gap-4 p-4 rounded-xl border border-p01-border bg-p01-surface/40">
                  <div className="shrink-0 w-10 h-10 rounded-lg bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center">
                    <Icon className="w-5 h-5 text-p01-cyan" />
                  </div>
                  <div>
                    <h3 className="font-display font-semibold text-white">{step.title}</h3>
                    <p className="text-sm text-p01-text-muted/70 mt-0.5">{step.body}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Devnet / beta notice */}
          <div className="mt-10 flex items-start gap-3 p-4 rounded-xl border border-amber-400/30 bg-amber-400/5">
            <AlertTriangle className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-100/80">
              <span className="font-semibold text-amber-200">Beta on Solana Devnet.</span> This build uses test SOL — no real funds.
              It installs in Developer mode because it&apos;s not yet on the Chrome Web Store. A one-click store listing is coming next.
            </p>
          </div>

          {/* Trust line */}
          <div className="mt-6 flex items-center justify-center gap-2 text-xs text-p01-text-muted/50">
            <ShieldCheck className="w-4 h-4 text-p01-cyan" />
            Your seed phrase is encrypted and stays on your device. It never leaves your browser.
          </div>

          <div className="mt-10 text-center">
            <Link href="/" className="text-sm font-mono text-p01-cyan hover:underline">← Back to protocol01</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
