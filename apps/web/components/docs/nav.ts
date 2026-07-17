// Docs navigation registry.
//
// Pure data — no JSX/component imports — so it can be shared by the sidebar,
// the Ctrl+K search, and the prev/next pager without circular deps. Each id is
// a topic anchor: it resolves either to a `technologies` entry (rendered as a
// TechTopic) or to a special topic (architecture / security / mpc-comparison)
// in app/docs/page.tsx.

export type NavGroupDef = { labelKey: string; ids: string[] };

export const NAV_GROUPS: NavGroupDef[] = [
  {
    labelKey: "docs.navGettingStarted",
    ids: ["architecture", "client-sdk"],
  },
  {
    labelKey: "docs.navPrivacy",
    ids: [
      "stealth-addresses",
      "zk-proofs",
      "shielded-pool",
      "poseidon-hash",
      "merkle-tree",
      "nullifiers",
    ],
  },
  {
    labelKey: "docs.navPools",
    ids: ["denominated-pools", "zkspl", "note-splitting"],
  },
  {
    labelKey: "docs.navPayments",
    ids: ["streams-privacy", "subscription-vaults"],
  },
  {
    labelKey: "docs.navNetwork",
    ids: [
      "solana-integration",
      "private-relay",
      "privacy-router",
    ],
  },
  {
    labelKey: "docs.navWallet",
    ids: [
      "auto-shield",
      "stealth-meta-addresses",
      "ai-agent",
      "quantum-wallet",
      "p2p-sharing",
    ],
  },
  {
    labelKey: "docs.navSecurityRef",
    ids: ["security", "migration-history"],
  },
];

// Flat, ordered list of every topic id — drives prev/next paging.
export const TOPIC_ORDER: string[] = NAV_GROUPS.flatMap((g) => g.ids);

// Special (non-`technologies`) topics + the i18n key for their sidebar label.
export const SPECIAL_TITLE_KEYS: Record<string, string> = {
  architecture: "docs.archSectionTitle",
  security: "docs.securityTitle",
};
