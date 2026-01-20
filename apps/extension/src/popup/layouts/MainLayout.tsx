import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Wallet, Repeat, Users, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';
import { cn } from '@/shared/utils';

const navItems = [
  { path: '/', icon: Wallet, label: 'Wallet' },
  { path: '/subscriptions', icon: Repeat, label: 'Streams' },
  { path: '/social', icon: Users, label: 'Social' },
  { path: '/agent', icon: Sparkles, label: 'Agent' },
];

export default function MainLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  // Hide nav on certain pages
  const hideNav = ['/send', '/receive', '/swap', '/settings'].some((p) =>
    location.pathname.startsWith(p)
  );

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
            const isActive = location.pathname === item.path;
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
