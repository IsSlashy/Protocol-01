import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { plainText, parsePaper } from "@/lib/whitepaper/markdown";
import { loadWhitepaperSource } from "@/lib/whitepaper/source";

/**
 * The card a /whitepaper link unfurls as on X (and anywhere reading Open
 * Graph). Same ground, palette and type as the site card in
 * app/opengraph-image.tsx, so the two read as one family; the statement is the
 * paper's own title, read from docs/WHITEPAPER.md at build time, so the card
 * cannot drift from the paper. The chips repeat the two facts the paper opens
 * with: devnet only, and no external audit yet.
 */
export const cardSize = { width: 1200, height: 630 };
export const cardAlt =
  "Styx white paper: private 1 SOL payments on Solana, checked on chain by a hash-based proof. Devnet only, no external audit yet.";

function paperStatement(): string {
  const title = plainText(parsePaper(loadWhitepaperSource()).title);
  // "Styx: private 1 SOL payments ..." -> "Private 1 SOL payments ..."
  const rest = title.replace(/^Styx\s*[:—-]\s*/i, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

const chip = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 18px",
  border: "1px solid rgba(234,231,223,0.14)",
  borderRadius: 999,
  letterSpacing: "0.14em",
  color: "rgba(234,231,223,0.62)",
} as const;

export async function renderWhitepaperCard(): Promise<ImageResponse> {
  const river = await readFile(join(process.cwd(), "public", "styx", "share.jpg"));
  const riverUrl = `data:image/jpeg;base64,${river.toString("base64")}`;
  const statement = paperStatement();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#070709",
          color: "#eae7df",
          padding: "72px 80px",
          position: "relative",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={riverUrl}
          alt=""
          width={1200}
          height={675}
          style={{
            position: "absolute",
            left: 0,
            top: -22,
            width: 1200,
            height: 675,
            opacity: 0.45,
            objectFit: "cover",
          }}
        />
        <div style={{ display: "flex", alignItems: "baseline", gap: 20 }}>
          <div style={{ fontSize: 44, fontWeight: 500, letterSpacing: "-0.01em" }}>Styx</div>
          <div style={{ fontSize: 16, letterSpacing: "0.28em", color: "rgba(234,231,223,0.4)" }}>
            PROTOCOL
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 18,
              fontSize: 17,
              letterSpacing: "0.2em",
              color: "rgba(234,231,223,0.4)",
            }}
          >
            <div style={{ width: 34, height: 1, background: "#39c5bb" }} />
            WHITE PAPER
          </div>
          <div
            style={{
              marginTop: 26,
              fontSize: statement.length > 70 ? 54 : 64,
              lineHeight: 1.1,
              letterSpacing: "-0.025em",
              maxWidth: 1000,
            }}
          >
            {statement}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ width: "100%", height: 1, background: "rgba(234,231,223,0.14)" }} />
          <div style={{ display: "flex", gap: 14, fontSize: 18 }}>
            <div style={chip}>
              <div style={{ width: 7, height: 7, borderRadius: 999, background: "#39c5bb" }} />
              DEVNET ONLY
            </div>
            <div style={chip}>NO EXTERNAL AUDIT YET</div>
            <div style={chip}>STYX.CASH/WHITEPAPER</div>
          </div>
        </div>
      </div>
    ),
    cardSize,
  );
}
