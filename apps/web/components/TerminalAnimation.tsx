"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const terminalLines = [
  { type: "command", text: "$ p01 init --stealth" },
  { type: "output", text: "Initializing Protocol 01..." },
  { type: "success", text: "[OK] Zero-knowledge circuits loaded" },
  { type: "success", text: "[OK] Stealth address generated" },
  { type: "success", text: "[OK] Private relay connected" },
  { type: "command", text: "$ p01 wallet create --anonymous" },
  { type: "output", text: "Creating anonymous wallet..." },
  { type: "success", text: "[OK] Wallet created: 0x7f3a...8c2e" },
  { type: "command", text: "$ p01 send --private 100 USDC" },
  { type: "output", text: "Generating ZK proof..." },
  { type: "success", text: "[OK] Transaction sent (untraceable)" },
  { type: "info", text: ">> The system cannot see you." },
];

interface TerminalAnimationProps {
  className?: string;
}

export default function TerminalAnimation({ className = "" }: TerminalAnimationProps) {
  const [visibleLines, setVisibleLines] = useState<number>(0);
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    if (visibleLines < terminalLines.length) {
      const timeout = setTimeout(() => {
        setVisibleLines((prev) => prev + 1);
      }, 600);
      return () => clearTimeout(timeout);
    } else {
      // Reset animation after completion
      const resetTimeout = setTimeout(() => {
        setVisibleLines(0);
      }, 3000);
      return () => clearTimeout(resetTimeout);
    }
  }, [visibleLines]);

  useEffect(() => {
    const cursorInterval = setInterval(() => {
      setCursorVisible((prev) => !prev);
    }, 530);
    return () => clearInterval(cursorInterval);
  }, []);

  const getLineColor = (type: string) => {
    switch (type) {
      case "command":
        return "text-p01-cyan";
      case "success":
        return "text-p01-cyan/80";
      case "error":
        return "text-p01-red";
      case "info":
        return "text-p01-pink text-glow-pink font-semibold";
      case "warning":
        return "text-p01-yellow";
      default:
        return "text-p01-text-muted";
    }
  };

  return (
    <div className={`terminal max-w-2xl mx-auto scanlines ${className}`}>
      {/* Terminal Header */}
      <div className="terminal-header">
        <div className="terminal-dot bg-p01-red" />
        <div className="terminal-dot bg-p01-yellow" />
        <div className="terminal-dot bg-p01-cyan" />
        <span className="ml-4 text-p01-text-muted text-xs font-mono">p01-cli</span>
      </div>

      {/* Terminal Content */}
      <div className="terminal-content min-h-[300px] bg-p01-void/80">
        <AnimatePresence>
          {terminalLines.slice(0, visibleLines).map((line, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3 }}
              className={`mb-1 font-mono text-sm ${getLineColor(line.type)}`}
            >
              {line.text}
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Cursor */}
        <span
          className={`inline-block w-2 h-4 bg-p01-cyan ml-1 ${
            cursorVisible ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>
    </div>
  );
}
