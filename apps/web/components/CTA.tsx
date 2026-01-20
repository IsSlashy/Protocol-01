"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
import { Github, Chrome, Smartphone, Apple } from "lucide-react";

const downloadOptions = [
  {
    platform: "Chrome Extension",
    icon: Chrome,
    description: "Coming Soon",
    available: false,
    link: "#",
  },
  {
    platform: "Android APK",
    icon: Smartphone,
    description: "Coming Soon",
    available: false,
    link: "#",
  },
  {
    platform: "iOS (TestFlight)",
    icon: Apple,
    description: "Coming Soon",
    available: false,
    link: "#",
  },
];

const communityLinks = [
  {
    name: "GitHub",
    icon: Github,
    link: "https://github.com/IsSlashy/Protocol-01",
    available: true,
  },
  {
    name: "Discord",
    icon: () => (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
        <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9460 2.4189-2.1568 2.4189z"/>
      </svg>
    ),
    link: "#",
    available: false,
  },
  {
    name: "X / Twitter",
    icon: () => (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
      </svg>
    ),
    link: "#",
    available: false,
  },
];

export default function CTA() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  return (
    <section className="section relative overflow-hidden" ref={ref}>
      {/* Background Effects - Industrial grid with cyan/pink accents */}
      <div className="absolute inset-0 bg-[#0a0a0c]">
        <div
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage: `
              linear-gradient(to right, rgba(57, 197, 187, 0.08) 1px, transparent 1px),
              linear-gradient(to bottom, rgba(57, 197, 187, 0.08) 1px, transparent 1px)
            `,
            backgroundSize: '40px 40px',
          }}
        />
        {/* Gradient accents */}
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-[#39c5bb]/5 blur-[100px]" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-[#ff6b9d]/5 blur-[100px]" />
      </div>

      <div className="relative z-10 max-w-5xl mx-auto">
        {/* Main CTA Card */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="card p-8 sm:p-12 text-center relative overflow-hidden"
        >
          {/* Gradient border effect - cyan to pink */}
          <div className="absolute inset-0 bg-gradient-to-r from-[#39c5bb]/30 via-[#ff6b9d]/20 to-[#39c5bb]/30 opacity-50" />
          <div className="absolute inset-[1px] bg-[#0d0d10] rounded-2xl" />

          <div className="relative z-10">
            {/* Badge - Industrial style */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={isInView ? { opacity: 1, scale: 1 } : {}}
              transition={{ duration: 0.4, delay: 0.2 }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#151518] border border-[#39c5bb]/40 mb-8"
            >
              <span className="w-2 h-2 bg-[#39c5bb] animate-pulse" />
              <span className="text-[#39c5bb] text-sm font-medium font-mono uppercase tracking-wider">
                Protocol 01
              </span>
            </motion.div>

            {/* Heading */}
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
              className="text-lg text-[#8a8a9a] max-w-2xl mx-auto mb-10"
            >
              Download Protocol 01 and take back control of your financial privacy.
              Open source, built for everyone.
            </motion.p>

            {/* View on GitHub Button */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.45 }}
              className="mb-12"
            >
              <a
                href="https://github.com/IsSlashy/Protocol-01"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-3 px-8 py-4 bg-gradient-to-r from-[#39c5bb] to-[#2da8a0] text-[#0a0a0c] font-bold font-display text-lg rounded-lg hover:from-[#4dd4ca] hover:to-[#39c5bb] transition-all duration-300 shadow-lg shadow-[#39c5bb]/20"
              >
                <Github size={24} />
                <span>View on GitHub</span>
              </a>
            </motion.div>

            {/* Download Options Section */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="mb-12"
            >
              <h3 className="text-sm font-mono uppercase tracking-wider text-[#ff6b9d] mb-6">
                Download Options
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {downloadOptions.map((option) => (
                  <div
                    key={option.platform}
                    className={`group flex items-center gap-4 p-4 rounded-lg bg-[#151518] border transition-all duration-300 ${
                      option.available
                        ? "border-[#39c5bb]/30 hover:border-[#39c5bb]/60 cursor-pointer"
                        : "border-[#2a2a35] opacity-70 cursor-not-allowed"
                    }`}
                  >
                    <div className={`w-12 h-12 rounded-lg flex items-center justify-center transition-colors ${
                      option.available
                        ? "bg-[#1a1a1f] text-[#39c5bb] group-hover:bg-[#39c5bb]/10"
                        : "bg-[#1a1a1f] text-[#5a5a6a]"
                    }`}>
                      <option.icon size={24} />
                    </div>
                    <div className="text-left">
                      <div className={`font-semibold font-display transition-colors ${
                        option.available
                          ? "text-white group-hover:text-[#39c5bb]"
                          : "text-[#6a6a7a]"
                      }`}>
                        {option.platform}
                      </div>
                      <div className={`text-sm ${
                        option.available ? "text-[#8a8a9a]" : "text-[#ff6b9d]"
                      }`}>
                        {option.description}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>

            {/* Community Links Section */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={isInView ? { opacity: 1 } : {}}
              transition={{ duration: 0.5, delay: 0.6 }}
            >
              <h3 className="text-sm font-mono uppercase tracking-wider text-[#39c5bb] mb-6">
                Join the Community
              </h3>
              <div className="flex flex-wrap items-center justify-center gap-6">
                {communityLinks.map((link) => (
                  <a
                    key={link.name}
                    href={link.link}
                    target={link.available ? "_blank" : undefined}
                    rel={link.available ? "noopener noreferrer" : undefined}
                    className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg border transition-all duration-300 ${
                      link.available
                        ? "border-[#39c5bb]/40 text-[#39c5bb] hover:bg-[#39c5bb]/10 hover:border-[#39c5bb]"
                        : "border-[#2a2a35] text-[#5a5a6a] cursor-not-allowed"
                    }`}
                  >
                    {typeof link.icon === 'function' ? <link.icon /> : <link.icon size={20} />}
                    <span className="font-medium">{link.name}</span>
                    {!link.available && (
                      <span className="text-xs text-[#ff6b9d] ml-1">(soon)</span>
                    )}
                  </a>
                ))}
              </div>
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
            { value: "Open", label: "Source Code" },
            { value: "100%", label: "Privacy First" },
            { value: "Solana", label: "Blockchain" },
            { value: "0", label: "Data Collected" },
          ].map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-3xl sm:text-4xl font-bold font-display text-[#39c5bb] mb-2">
                {stat.value}
              </div>
              <div className="text-sm text-[#8a8a9a]">{stat.label}</div>
            </div>
          ))}
        </motion.div>

        {/* Footer note */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : {}}
          transition={{ duration: 0.5, delay: 0.8 }}
          className="text-center text-[#5a5a6a] text-sm mt-12 font-mono"
        >
          Protocol 01 - Privacy is not a crime, it&apos;s a right.
        </motion.p>
      </div>
    </section>
  );
}
