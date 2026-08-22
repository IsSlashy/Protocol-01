import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Compass, RefreshCw, Shield, Wallet } from 'lucide-react';
import { motion } from 'framer-motion';
import { cn } from '@/shared/utils';

/**
 * 🎯 FOUR TABS, AND "AGENT" IS GONE. Founder ruling 2026-08-23: nobody was
 * going to use an on-device chat box, and a tab is the most expensive real
 * estate in a 360px popup. Discover replaces it, because the question a wallet
 * tab has to answer is "why open this when I am not already sending money".
 *
 * Wallet   what you hold
 * Discover what you can pay for privately  (reads the on-chain registry)
 * Subs     what you already pay for
 * Shield   the private balance, and the four things you can do with it
 *
 * ⚠️ Icon AND label on every tab. An icon-only tab bar in a wallet is a guess
 * about someone's money, and `Repeat` for subscriptions was already ambiguous
 * enough to need one.
 */
const navItems = [
  { path: '/', icon: Wallet, label: 'Wallet' },
  { path: '/discover', icon: Compass, label: 'Discover' },
  { path: '/subscriptions', icon: RefreshCw, label: 'Subs' },
  { path: '/shield', icon: Shield, label: 'Shield' },
];

/**
 * 🚨 EVERY MONEY FLOW HIDES THE TABS, AND MOST OF THEM DID NOT.
 *
 * This list held four prefixes. `/denominated-shield`, `/denominated-unshield`,
 * `/denominated-transfer` and `/subscriptions/new` all kept the tab bar live,
 * so one stray tap during a three-minute proof abandoned a half-filled deposit
 * with no warning and no way back to where it was.
 *
 * Matched on prefix, so `/shield/withdraw` hides while `/shield` does not.
 */
const FLOW_PREFIXES = [
  '/send',
  '/receive',
  '/settings',
  '/shield/',
  '/subscriptions/',
];

export default function MainLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  // Hide nav on certain pages
  const hideNav = FLOW_PREFIXES.some((p) => location.pathname.startsWith(p));

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Content - No header, pages have their own */}
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>

      {/* Bottom Navigation - 4 tabs like mobile */}
      {!hideNav && (
        <nav className="flex items-center justify-around border-t border-p01-border bg-p01-void">
          {navItems.map((item) => {
            const isActive =
              item.path === '/'
                ? location.pathname === '/'
                : location.pathname === item.path ||
                  location.pathname.startsWith(`${item.path}/`);
            const Icon = item.icon;

            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={cn(
                  'flex-1 flex flex-col items-center gap-1 py-3 transition-colors relative',
                  isActive
                    ? 'text-p01-cyan'
                    : 'text-p01-chrome/50 hover:text-p01-chrome'
                )}
              >
                {isActive && (
                  <motion.div
                    layoutId="nav-indicator"
                    className="absolute top-0 left-0 right-0 h-0.5 bg-p01-cyan"
                    transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
                  />
                )}
                <Icon className="w-5 h-5" />
                <span className="text-[10px] font-medium tracking-wide">
                  {item.label}
                </span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
