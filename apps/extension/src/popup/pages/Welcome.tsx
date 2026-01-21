import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Plus, Download, Mail, Wallet, ChevronDown, ChevronUp } from 'lucide-react';
import GlitchLogo from '../components/GlitchLogo';
import { useAuthAdapter } from '../../shared/store/authAdapter';

// Check if Privy is available (has valid app ID)
const PRIVY_ENABLED = Boolean(import.meta.env.VITE_PRIVY_APP_ID);

export default function Welcome() {
  const navigate = useNavigate();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { login, isLoading, isAuthenticated } = useAuthAdapter();

  // Handle Privy login
  const handlePrivyLogin = async () => {
    try {
      await login();
      // Navigation will happen via auth state change in App.tsx
    } catch (error) {
      console.error('[Welcome] Privy login error:', error);
    }
  };

  // If already authenticated, this shouldn't render (App.tsx handles redirect)
  if (isAuthenticated) {
    return null;
  }

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
        {/* Quick Login with Privy (if enabled) */}
        {PRIVY_ENABLED && (
          <>
            <motion.button
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.4 }}
              onClick={handlePrivyLogin}
              disabled={isLoading}
              className="w-full py-4 bg-p01-cyan text-p01-void font-display font-bold text-sm tracking-wider flex items-center justify-center gap-2 hover:bg-p01-cyan-dim transition-colors disabled:opacity-50"
            >
              <Mail className="w-4 h-4" />
              {isLoading ? 'CONNECTING...' : 'CONTINUE WITH EMAIL'}
            </motion.button>

            <motion.button
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.45 }}
              onClick={handlePrivyLogin}
              disabled={isLoading}
              className="w-full py-4 bg-p01-surface text-p01-chrome font-display font-medium text-sm tracking-wider border border-p01-border flex items-center justify-center gap-2 hover:text-white hover:border-p01-cyan/30 transition-colors disabled:opacity-50"
            >
              <Wallet className="w-4 h-4" />
              CONNECT WALLET
            </motion.button>

            {/* Divider */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              className="flex items-center gap-3 py-2"
            >
              <div className="flex-1 h-px bg-p01-border" />
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-[10px] text-[#555560] font-mono tracking-wider flex items-center gap-1 hover:text-p01-chrome transition-colors"
              >
                ADVANCED
                {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
              <div className="flex-1 h-px bg-p01-border" />
            </motion.div>
          </>
        )}

        {/* Legacy Options - Always visible if Privy disabled, expandable if enabled */}
        {(!PRIVY_ENABLED || showAdvanced) && (
          <>
            {/* Create Wallet - Primary (or secondary if Privy enabled) */}
            <motion.button
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: PRIVY_ENABLED ? 0.55 : 0.4 }}
              onClick={() => navigate('/create-wallet')}
              className={`w-full py-4 font-display font-bold text-sm tracking-wider flex items-center justify-center gap-2 transition-colors ${
                PRIVY_ENABLED
                  ? 'bg-p01-surface text-p01-chrome border border-p01-border hover:text-white hover:border-p01-cyan/30'
                  : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim'
              }`}
            >
              <Plus className="w-4 h-4" />
              CREATE NEW WALLET
            </motion.button>

            {/* Import Wallet */}
            <motion.button
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: PRIVY_ENABLED ? 0.6 : 0.5 }}
              onClick={() => navigate('/import-wallet')}
              className="w-full py-4 bg-p01-surface text-p01-chrome font-display font-medium text-sm tracking-wider border border-p01-border flex items-center justify-center gap-2 hover:text-white hover:border-p01-cyan/30 transition-colors"
            >
              <Download className="w-4 h-4" />
              IMPORT SEED PHRASE
            </motion.button>
          </>
        )}

        {/* Version */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.7 }}
          className="text-center text-[10px] text-[#555560] font-mono mt-4 tracking-wider"
        >
          PROTOCOL v0.1.0 • DEVNET
        </motion.p>
      </div>
    </div>
  );
}
