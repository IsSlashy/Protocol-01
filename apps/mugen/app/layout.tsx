import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import WalletProvider from '@/components/WalletProvider';
import P01ConnectModal from '@/components/P01ConnectModal';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains' });

export const metadata: Metadata = {
  title: 'Mugen Exchange | 無限 — No KYC, ZK-Powered P2P Exchange',
  description:
    'Fiat-to-crypto exchange with zero-knowledge compliance. No KYC required. Untraceable stealth settlement. Quantum-proof infrastructure.',
  keywords: ['exchange', 'no kyc', 'zk', 'privacy', 'solana', 'p2p', 'fiat', 'crypto'],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <head>
        <link rel="icon" href="/mugen-icon.png" />
        <link rel="apple-touch-icon" href="/mugen-icon.png" />
        <link
          href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body
        style={{
          margin: 0,
          padding: 0,
          background: '#050510',
          color: '#f0f0ff',
          fontFamily: "'Inter', sans-serif",
          WebkitFontSmoothing: 'antialiased',
          overflowX: 'hidden',
          minHeight: '100vh',
          width: '100%',
        }}
      >
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: -1,
            background: `
              radial-gradient(ellipse 80% 50% at 30% 20%, rgba(59, 130, 246, 0.07) 0%, transparent 50%),
              radial-gradient(ellipse 60% 40% at 70% 80%, rgba(139, 92, 246, 0.05) 0%, transparent 50%),
              radial-gradient(ellipse 100% 100% at 50% 50%, rgba(96, 165, 250, 0.02) 0%, transparent 70%),
              #050510
            `,
          }}
        />
        <WalletProvider>
          <P01ConnectModal />
          {children}
        </WalletProvider>
      </body>
    </html>
  );
}
