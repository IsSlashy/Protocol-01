import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Plus, Download } from 'lucide-react';
import GlitchLogo from '../components/GlitchLogo';

export default function Welcome() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Logo Section */}
      <div className="flex-1 flex flex-col items-center justify-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
        >
          <GlitchLogo size={140} showText={true} animated={true} />
        </motion.div>

        {/* Tagline */}
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.4 }}
          className="mt-6 text-[11px] text-[#555560] tracking-[3px] uppercase font-mono"
        >
          Total Invisibility
        </motion.p>
      </div>

      {/* Actions */}
      <div className="p-6 space-y-3">
        {/* Create Wallet - Primary */}
        <motion.button
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.4 }}
          onClick={() => navigate('/create-wallet')}
          className="w-full py-4 bg-p01-cyan text-p01-void font-display font-bold text-sm tracking-wider flex items-center justify-center gap-2 hover:bg-p01-cyan-dim transition-colors"
        >
          <Plus className="w-4 h-4" />
          CREATE WALLET
        </motion.button>

        {/* Import Wallet - Secondary */}
        <motion.button
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.5 }}
          onClick={() => navigate('/import-wallet')}
          className="w-full py-4 bg-p01-surface text-p01-chrome font-display font-medium text-sm tracking-wider border border-p01-border flex items-center justify-center gap-2 hover:text-white hover:border-p01-cyan/30 transition-colors"
        >
          <Download className="w-4 h-4" />
          IMPORT EXISTING
        </motion.button>

        {/* Version */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="text-center text-[10px] text-[#555560] font-mono mt-4 tracking-wider"
        >
          PROTOCOL v0.1.0 • DEVNET
        </motion.p>
      </div>
    </div>
  );
}
