"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
import { Download, Github, Apple, Monitor, Chrome } from "lucide-react";

const downloadOptions = [
  {
    platform: "macOS",
    icon: Apple,
    description: "Apple Silicon & Intel",
    available: true,
    link: "#",
  },
  {
    platform: "Windows",
    icon: Monitor,
    description: "Windows 10/11",
    available: true,
    link: "#",
  },
  {
    platform: "Browser Extension",
    icon: Chrome,
    description: "Chrome, Firefox, Brave",
    available: true,
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
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.4 }}
              className="text-lg text-p01-text-muted max-w-2xl mx-auto mb-12"
            >
              Download Protocol 01 and take back control of your financial privacy.
              Free to use, open source, and built for everyone.
            </motion.p>

            {/* Download Buttons */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12"
            >
              {downloadOptions.map((option) => (
                <a
                  key={option.platform}
                  href={option.link}
                  className="group flex items-center gap-4 p-4 rounded-xl bg-p01-void border border-p01-border hover:border-p01-cyan/50 transition-all duration-300"
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
                </a>
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
                href="#"
                className="inline-flex items-center gap-2 text-p01-text-muted hover:text-white transition-colors"
              >
                <Github size={20} />
                <span>View on GitHub</span>
              </a>
              <span className="hidden sm:block text-p01-border">|</span>
              <a
                href="#"
                className="inline-flex items-center gap-2 text-p01-text-muted hover:text-white transition-colors"
              >
                <Download size={20} />
                <span>Download CLI</span>
              </a>
            </motion.div>
          </div>
        </motion.div>

        {/* Stats */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5, delay: 0.7 }}
          className="mt-16 grid grid-cols-2 sm:grid-cols-4 gap-8"
        >
          {[
            { value: "10K+", label: "Active Users" },
            { value: "$50M+", label: "Volume Protected" },
            { value: "100%", label: "Open Source" },
            { value: "0", label: "Privacy Breaches" },
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
