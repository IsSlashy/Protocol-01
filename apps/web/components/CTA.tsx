"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
import { Github, Smartphone, Chrome } from "lucide-react";

const downloadOptions = [
  {
    platform: "Android",
    icon: Smartphone,
    description: "Coming Soon",
    available: false,
    link: "#",
  },
  {
    platform: "Chrome Extension",
    icon: Chrome,
    description: "Coming Soon",
    available: false,
    link: "#",
  },
];

export default function CTA() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  return (
    <section className="section relative overflow-hidden" ref={ref}>
      {/* Background Effects - Industrial grid, no soft blurs */}
      <div className="absolute inset-0">
        <div
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage: `
              linear-gradient(to right, rgba(57, 197, 187, 0.05) 1px, transparent 1px),
              linear-gradient(to bottom, rgba(57, 197, 187, 0.05) 1px, transparent 1px)
            `,
            backgroundSize: '40px 40px',
          }}
        />
      </div>

      <div className="relative z-10 max-w-5xl mx-auto">
        {/* Main CTA Card */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="card p-12 text-center relative overflow-hidden scanlines"
        >
          {/* Gradient border effect */}
          <div className="absolute inset-0 bg-gradient-to-r from-p01-cyan/20 via-p01-pink/20 to-p01-bright-cyan/20 opacity-50" />
          <div className="absolute inset-[1px] bg-p01-surface rounded-2xl" />

          <div className="relative z-10">
            {/* Badge - Industrial style, no rounded */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={isInView ? { opacity: 1, scale: 1 } : {}}
              transition={{ duration: 0.4, delay: 0.2 }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#151518] border border-[#39c5bb]/40 mb-8"
            >
              <span className="w-2 h-2 bg-[#39c5bb]" />
              <span className="text-[#39c5bb] text-sm font-medium font-mono uppercase tracking-wider">
                Now Available
              </span>
            </motion.div>

            {/* Heading - No soft glow */}
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="text-4xl sm:text-5xl lg:text-6xl font-bold font-display mb-6 tracking-tight"
            >
              Ready to become{" "}
              <span className="text-[#39c5bb]">invisible</span>?
            </motion.h2>

            {/* Subtitle */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.4 }}
              className="text-lg text-p01-text-muted max-w-2xl mx-auto mb-12 space-y-1"
            >
              <p>Download Protocol 01 and take back control of your financial privacy.</p>
              <p>Free to use. Self-custody. Built for everyone.</p>
            </motion.div>

            {/* Download Buttons */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto mb-12"
            >
              {downloadOptions.map((option) => (
                <div
                  key={option.platform}
                  className={`group flex items-center gap-4 p-4 rounded-xl bg-p01-void border border-p01-border transition-all duration-300 ${
                    option.available
                      ? "hover:border-p01-cyan/50 cursor-pointer"
                      : "opacity-50 cursor-not-allowed"
                  }`}
                  onClick={() => option.available && option.link !== "#" && window.open(option.link)}
                >
                  <div className="w-12 h-12 rounded-xl bg-p01-surface flex items-center justify-center text-p01-text-muted group-hover:text-p01-cyan transition-colors">
                    <option.icon size={24} />
                  </div>
                  <div className="text-left">
                    <div className="font-semibold text-white group-hover:text-p01-cyan transition-colors font-display">
                      {option.platform}
                    </div>
                    <div className="text-sm text-p01-text-dim">
                      {option.description}
                    </div>
                  </div>
                </div>
              ))}
            </motion.div>

            {/* Secondary Actions */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={isInView ? { opacity: 1 } : {}}
              transition={{ duration: 0.5, delay: 0.6 }}
              className="flex flex-col sm:flex-row items-center justify-center gap-4"
            >
              <a
                href="https://github.com/IsSlashy/Protocol-01"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-p01-text-muted hover:text-white transition-colors"
              >
                <Github size={20} />
                <span>View on GitHub</span>
              </a>
              <span className="hidden sm:block text-p01-border">|</span>
              <a
                href="https://discord.gg/KfmhPFAHNH"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-p01-text-muted hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                </svg>
                <span>Join Discord</span>
              </a>
            </motion.div>
          </div>
        </motion.div>

        {/* Stats */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5, delay: 0.7 }}
          className="mt-16 grid grid-cols-3 gap-8"
        >
          {[
            { value: "100%", label: "Self-Custody" },
            { value: "0", label: "KYC Required" },
            { value: "∞", label: "Privacy" },
          ].map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-3xl sm:text-4xl font-bold font-display text-white mb-2">
                {stat.value}
              </div>
              <div className="text-sm text-p01-text-muted">{stat.label}</div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
