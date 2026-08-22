/**
 * Welcome: the first screen, and the only one a brand-new user sees.
 *
 * 🎯 WHAT CHANGED, AND WHY. This was three identical full-width blocks in
 * mono capitals — CREATE NEW WALLET, IMPORT SEED PHRASE, CONNECT WITH PHONE —
 * stacked at equal weight, so nothing on the screen said which one a new user
 * should press. Phantom's opening screen has one filled button and everything
 * else steps back. That is the change: create is primary, import is secondary,
 * and connecting a phone is a text link, because it is the path for someone who
 * already has a wallet somewhere else and knows it.
 *
 * The tagline stays. It is the one line of voice on the screen and it is the
 * site's own words.
 */

import { useNavigate } from 'react-router-dom';
import { Button } from '@/popup/ui';
import Wordmark from '../components/Wordmark';

// NOTE (Privy removal — Phase 2): the email/OTP login and the "Connect with P01
// Mobile" QR flow were REMOVED. Email/OTP relied on Privy embedded wallets, and
// the QR flow imported only an ADDRESS (watch-only) with no signer — it could
// never sign in the extension (see docs/privy-removal-spec.md R-16). The only
// onboarding paths are now create-wallet (local seed) and import-wallet (seed
// phrase). External-wallet / hardware connect is Phase 3/4.
export default function Welcome() {
  const navigate = useNavigate();

  return (
    <div className="flex h-full flex-col bg-p01-void">
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6">
        <Wordmark size={72} showText animated />
        <p className="text-sm text-p01-text-muted">Total invisibility</p>
      </div>

      <div className="flex shrink-0 flex-col gap-2.5 px-6 pb-6">
        <Button full size="lg" onClick={() => navigate('/create-wallet')}>
          Create a new wallet
        </Button>

        <Button full size="lg" variant="secondary" onClick={() => navigate('/import-wallet')}>
          Import a seed phrase
        </Button>

        {/* Pull the wallet from the Styx mobile app over a one-time encrypted
            channel. A third filled button made the screen a menu; this is the
            path you take only if you already know you want it. */}
        <Button full variant="ghost" onClick={() => navigate('/connect-phone')}>
          Connect with phone
        </Button>

        <p className="mt-1 text-center text-tiny text-p01-text-dim tabular">
          Styx v0.5.0 · Devnet
        </p>
      </div>
    </div>
  );
}
