import { ImageResponse } from "next/og";

/**
 * The card every shared link shows, generated at build time.
 *
 * This replaces /01-miku.png. Until now, pasting a link to this site into X,
 * LinkedIn or Slack produced a 512 by 512 crop of fan-art from another
 * franchise, next to the title "PROTOCOL-01" and a description promising
 * "anonymous interactions", which the protocol does not deliver. All three are
 * gone.
 *
 * Deliberately typographic and geometric rather than illustrated: `next/og` only
 * ships a default sans, so leaning on a display serif here would silently fall
 * back and look accidental. Wide tracking, hairlines and one cyan seal read as
 * chosen at any size, and the card states the two things a stranger should know
 * before clicking.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Styx Protocol: private payments on Solana, running on devnet, not audited";

export default function OpengraphImage() {
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
        }}
      >
        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 20 }}>
          <div style={{ fontSize: 44, fontWeight: 500, letterSpacing: "-0.01em" }}>
            Styx
          </div>
          <div
            style={{
              fontSize: 16,
              letterSpacing: "0.28em",
              color: "rgba(234,231,223,0.4)",
            }}
          >
            PROTOCOL
          </div>
        </div>

        {/* Statement */}
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
            PRIVATE PAYMENTS ON SOLANA
          </div>
          <div
            style={{
              marginTop: 26,
              fontSize: 76,
              lineHeight: 1.08,
              letterSpacing: "-0.03em",
              maxWidth: 900,
            }}
          >
            Built to be checked, not believed.
          </div>
        </div>

        {/* The two facts a reader should have before clicking */}
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ width: "100%", height: 1, background: "rgba(234,231,223,0.14)" }} />
          <div style={{ display: "flex", gap: 14, fontSize: 18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 18px",
                border: "1px solid rgba(234,231,223,0.14)",
                borderRadius: 999,
                letterSpacing: "0.14em",
                color: "rgba(234,231,223,0.62)",
              }}
            >
              <div style={{ width: 7, height: 7, borderRadius: 999, background: "#39c5bb" }} />
              LIVE ON DEVNET
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "8px 18px",
                border: "1px solid rgba(234,231,223,0.14)",
                borderRadius: 999,
                letterSpacing: "0.14em",
                color: "rgba(234,231,223,0.62)",
              }}
            >
              NOT AUDITED
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "8px 18px",
                border: "1px solid rgba(234,231,223,0.14)",
                borderRadius: 999,
                letterSpacing: "0.14em",
                color: "rgba(234,231,223,0.62)",
              }}
            >
              HASH-BASED STARK
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
