import { Outlet } from 'react-router-dom';
import { motion } from 'framer-motion';
import GlitchLogo from '../components/GlitchLogo';

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
          <GlitchLogo size={120} showText={true} animated={true} />

          {/* Terminal-style status indicator */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.4 }}
            className="mt-6 flex flex-col items-center"
          >
            <span className="text-[#ff2d7a] text-[10px] font-bold tracking-[6px] font-mono mb-1">
              [ SYSTEM STATUS ]
            </span>
            <span className="text-white text-lg font-black tracking-wider">
              UNTRACEABLE
            </span>
            <div className="flex items-center mt-2">
              <div className="w-2 h-2 bg-[#39c5bb] mr-2" />
              <span className="text-[#555560] text-[10px] tracking-[4px] font-mono">
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
        <p className="text-[10px] text-[#555560] tracking-[2px] font-mono uppercase">
          Solana Network
        </p>
      </footer>
    </div>
  );
}
