import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Plus, Download, Smartphone } from 'lucide-react';
import GlitchLogo from '../components/GlitchLogo';

// NOTE (Privy removal — Phase 2): the email/OTP login and the "Connect with P01
// Mobile" QR flow were REMOVED. Email/OTP relied on Privy embedded wallets, and
// the QR flow imported only an ADDRESS (watch-only) with no signer — it could
// never sign in the extension (see docs/privy-removal-spec.md R-16). The only
// onboarding paths are now create-wallet (local seed) and import-wallet (seed
// phrase). External-wallet / hardware connect is Phase 3/4.
export default function Welcome() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col h-full bg-p01-void">
      <motion.div
        key="welcome"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="flex flex-col h-full"
      >
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
            className="w-full py-4 font-display font-bold text-sm tracking-wider flex items-center justify-center gap-2 transition-colors bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim"
          >
            <Plus className="w-4 h-4" />
            CREATE NEW WALLET
          </motion.button>

          {/* Import Wallet */}
          <motion.button
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.5 }}
            onClick={() => navigate('/import-wallet')}
            className="w-full py-4 bg-p01-surface text-p01-chrome font-display font-medium text-sm tracking-wider border border-p01-border flex items-center justify-center gap-2 hover:text-white hover:border-p01-cyan/30 transition-colors"
          >
            <Download className="w-4 h-4" />
            IMPORT SEED PHRASE
          </motion.button>

          {/* Connect with phone — pull the wallet from the P01 mobile app over a
              one-time encrypted channel (this laptop needs no camera). */}
          <motion.button
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.6 }}
            onClick={() => navigate('/connect-phone')}
            className="w-full py-4 bg-p01-surface text-p01-chrome font-display font-medium text-sm tracking-wider border border-p01-border flex items-center justify-center gap-2 hover:text-white hover:border-p01-cyan/30 transition-colors"
          >
            <Smartphone className="w-4 h-4" />
            CONNECT WITH PHONE
          </motion.button>

          {/* Version */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7 }}
            className="text-center text-[10px] text-[#555560] font-mono mt-4 tracking-wider"
          >
            PROTOCOL v0.5.0 • DEVNET
          </motion.p>
        </div>
      </motion.div>
    </div>
  );
}
