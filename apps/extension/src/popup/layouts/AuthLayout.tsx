import { Outlet } from 'react-router-dom';
import { motion } from 'framer-motion';
import Wordmark from '../components/Wordmark';

export default function AuthLayout() {
  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Logo Header - ULTRAKILL Style */}
      <header className="flex flex-col items-center justify-center py-6">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
          className="flex flex-col items-center"
        >
          {/* Glitching Logo */}
          <Wordmark size={120} showText={true} animated={true} />

          {/* Terminal-style status indicator */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.4 }}
            className="mt-6 flex flex-col items-center"
          >
            <span className="text-p01-cyan-dim text-[10px] font-bold tracking-[6px] font-mono mb-1">
              [ SYSTEM STATUS ]
            </span>
            <span className="text-p01-text text-lg font-black tracking-wider">
              SHIELDED
            </span>
            <div className="flex items-center mt-2">
              <div className="w-2 h-2 bg-p01-cyan mr-2" />
              <span className="text-p01-text-dim text-[10px] tracking-[4px] font-mono">
                READY
              </span>
            </div>
          </motion.div>
        </motion.div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto px-4">
        <Outlet />
      </main>

      {/* Footer - Raw industrial style */}
      <footer className="py-3 text-center border-t border-p01-border">
        <p className="text-[10px] text-p01-text-dim tracking-[2px] font-mono uppercase">
          Solana Network
        </p>
      </footer>
    </div>
  );
}
