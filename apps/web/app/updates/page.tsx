"use client";

import React from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowLeft, Play, Clock, CheckCircle } from "lucide-react";
import Footer from "@/components/Footer";
import { LanguageSwitcher } from "@/i18n";

interface WeekUpdate {
  week: number;
  title: string;
  date: string;
  status: "published" | "coming-soon";
  video?: string;
  highlights: string[];
}

const updates: WeekUpdate[] = [
  {
    week: 1,
    title: "Mugen Exchange & Superteam Ireland",
    date: "April 6 - 12, 2026",
    status: "published",
    video: "/videos/week1.mp4",
    highlights: [
      "Built Mugen Exchange — P2P fiat-to-crypto with ZK compliance",
      "Full Solana program: escrow, reputation, dispute resolution",
      "Wired into mobile, extension, and web app",
      "Listed as official Superteam Ireland project",
      "Entered Colosseum Frontier hackathon",
      "Heading to Dogpatch Dublin for IRL building",
    ],
  },
  {
    week: 2,
    title: "Post-Quantum STARK Migration",
    date: "April 13 - 19, 2026",
    status: "published",
    video: "/videos/week2.mp4",
    highlights: [
      "Migrated all 6 ZK circuits from Groth16 to hash-based STARKs",
      "Custom FRI verifier running natively on Solana — no trusted setup",
      "DEEP-ALI composition across every circuit, 124-bit soundness",
      "Merkle-Update AIR verifies on-chain at 1.32M compute units",
      "p01_liquidity program live — instant unshield pool on devnet",
      "Mobile WASM prover, extension, and SDK v2 all migrated — 138 tests green",
    ],
  },
  {
    week: 3,
    title: "Colosseum Submitted & v0.9.9 Shipped",
    date: "April 20 - 26, 2026",
    status: "published",
    video: "/videos/week3.mp4",
    highlights: [
      "Colosseum Frontier hackathon submitted — accelerator track, ~7% / ~$250K target",
      "Pitch deck + economic charter PDFs published on the marketing site",
      "Service Registry live on devnet — 4 services attested (Netflix, Spotify, YouTube, Disney+)",
      "useServiceRegistry hook + release APK demoed on Galaxy device",
      "v0.9.9 shipped — denominated_pool_v2 seed bump, 13 fresh pools",
      "Merkle proof rebuild from chain events — recovered notes work end-to-end",
      "abandonNote action + walletStore destructive init wipe fixed",
      "Web v0.9.9 marketing refresh + Hermes Buffer compat fix in specter-sdk",
    ],
  },
  {
    week: 4,
    title: "Five Days in Dublin & ZK End-to-End",
    date: "April 27 - May 3, 2026",
    status: "published",
    video: "/videos/week4.mp4",
    highlights: [
      "Five days in Dublin with Superteam Ireland — face-to-face with builders, founders, and investors",
      "Met Diarmuid (Superteam IE) and Alejandro Gutierrez (Lead Superteam IE / Blockchain Ireland)",
      "Pete Townsend's talk on Finding PMF in Web3 @ Buildstation — re-shaped the roadmap",
      "Merkle root divergence fixed via replayMerkleProofFromEvents — every shielded note recoverable",
      "Unshield lifecycle: 5 cascading bugs closed, per-pool counter via findSafeShieldCounter",
      "V3 STARK pools live on devnet — v0.9.11 tagged, foundation stable for enterprise SDKs",
      "Applied to CastleDAO Ireland (August 2026)",
    ],
  },
];

