import { ImageResponse } from "next/og";

/**
 * The favicon, generated rather than shipped as a file.
 *
 * It replaces /01-miku.png, which was serving as the favicon AND the Apple icon
 * AND the OpenGraph image, so every browser tab and every shared link carried
 * fan-art of a character from another franchise. Generating the mark keeps the
 * repository free of that asset and keeps the mark in the Styx palette.
 *
 * A letterform is the only thing that survives 16 pixels, so this is one S on
 * the near-black ground with the cyan seal underlining it.
 */
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#070709",
          color: "#eae7df",
        }}
      >
        <div
          style={{
            fontSize: 24,
            fontWeight: 500,
            lineHeight: 1,
            letterSpacing: "-0.02em",
          }}
        >
          S
        </div>
        <div
          style={{
            width: 16,
            height: 2,
            marginTop: 2,
            background: "#39c5bb",
          }}
        />
      </div>
    ),
    size,
  );
}
