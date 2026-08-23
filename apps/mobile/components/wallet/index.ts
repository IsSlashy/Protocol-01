/**
 * The wallet kit.
 *
 * ⛔ SIX COMPONENTS WERE DELETED HERE ON 2026-08-23, not restyled:
 * `BalanceCard`, `AssetRow`, `ActivityItem`, `SendForm`, `ReceiveQR` and
 * `PrivacySelector`. None of them was rendered by any screen — the only thing
 * that referenced them was this barrel and `components/index.ts`, which is why
 * they had drifted so far: `ReceiveQR` announced "Aztec Network" and loaded a
 * retired `p01-logo.png`, `PrivacySelector` quoted fees "in AZTEC", and all six
 * were still written in Tailwind classes (`text-white`, `bg-red-500`) that no
 * theme sweep can reach. Rewriting dead screens onto the new palette would have
 * been six files of work that nobody would ever see.
 *
 * What is left is what the wallet home screen actually renders. Each of those
 * is a default export imported by path, the way `index.tsx` already imports
 * them, so nothing here re-exports them a second time under another name.
 */

export { default as WalletHeader } from './WalletHeader';
export { default as AssetsList } from './AssetsList';
export { default as RecentActivity } from './RecentActivity';
export { default as PrivacySummaryPill } from './PrivacySummaryPill';
export { default as SubscriptionsStrip } from './SubscriptionsStrip';
export { default as DevnetAirdropFAB } from './DevnetAirdropFAB';
