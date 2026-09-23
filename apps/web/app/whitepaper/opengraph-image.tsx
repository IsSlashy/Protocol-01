import { renderWhitepaperCard } from "./_og/card";

/* Open Graph card for /whitepaper. The design lives in ./_og/card.tsx, shared
   with twitter-image.tsx. These three exports are literals because Next reads
   them from each metadata-image file itself. */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt =
  "Styx white paper: private 1 SOL payments on Solana, checked on chain by a hash-based proof. Devnet only, no external audit yet.";

export default function Image() {
  return renderWhitepaperCard();
}