export default function UpdatesPage() {
  const [playingVideo, setPlayingVideo] = React.useState<number | null>(null);

  return (
    <>
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-p01-void/80 backdrop-blur-lg border-b border-p01-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-4">
              <Link href="/" className="flex items-center gap-2.5">
                <img src="/icon.png" alt="Protocol 01" className="w-7 h-7 rounded-md" />
                <span className="text-sm font-bold text-white tracking-wider hidden sm:inline">PROTOCOL 01</span>
              </Link>
            </div>
            <div className="hidden md:flex items-center gap-5">
              <Link href="/docs" className="text-xs text-p01-text-muted hover:text-white transition-colors font-mono uppercase tracking-wider">Docs</Link>
              <Link href="/roadmap" className="text-xs text-p01-text-muted hover:text-white transition-colors font-mono uppercase tracking-wider">Roadmap</Link>
              <Link href="/updates" className="text-xs text-p01-cyan hover:text-white transition-colors font-mono uppercase tracking-wider">Updates</Link>
              <Link href="/founder" className="text-xs text-p01-text-muted hover:text-white transition-colors font-mono uppercase tracking-wider">Founder</Link>
            </div>
            <div className="flex items-center gap-2">
              <LanguageSwitcher className="hidden sm:flex" />
              <Link href="/#download" className="btn-primary text-xs px-4 py-1.5">Download</Link>
            </div>
          </div>
        </div>
      </nav>

      <main className="min-h-screen pt-20 pb-16 px-4 bg-p01-void">
        <div className="max-w-5xl mx-auto">

          {/* Hero */}
          <motion.section
            className="text-center mb-16 pt-8"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <span className="text-[10px] font-mono text-p01-cyan tracking-[0.3em] uppercase">
              Building in public
            </span>
            <h1 className="text-4xl sm:text-5xl font-bold text-white mt-3 mb-4 font-display tracking-tight">
              Weekly Updates
            </h1>
            <p className="text-p01-text-muted text-base max-w-2xl mx-auto">
              Follow the development of Protocol 01 week by week. Every feature, every integration, every milestone — documented as we build.
            </p>
          </motion.section>

          {/* Updates Timeline */}
          <div className="space-y-8">
            {updates.map((update, i) => (
              <motion.div
                key={update.week}
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: i * 0.1 }}
              >
                <div
                  className={`rounded-2xl border overflow-hidden transition-all ${
                    update.status === "published"
                      ? "border-p01-cyan/20 bg-p01-surface"
                      : "border-p01-border bg-p01-surface/50"
                  }`}
                >
                  {/* Header */}
                  <div className="flex items-center justify-between px-6 py-4 border-b border-p01-border">
                    <div className="flex items-center gap-4">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center font-display font-bold text-sm ${
                          update.status === "published"
                            ? "bg-p01-cyan/15 text-p01-cyan"
                            : "bg-p01-text-dim/10 text-p01-text-dim"
                        }`}
                      >
                        W{update.week}
                      </div>
                      <div>
                        <h3 className="text-white font-semibold text-lg">{update.title}</h3>
                        <p className="text-p01-text-dim text-xs font-mono">{update.date}</p>
                      </div>
                    </div>
                    <div>
                      {update.status === "published" ? (
                        <span className="flex items-center gap-1.5 text-[11px] font-mono text-p01-cyan bg-p01-cyan/10 border border-p01-cyan/20 px-3 py-1 rounded-lg">
                          <CheckCircle className="w-3 h-3" />
                          Published
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-[11px] font-mono text-p01-text-dim bg-p01-text-dim/10 border border-p01-border px-3 py-1 rounded-lg">
                          <Clock className="w-3 h-3" />
                          Coming Soon
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Content */}
                  {update.status === "published" && (
                    <div className="p-6">
                      <div className="grid md:grid-cols-2 gap-6">
                        {/* Video */}
                        {update.video && (
                          <div className="relative rounded-xl overflow-hidden bg-p01-void border border-p01-border aspect-video">
                            {playingVideo === update.week ? (
                              <video
                                src={update.video}
                                controls
                                autoPlay
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <button
                                onClick={() => setPlayingVideo(update.week)}
                                className="w-full h-full flex items-center justify-center group cursor-pointer"
                              >
                                <video
                                  src={update.video}
                                  muted
                                  className="absolute inset-0 w-full h-full object-cover opacity-40"
                                />
                                <div className="relative z-10 w-16 h-16 rounded-full bg-p01-cyan/20 border-2 border-p01-cyan/50 flex items-center justify-center group-hover:bg-p01-cyan/30 group-hover:border-p01-cyan transition-all group-hover:scale-110">
                                  <Play className="w-6 h-6 text-p01-cyan ml-1" />
                                </div>
                              </button>
                            )}
                          </div>
                        )}

                        {/* Highlights */}
                        <div>
                          <h4 className="text-xs font-mono text-p01-cyan tracking-[0.2em] uppercase mb-4">
                            Highlights
                          </h4>
                          <ul className="space-y-3">
                            {update.highlights.map((h, j) => (
                              <li key={j} className="flex items-start gap-3 text-sm text-p01-text-muted">
                                <span className="w-1.5 h-1.5 rounded-full bg-p01-cyan mt-1.5 flex-shrink-0" />
                                {h}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Coming soon placeholder */}
                  {update.status === "coming-soon" && (
                    <div className="p-8 text-center">
                      <p className="text-p01-text-dim text-sm font-mono">
                        Stay tuned — update dropping soon.
                      </p>
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
          </div>

          {/* Bottom CTA */}
          <motion.div
            className="text-center mt-16"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
          >
            <p className="text-p01-text-dim text-xs font-mono mb-4">
              Follow development progress
            </p>
            <div className="flex items-center justify-center gap-3">
              <a
                href="https://x.com/Slashy_fx"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary text-xs px-6 py-2.5"
              >
                Follow on X
              </a>
              <Link
                href="/roadmap"
                className="px-6 py-2.5 border border-p01-border rounded-lg text-xs text-p01-text-muted hover:text-white hover:border-p01-cyan/40 transition-all"
              >
                View Roadmap
              </Link>
            </div>
          </motion.div>
        </div>
      </main>

      <Footer />
    </>
  );
}
